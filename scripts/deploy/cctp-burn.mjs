// BC-36: USDC'yi bir EVM kaynak zincirinde Solana'ya yakar (CCTP V2). Mint alıcısı, verilen Solana sahibinin
// settlement mint'indeki associated token hesabıdır. Allowance yetmiyorsa önce `approve` gönderilir. Kaynak
// zincir, adresler ve attestation servisi `scripts/deploy/networks/<ağ>.json`'un `cctp` bölümündendir.
// Anahtar dosyası `{ "privateKey": "0x…" }`'tir ve repoda tutulmaz.
//
//   node scripts/deploy/cctp-burn.mjs --network devnet --source sepolia --key <dosya> \
//     --recipient <Solana sahibi> --amount <taban birim> [--finality standard|fast]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { burnArguments, mintRecipientFor, SOLANA_DOMAIN } from './cctp.mjs';
import { loadNetwork } from './network-config.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ERC20 = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const TOKEN_MESSENGER = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

function parseArgs(argv) {
  const args = { finality: 'standard' };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag}: değer yok`);
    const key = {
      '--network': 'network',
      '--source': 'source',
      '--key': 'key',
      '--recipient': 'recipient',
      '--amount': 'amount',
      '--finality': 'finality',
    }[flag];
    if (!key) throw new Error(`bilinmeyen argüman: ${flag}`);
    args[key] = value;
  }
  for (const key of ['network', 'source', 'key', 'recipient', 'amount']) {
    if (!args[key]) throw new Error(`--${key} gerekli`);
  }
  if (!/^[1-9][0-9]*$/.test(args.amount)) throw new Error('--amount: pozitif taban birim tutarı');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = loadNetwork(ROOT, args.network);
  const source = network.cctp?.sources[args.source];
  if (!source) throw new Error(`${args.network} yapılandırmasında ${args.source} CCTP kaynağı yok`);
  const chain = defineChain({
    id: source.chainId,
    name: args.source,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [source.rpc] } },
  });
  const account = privateKeyToAccount(JSON.parse(readFileSync(args.key, 'utf8')).privateKey);
  const reader = createPublicClient({ chain, transport: http(source.rpc) });
  const writer = createWalletClient({ account, chain, transport: http(source.rpc) });
  const amount = BigInt(args.amount);
  const owner = new PublicKey(args.recipient);
  const recipient = mintRecipientFor(owner, new PublicKey(network.escrow.settlementMint));

  const balance = await reader.readContract({
    address: source.usdc,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (balance < amount) throw new Error(`${account.address} bakiyesi ${balance}, gereken ${amount}`);
  const feesResponse = await fetch(
    `${network.cctp.attestationApi}/v2/burn/USDC/fees/${source.domain}/${SOLANA_DOMAIN}`,
  );
  if (!feesResponse.ok) throw new Error(`ücret servisi ${feesResponse.status}`);
  const burn = burnArguments({
    amount,
    finality: args.finality,
    recipient,
    burnToken: source.usdc,
    fees: await feesResponse.json(),
  });

  let approveTx = null;
  const allowance = await reader.readContract({
    address: source.usdc,
    abi: ERC20,
    functionName: 'allowance',
    args: [account.address, source.tokenMessenger],
  });
  if (allowance < amount) {
    approveTx = await writer.writeContract({
      address: source.usdc,
      abi: ERC20,
      functionName: 'approve',
      args: [source.tokenMessenger, amount],
    });
    const receipt = await reader.waitForTransactionReceipt({ hash: approveTx });
    if (receipt.status !== 'success') throw new Error(`approve başarısız: ${approveTx}`);
  }
  const burnTx = await writer.writeContract({
    address: source.tokenMessenger,
    abi: TOKEN_MESSENGER,
    functionName: 'depositForBurn',
    args: [
      burn.amount,
      burn.destinationDomain,
      burn.mintRecipient,
      burn.burnToken,
      burn.destinationCaller,
      burn.maxFee,
      burn.minFinalityThreshold,
    ],
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: burnTx });
  if (receipt.status !== 'success') throw new Error(`depositForBurn başarısız: ${burnTx}`);
  console.log(
    JSON.stringify(
      {
        source: args.source,
        sourceDomain: source.domain,
        from: account.address,
        approveTx,
        burnTx,
        block: receipt.blockNumber.toString(),
        amount: burn.amount.toString(),
        maxFee: burn.maxFee.toString(),
        finality: args.finality,
        recipientOwner: owner.toBase58(),
        mintRecipient: recipient.toBase58(),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
