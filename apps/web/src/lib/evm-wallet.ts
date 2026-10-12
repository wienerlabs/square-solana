// CCTP'nin kaynak zincirindeki cüzdan (FE-19): EIP-1193 sağlayıcısı, EIP-6963 ile keşif. viem'den yalnızca ABI
// kodlayıcısı kullanılır: okuma (`eth_call`), gönderim (`eth_sendTransaction`) ve makbuz cüzdanın kendi RPC'sinden
// gider. Sayfa anahtar tutmaz; tx'i cüzdan imzalar ve gönderir.
import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import type { EvmCall } from '@squaresdk/solana-sdk';
import type { EvmAddress } from './config';

export type Hex = `0x${string}`;

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/** EIP-6963'ün duyurduğu cüzdan: `info` (oturum başına tekil kimlik, ad, simge, ters DNS) ve sağlayıcısı. */
export interface EvmWallet {
  uuid: string;
  name: string;
  /** Cüzdanın kendi verdiği simge (data URI). */
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
}

interface AnnounceDetail {
  info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown };
  provider?: Eip1193Provider;
}

/**
 * EIP-6963: sayfa duyuru ister (`eip6963:requestProvider`), cüzdanlar kendilerini duyurur
 * (`eip6963:announceProvider`). Duyuranlar `uuid`'le tekilleşir; sonradan yüklenen bir cüzdan da listeye girer.
 * Dönen fonksiyon dinlemeyi bırakır.
 */
export function discoverEvmWallets(onChange: (wallets: readonly EvmWallet[]) => void, target: Window = window) {
  const wallets = new Map<string, EvmWallet>();
  const announced = (event: Event) => {
    const detail = (event as CustomEvent<AnnounceDetail>).detail;
    const info = detail?.info;
    const provider = detail?.provider;
    if (!info || typeof provider?.request !== 'function') return;
    const { uuid, name, icon, rdns } = info;
    if (typeof uuid !== 'string' || typeof name !== 'string' || wallets.has(uuid)) return;
    wallets.set(uuid, {
      uuid,
      name,
      icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon : '',
      rdns: typeof rdns === 'string' ? rdns : '',
      provider,
    });
    onChange([...wallets.values()]);
  };
  target.addEventListener('eip6963:announceProvider', announced);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', announced);
}

/** Cüzdanın döndürdüğü EIP-1193 hatası (`code`, `message`). */
export class EvmWalletError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'EvmWalletError';
  }
}

async function request<T>(provider: Eip1193Provider, method: string, params?: readonly unknown[]): Promise<T> {
  try {
    return (await provider.request(params ? { method, params } : { method })) as T;
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    throw new EvmWalletError(
      typeof code === 'number' ? code : null,
      typeof message === 'string' && message !== '' ? message : `${method} failed`,
    );
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const hexChainId = (chainId: number): Hex => `0x${chainId.toString(16)}`;

/** Cüzdandan hesap ister (`eth_requestAccounts`); kullanıcı onaylarsa ilk hesap. */
export async function requestEvmAccount(provider: Eip1193Provider): Promise<EvmAddress> {
  const accounts = await request<unknown[]>(provider, 'eth_requestAccounts');
  const account = accounts?.[0];
  if (typeof account !== 'string' || !EVM_ADDRESS.test(account)) {
    throw new EvmWalletError(null, 'The wallet returned no account.');
  }
  return account as EvmAddress;
}

export async function evmChainIdOf(provider: Eip1193Provider): Promise<number> {
  const value = await request<string>(provider, 'eth_chainId');
  const chainId = typeof value === 'string' ? Number.parseInt(value, 16) : NaN;
  if (!Number.isSafeInteger(chainId)) throw new EvmWalletError(null, `The wallet returned no chain id (${value}).`);
  return chainId;
}

/** Cüzdanı zincire geçirir (`wallet_switchEthereumChain`); cüzdan zinciri tanımıyorsa 4902 döner. */
export async function switchEvmChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  await request(provider, 'wallet_switchEthereumChain', [{ chainId: hexChainId(chainId) }]);
}

type Call = EvmCall<Abi, string, readonly unknown[]>;

/** Çağrının verisi (seçici ve ABI kodlu argümanlar). */
export const evmCalldata = (call: Call): Hex =>
  encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as Parameters<
    typeof encodeFunctionData
  >[0]);

/** Salt okunur çağrı (`eth_call`, son blok); dönen değer ABI'ye göre çözülür. */
export async function readEvmContract<T>(provider: Eip1193Provider, call: Call): Promise<T> {
  const data = await request<Hex>(provider, 'eth_call', [{ to: call.address, data: evmCalldata(call) }, 'latest']);
  return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data } as Parameters<
    typeof decodeFunctionResult
  >[0]) as T;
}

/** Yerel paranın (gas) bakiyesi, wei. */
export async function evmNativeBalance(provider: Eip1193Provider, account: EvmAddress): Promise<bigint> {
  return BigInt(await request<Hex>(provider, 'eth_getBalance', [account, 'latest']));
}

/** Çağrıyı cüzdana imzalatıp gönderir (`eth_sendTransaction`); tx hash'i. Gas'ı cüzdan tahmin eder. */
export async function sendEvmCall(provider: Eip1193Provider, from: EvmAddress, call: Call): Promise<Hex> {
  const hash = await request<string>(provider, 'eth_sendTransaction', [
    { from, to: call.address, data: evmCalldata(call) },
  ]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new EvmWalletError(null, 'The wallet returned no transaction hash.');
  }
  return hash.toLowerCase() as Hex;
}

export type EvmReceipt = { status: 'success' | 'reverted'; blockNumber: bigint };

/** Tx'in makbuzu; henüz bloğa girmediyse null. */
export async function evmReceipt(provider: Eip1193Provider, hash: Hex): Promise<EvmReceipt | null> {
  const receipt = await request<{ status?: string; blockNumber?: string } | null>(
    provider,
    'eth_getTransactionReceipt',
    [hash],
  );
  if (!receipt?.blockNumber) return null;
  return { status: receipt.status === '0x1' ? 'success' : 'reverted', blockNumber: BigInt(receipt.blockNumber) };
}

export const evmTxUrl = (explorerUrl: string, hash: string) => `${explorerUrl}/tx/${hash}`;
export const evmAddressUrl = (explorerUrl: string, address: string) => `${explorerUrl}/address/${address}`;

/** Cüzdan hatasının açıklaması (EIP-1193 ve EIP-3326 kodları). */
export function evmErrorMessage(error: unknown, chainName?: string): string {
  if (error instanceof EvmWalletError) {
    switch (error.code) {
      case 4001:
        return 'The request was rejected in the wallet.';
      case 4100:
        return 'The wallet has not authorized this page; connect it again.';
      case 4902:
        return `The wallet does not know ${chainName ?? 'this chain'}; add the network in the wallet, then switch.`;
      case -32002:
        return 'The wallet already has a request open; finish it in the wallet.';
    }
    return error.message;
  }
  return (error as Error).message;
}
