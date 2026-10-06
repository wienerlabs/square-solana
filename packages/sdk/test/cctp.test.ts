// CCTP V2 ile fonlama (BC-36): mesajın çözümü, Circle'ın PDA türetmeleri ve `receive_message` talimatı. PDA
// beklentileri devnet'te Circle'ın programlarında bulunan hesaplardır (2026-10-06'da `getAccountInfo` ile
// okundu); talimatın discriminator'ı Circle'ın `message_transmitter_v2` IDL'indeki değerdir.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CCTP_SOLANA_DOMAIN,
  cctpLookupTableAddresses,
  cctpMintedAmount,
  cctpStaticAccounts,
  decodeCctpMessage,
  RECEIVE_MESSAGE_DISCRIMINATOR,
  receiveMessageInstruction,
  type CctpReceiveContext,
} from '../src/cctp.js';

const programs = {
  messageTransmitter: new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'),
  tokenMessengerMinter: new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'),
};
const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
/** Ethereum Sepolia USDC, 32 bayta sola sıfırla. */
const sepoliaUsdc = Buffer.concat([Buffer.alloc(12), Buffer.from('1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'hex')]);
const feeRecipient = new PublicKey('AYG63YgrKLbp9B23ntcRemU8kSD7rZ7cNFGDo8DbEfTd');
const context: CctpReceiveContext = {
  programs,
  usdcMint,
  sourceDomain: 0,
  burnToken: sepoliaUsdc,
  feeRecipient,
  tokenProgram: TOKEN_PROGRAM_ID,
};

/** `MessageV2` + `BurnMessageV2` (büyük uçlu); test fikstürü. */
function message(fields: {
  sourceDomain?: number;
  destinationDomain?: number;
  burnToken?: Buffer;
  recipient: PublicKey;
  amount: bigint;
  feeExecuted: bigint;
  nonce: Buffer;
}) {
  const u32 = (value: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value);
    return out;
  };
  const u256 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
  const header = Buffer.concat([
    u32(1),
    u32(fields.sourceDomain ?? 0),
    u32(fields.destinationDomain ?? CCTP_SOLANA_DOMAIN),
    fields.nonce,
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(32),
    u32(2000),
    u32(2000),
  ]);
  const body = Buffer.concat([
    u32(1),
    fields.burnToken ?? sepoliaUsdc,
    fields.recipient.toBuffer(),
    u256(fields.amount),
    Buffer.alloc(32, 3),
    u256(0n),
    u256(fields.feeExecuted),
    u256(12_345_678n),
  ]);
  return new Uint8Array(Buffer.concat([header, body]));
}

describe('decodeCctpMessage', () => {
  it('başlık ve yakma gövdesi; mint edilen yakılan eksi ücret', () => {
    const recipient = Keypair.generate().publicKey;
    const nonce = Buffer.alloc(32, 9);
    const decoded = decodeCctpMessage(message({ recipient, amount: 5_000_000n, feeExecuted: 500n, nonce }));
    expect(decoded).toMatchObject({
      version: 1,
      sourceDomain: 0,
      destinationDomain: CCTP_SOLANA_DOMAIN,
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
      burn: { version: 1, amount: 5_000_000n, feeExecuted: 500n, maxFee: 0n, expirationBlock: 12_345_678n },
    });
    expect(Buffer.from(decoded.nonce)).toEqual(nonce);
    expect(Buffer.from(decoded.burn.burnToken)).toEqual(sepoliaUsdc);
    expect(decoded.burn.mintRecipient.equals(recipient)).toBe(true);
    expect(cctpMintedAmount(decoded)).toBe(4_999_500n);
    expect(() => decodeCctpMessage(new Uint8Array(147))).toThrow(/kısa/);
  });
});

describe('Circle PDA’ları', () => {
  it('devnet’teki CCTP V2 hesaplarıyla aynı', () => {
    const accounts = cctpStaticAccounts(context);
    expect(Object.fromEntries(Object.entries(accounts).map(([name, key]) => [name, key.toBase58()]))).toMatchObject({
      messageTransmitterState: 'W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU',
      tokenMessenger: 'AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W',
      remoteTokenMessenger: '3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9',
      tokenMinter: 'E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux',
      localToken: '7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU',
      tokenPair: 'AR6mnr7XRVDUvK7SDGKpREBwGQMxZbKRsY22gXN8bvQU',
      custody: 'CFUgYpbas5UdJkwwSobYgzhFqFuj6C8MfXwBetE3o4SY',
      feeRecipientTokenAccount: getAssociatedTokenAddressSync(usdcMint, feeRecipient, true).toBase58(),
    });
    const alt = cctpLookupTableAddresses(context);
    expect(alt).toHaveLength(13);
    expect(new Set(alt.map((key) => key.toBase58())).size).toBe(13);
  });
});

describe('receiveMessageInstruction', () => {
  const payer = Keypair.generate().publicKey;
  const caller = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const nonce = Buffer.alloc(32, 7);

  it('Circle’ın discriminator’ı, borsh verisi ve hesap sırası', () => {
    const bytes = message({ recipient, amount: 5_000_000n, feeExecuted: 0n, nonce });
    const attestation = new Uint8Array(65).fill(4);
    const ix = receiveMessageInstruction({ context, message: bytes, attestation, payer, caller });
    expect([...RECEIVE_MESSAGE_DISCRIMINATOR]).toEqual([38, 144, 127, 225, 31, 225, 238, 25]);
    expect(ix.programId.equals(programs.messageTransmitter)).toBe(true);
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(RECEIVE_MESSAGE_DISCRIMINATOR));
    expect(ix.data.readUInt32LE(8)).toBe(bytes.length);
    expect(ix.data.subarray(12, 12 + bytes.length)).toEqual(Buffer.from(bytes));
    expect(ix.data.readUInt32LE(12 + bytes.length)).toBe(65);
    expect(ix.data.length).toBe(8 + 4 + bytes.length + 4 + 65);

    const accounts = cctpStaticAccounts(context);
    const usedNonce = PublicKey.findProgramAddressSync(
      [Buffer.from('used_nonce'), nonce],
      programs.messageTransmitter,
    )[0];
    expect(ix.keys.map((key) => [key.pubkey.toBase58(), key.isWritable, key.isSigner])).toEqual(
      [
        [payer, true, true],
        [caller, false, true],
        [accounts.authorityPda, false, false],
        [accounts.messageTransmitterState, false, false],
        [usedNonce, true, false],
        [programs.tokenMessengerMinter, false, false],
        [SystemProgram.programId, false, false],
        [accounts.messageTransmitterEventAuthority, false, false],
        [programs.messageTransmitter, false, false],
        [accounts.tokenMessenger, false, false],
        [accounts.remoteTokenMessenger, false, false],
        [accounts.tokenMinter, true, false],
        [accounts.localToken, true, false],
        [accounts.tokenPair, false, false],
        [accounts.feeRecipientTokenAccount, true, false],
        [recipient, true, false],
        [accounts.custody, true, false],
        [TOKEN_PROGRAM_ID, false, false],
        [accounts.tokenMessengerEventAuthority, false, false],
        [programs.tokenMessengerMinter, false, false],
      ].map(([key, writable, signer]) => [(key as PublicKey).toBase58(), writable, signer]),
    );
  });

  it('başka hedefe, başka kaynağa ya da başka token’a giden mesaj reddedilir', () => {
    const build = (change: Parameters<typeof message>[0]) =>
      receiveMessageInstruction({ context, message: message(change), attestation: new Uint8Array(65), payer, caller });
    const base = { recipient, amount: 1n, feeExecuted: 0n, nonce };
    expect(() => build({ ...base, destinationDomain: 6 })).toThrow(/Solana için değil/);
    expect(() => build({ ...base, sourceDomain: 3 })).toThrow(/kaynak domain/);
    expect(() => build({ ...base, burnToken: Buffer.alloc(32, 5) })).toThrow(/token/);
  });
});

describe('gerçek bir attestation’lı mesaj', () => {
  // Bu PR'ın devnet koşusundaki burn'ün Circle tarafından imzalanmış mesajı ve Circle'ın kendi çözümü.
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/cctp-sepolia-to-solana.json', import.meta.url)), 'utf8'),
  ) as {
    message: string;
    attestation: string;
    decodedMessage: {
      sourceDomain: string;
      destinationDomain: string;
      nonce: string;
      minFinalityThreshold: string;
      finalityThresholdExecuted: string;
      decodedMessageBody: {
        burnToken: string;
        mintRecipient: string;
        amount: string;
        maxFee: string;
        feeExecuted: string;
      };
    };
  };
  const hexBytes = (value: string) => new Uint8Array(Buffer.from(value.replace(/^0x/, ''), 'hex'));

  it('Circle’ın çözümüyle alan alan aynı', () => {
    const decoded = decodeCctpMessage(hexBytes(fixture.message));
    const circle = fixture.decodedMessage;
    expect({
      sourceDomain: String(decoded.sourceDomain),
      destinationDomain: String(decoded.destinationDomain),
      nonce: `0x${Buffer.from(decoded.nonce).toString('hex')}`,
      minFinalityThreshold: String(decoded.minFinalityThreshold),
      finalityThresholdExecuted: String(decoded.finalityThresholdExecuted),
      burnToken: `0x${Buffer.from(decoded.burn.burnToken.subarray(12)).toString('hex')}`,
      mintRecipient: decoded.burn.mintRecipient.toBase58(),
      amount: String(decoded.burn.amount),
      maxFee: String(decoded.burn.maxFee),
      feeExecuted: String(decoded.burn.feeExecuted),
    }).toEqual({
      sourceDomain: circle.sourceDomain,
      destinationDomain: circle.destinationDomain,
      nonce: circle.nonce,
      minFinalityThreshold: circle.minFinalityThreshold,
      finalityThresholdExecuted: circle.finalityThresholdExecuted,
      burnToken: circle.decodedMessageBody.burnToken,
      mintRecipient: circle.decodedMessageBody.mintRecipient,
      amount: circle.decodedMessageBody.amount,
      maxFee: circle.decodedMessageBody.maxFee,
      feeExecuted: circle.decodedMessageBody.feeExecuted,
    });
    expect(cctpMintedAmount(decoded)).toBe(5_000_000n);
    // İki attester imzası (65'er bayt).
    expect(hexBytes(fixture.attestation)).toHaveLength(130);
  });
});
