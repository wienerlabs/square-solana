// BC-36: CCTP ile fonlamanın devnet koşusu. Kaynak zincirde yakılmış (`cctp-burn.mjs`) USDC'nin attestation'ı
// beklenir, sonra Solana'da tek tx'te mint edilip bir job'u fonlar (`flow.receiveAndFundJob`).
// Fonlama için gerekenler hazırlanır:
// - **Agent:** SOL'ü yoksa kurumdan aktarılır, kaydı yoksa kaydedilir (kartsız).
// - **Screening:** Kurum ve agent cüzdanları OFAC SDN listesine karşı taranır; listede değillerse screener
//   authority `record_screening` ile temiz kaydeder. Kaynak hash'i listenin SHA-256'sıdır.
// - **Job:** Mint edilen tutarla açılır (ya da `--job` ile var olanı kullanılır).
// Çıktı, deploy kaydına (`docs/deploy/devnet.md`) yazılacak imzalar ve değerlerdir.
//
//   node scripts/deploy/cctp-fund-job.mjs --network devnet --source sepolia --burn-tx <0x…> \
//     --institution <keypair> --agent <keypair> --screener <keypair> [--job <adres>]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cctpMintedAmount, createSquareClient, decodeCctpMessage, fetchCctpFeeRecipient } from '@squaresdk/solana-sdk';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { fetchAttestation, mintRecipientFor } from './cctp.mjs';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** OFAC'ın SDN listesi (XML; dijital para adresleri `Digital Currency Address - …` kimlikleri olarak). */
const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml';
/** Agent'ın bu koşudaki kaydı: kimliği ve rent / ücret için en az SOL'ü. */
const AGENT_ID = 'bc36-cctp-devnet';
const AGENT_MIN_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
/** Job'un teslim süresi. */
const DEADLINE_SECONDS = 7 * 86_400;
const ATTESTATION_POLL_MS = 15_000;
const ATTESTATION_TIMEOUT_MS = 60 * 60_000;

const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
const hexBytes = (value) => new Uint8Array(Buffer.from(value.replace(/^0x/, ''), 'hex'));

function parseArgs(argv) {
  const names = {
    '--network': 'network',
    '--source': 'source',
    '--burn-tx': 'burnTx',
    '--institution': 'institution',
    '--agent': 'agent',
    '--screener': 'screener',
    '--job': 'job',
  };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`argüman: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  for (const key of ['network', 'source', 'burnTx', 'institution', 'agent', 'screener']) {
    if (!args[key]) throw new Error(`--${key} gerekli`);
  }
  return args;
}

async function sendBuilt(connection, built, signers) {
  built.transaction.sign(signers);
  const signature = await connection.sendRawTransaction(built.transaction.serialize());
  const result = await connection.confirmTransaction(
    { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) throw new Error(`${signature}: ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function sendInstructions(connection, payer, instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions });
  return sendBuilt(
    connection,
    { transaction: new VersionedTransaction(message.compileToV0Message()), blockhash, lastValidBlockHeight },
    signers,
  );
}

async function waitForAttestation(network, source, transactionHash) {
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;
  for (;;) {
    const attested = await fetchAttestation({
      api: network.cctp.attestationApi,
      sourceDomain: source.domain,
      transactionHash,
    });
    if (attested) return attested;
    if (Date.now() > deadline) throw new Error(`attestation gelmedi: ${transactionHash}`);
    await new Promise((resolve) => setTimeout(resolve, ATTESTATION_POLL_MS));
  }
}

