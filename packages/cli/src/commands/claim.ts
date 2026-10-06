// Adım 5: alacak piyasası. Agent teslim edilmiş işin alacağını listeler; kurumun onaylı listesindeki alıcı
// (`policy buyers`'ın yazdığı dosyadaki salt ve Merkle kanıtıyla) satın alır (ADR 0014).
import { PublicKey } from '@solana/web3.js';
import { buildBuyerTree, getBuyerProof } from '@squaresdk/solana-policy';
import { z } from 'zod';
import { address, amount, CliError, readJson, required } from '../io.js';
import { fetchJob, tokenAccount } from './job.js';
import { str, type Command } from './types.js';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);
/** `policy buyers`'ın yazdığı liste dosyası. */
export const BuyersFileSchema = z
  .object({
    policy: z.string(),
    root: Hex32,
    buyers: z.array(z.object({ buyer: z.string(), leafSalt: Hex32 }).strict()).min(1),
  })
  .strict();

const bytes = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

/** Alıcının kanıtı: listede yoksa ya da dosyanın kökü zincirdekinden farklıysa hata. */
export function buyerProof(file: unknown, buyer: PublicKey, onChainRoot: Uint8Array) {
  const parsed = BuyersFileSchema.safeParse(file);
  if (!parsed.success) throw new CliError('alıcı listesi dosyası geçersiz (policy buyers biçimi)');
  const tree = buildBuyerTree(
    parsed.data.buyers.map((e) => ({ buyer: new PublicKey(e.buyer), leafSalt: bytes(e.leafSalt) })),
  );
  if (Buffer.compare(Buffer.from(tree.root), Buffer.from(onChainRoot)) !== 0) {
    throw new CliError('liste dosyasının kökü politikanın zincirdeki alıcı köküyle aynı değil');
  }
  try {
    return getBuyerProof(tree, buyer);
  } catch {
    throw new CliError(`alıcı listede değil: ${buyer.toBase58()}`);
  }
}

const list: Command = {
  group: 'claim',
  action: 'list',
  summary: "adım 5: alacağı yüz değerin altında listeler (imzacı job'un agent cüzdanı)",
  usage: [
    ['--job <adres>', 'teslim edilmiş job'],
    ['--price <taban birim>', '0 < fiyat < tutar'],
  ],
  options: { job: { type: 'string' }, price: { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const price = amount(str(values, 'price'), 'price');
    const { signature } = await ctx.send('list_claim', () =>
      ctx.client.flow.listClaim({ agent: ctx.signer.publicKey, job, price }, ctx.options()),
    );
    return { signature, job, claimListing: ctx.client.pda.claimListing(job)[0], price };
  },
};

const buy: Command = {
  group: 'claim',
  action: 'buy',
  summary: 'adım 5: alacağı satın alır; payee alıcı olur (imzacı alıcı)',
  usage: [
    ['--job', '<adres>'],
    ['--price <taban birim>', 'listeleme fiyatı (önden koşmaya karşı aynı olmalı)'],
    ['--buyers <yol>', 'policy buyers dosyası; politikasız ya da kısıtsız işte verilmez'],
  ],
  options: { job: { type: 'string' }, price: { type: 'string' }, buyers: { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const price = amount(str(values, 'price'), 'price');
    const account = await fetchJob(ctx, job);
    const buyer = ctx.signer.publicKey;
    let leafSalt: Uint8Array = new Uint8Array(32);
    let merkleProof: Uint8Array[] = [];
    if (account.policy) {
      const policy = await ctx.client.policy.fetch('policy', account.policy);
      if (!policy) throw new CliError(`politika bulunamadı: ${account.policy.toBase58()}`);
      const root = Uint8Array.from(policy.buyerRoot);
      if (root.some((b) => b !== 0)) {
        ({ leafSalt, merkleProof } = buyerProof(
          readJson(required(str(values, 'buyers'), 'buyers'), 'alıcı listesi'),
          buyer,
          root,
        ));
      }
    }
    const { ata } = await tokenAccount(ctx, buyer, account.mint);
    const { signature } = await ctx.send('buy_claim', () =>
      ctx.client.flow.buyClaim({ buyer, job, price, leafSalt, merkleProof, buyerTokenAccount: ata }, ctx.options()),
    );
    return { signature, job, buyer, price };
  },
};

const cancel: Command = {
  group: 'claim',
  action: 'cancel',
  summary: 'satılmamış listelemeyi geri çeker (imzacı satıcı)',
  usage: [['--job <adres>', 'listelenmiş job']],
  options: { job: { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const { signature } = await ctx.send('cancel_claim', () =>
      ctx.client.flow.cancelClaim({ seller: ctx.signer.publicKey, job }, ctx.options()),
    );
    return { signature, job };
  },
};

export const CLAIM_COMMANDS: readonly Command[] = [list, buy, cancel];