/** Cüzdanlar OFAC SDN listesine karşı: listede adresi geçen cüzdan temiz kaydedilmez. */
async function screenAgainstSdn(wallets) {
  const response = await fetch(OFAC_SDN_URL);
  if (!response.ok) throw new Error(`OFAC SDN listesi ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  const listed = wallets.filter((wallet) => text.includes(wallet.toBase58()));
  if (listed.length > 0) throw new Error(`OFAC SDN listesinde: ${listed.map((key) => key.toBase58()).join(', ')}`);
  return {
    sourceHash: createHash('sha256').update(bytes).digest(),
    publishDate: /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(text)?.[1] ?? null,
    recordCount: Number(/<Record_Count>(\d+)<\/Record_Count>/.exec(text)?.[1] ?? Number.NaN),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = loadNetwork(ROOT, args.network);
  const source = network.cctp?.sources[args.source];
  if (!source?.lookupTable || !network.lookupTable) {
    throw new Error("ağ yapılandırmasında Square ALT ve bu kaynağın CCTP ALT'ı olmalı (create-lookup-table.mjs)");
  }
  const connection = connectionFor(network.rpc);
  const programIds = Object.fromEntries(
    Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
  );
  const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
  const [institution, agent, screener] = [args.institution, args.agent, args.screener].map(keypair);
  const usdcMint = new PublicKey(network.escrow.settlementMint);
  const result = {
    burnTx: args.burnTx,
    institution: institution.publicKey.toBase58(),
    agent: agent.publicKey.toBase58(),
  };

  // 1. Attestation ve mesaj.
  const attested = await waitForAttestation(network, source, args.burnTx);
  const message = hexBytes(attested.message);
  const decoded = decodeCctpMessage(message);
  const minted = cctpMintedAmount(decoded);
  if (!decoded.burn.mintRecipient.equals(mintRecipientFor(institution.publicKey, usdcMint))) {
    throw new Error(`mesajın mint alıcısı kurumun USDC hesabı değil: ${decoded.burn.mintRecipient.toBase58()}`);
  }
  Object.assign(result, {
    eventNonce: attested.eventNonce,
    minted: minted.toString(),
    feeExecuted: decoded.burn.feeExecuted.toString(),
  });

  // 2. Agent: SOL ve kayıt.
  if ((await connection.getBalance(agent.publicKey)) < AGENT_MIN_LAMPORTS) {
    result.agentFunding = await sendInstructions(
      connection,
      institution,
      [
        SystemProgram.transfer({
          fromPubkey: institution.publicKey,
          toPubkey: agent.publicKey,
          lamports: AGENT_MIN_LAMPORTS,
        }),
      ],
      [institution],
    );
  }
  const agentRecord = client.pda.agentRecord(agent.publicKey, AGENT_ID)[0];
  if (!(await client.registry.fetch('agentRecord', agentRecord))) {
    const built = await client.flow.registerAgent(
      {
        owner: agent.publicKey,
        agentId: AGENT_ID,
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: agent.publicKey,
      },
      { feePayer: agent.publicKey },
    );
    result.registerAgent = await sendBuilt(connection, built, [agent]);
  }
  result.agentRecord = agentRecord.toBase58();

  // 3. Screening: OFAC SDN'e karşı; temiz ve süresi dolmamış kayıt varsa yeniden yazılmaz.
  const now = Math.floor(Date.now() / 1000);
  const wallets = [institution.publicKey, agent.publicKey];
  const fresh = await Promise.all(
    wallets.map(async (wallet) => {
      const record = await client.registry.fetch('screeningRecord', client.pda.screeningRecord(wallet)[0]);
      return record !== null && 'clear' in record.status && record.expiresAt.toNumber() > now;
    }),
  );
  if (fresh.includes(false)) {
    const sdn = await screenAgainstSdn(wallets);
    result.screening = {
      list: OFAC_SDN_URL,
      publishDate: sdn.publishDate,
      recordCount: sdn.recordCount,
      sourceHash: sdn.sourceHash.toString('hex'),
      records: {},
    };
    for (const [index, wallet] of wallets.entries()) {
      if (fresh[index]) continue;
      const ix = await client.registry.instructions.recordScreening(
        [wallet, { clear: {} }, Array.from(sdn.sourceHash)],
        {
          payer: institution.publicKey,
          screenerAuthority: screener.publicKey,
          config: client.pda.registryConfig()[0],
          screeningRecord: client.pda.screeningRecord(wallet)[0],
        },
      );
      result.screening.records[wallet.toBase58()] = await sendInstructions(
        connection,
        institution,
        [ix],
        [institution, screener],
      );
    }
  }

  // 4. Job: mint edilen tutarla.
  let job;
  if (args.job) {
    job = new PublicKey(args.job);
  } else {
    const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
    const built = await client.flow.createJob(
      {
        institution: institution.publicKey,
        agentRecord,
        spec: {
          title: 'BC-36 CCTP devnet funding',
          description: 'USDC burned on Ethereum Sepolia, minted on Solana devnet and escrowed in the same transaction.',
          burnTx: args.burnTx,
        },
        amount: minted,
        deadline: now + DEADLINE_SECONDS,
        challengePeriod: BigInt(config.params.minChallengePeriod.toString()),
      },
      { feePayer: institution.publicKey },
    );
    result.createJob = await sendBuilt(connection, built, [institution]);
    job = built.job;
  }
  result.job = job.toBase58();

  // 5. Mint + fonlama, tek tx (iki ALT).
  const programs = {
    messageTransmitter: new PublicKey(network.cctp.messageTransmitter),
    tokenMessengerMinter: new PublicKey(network.cctp.tokenMessengerMinter),
  };
  const built = await client.flow.receiveAndFundJob(
    {
      cctp: {
        programs,
        usdcMint,
        sourceDomain: source.domain,
        burnToken: Buffer.concat([Buffer.alloc(12), Buffer.from(source.usdc.slice(2), 'hex')]),
        feeRecipient: await fetchCctpFeeRecipient(connection, programs),
      },
      message,
      attestation: hexBytes(attested.attestation),
      institution: institution.publicKey,
      job,
    },
    {
      feePayer: institution.publicKey,
      addressLookupTables: [new PublicKey(network.lookupTable), new PublicKey(source.lookupTable)],
    },
  );
  const size = built.transaction.serialize().length;
  const simulation = await connection.simulateTransaction(built.transaction, { sigVerify: false });
  if (simulation.value.err)
    throw new Error(`simülasyon: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join('\n')}`);
  result.receiveAndFund = {
    signature: await sendBuilt(connection, built, [institution]),
    bytes: size,
    simulatedUnits: simulation.value.unitsConsumed,
  };

  // 6. Doğrulama: job fonlandı, vault'ta tutar var.
  const account = await client.escrow.fetch('job', job);
  const vault = await connection.getTokenAccountBalance(client.pda.vault(job)[0]);
  if (!account || !('funded' in account.status) || BigInt(vault.value.amount) !== BigInt(account.amount.toString())) {
    throw new Error(`job fonlanmadı: durum ${JSON.stringify(account?.status)}, vault ${vault.value.amount}`);
  }
  Object.assign(result, {
    jobStatus: 'funded',
    vault: client.pda.vault(job)[0].toBase58(),
    vaultAmount: vault.value.amount,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
