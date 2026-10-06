// CCTP yapılandırması: üç değişken birlikte, ALT listesi `domain:adres`.
import { describe, expect, it } from 'vitest';
import { parseCctpSettings } from '../src/config.js';

const names = {
  messageTransmitter: 'X_CCTP_MESSAGE_TRANSMITTER',
  tokenMessengerMinter: 'X_CCTP_TOKEN_MESSENGER_MINTER',
  lookupTables: 'X_CCTP_LOOKUP_TABLES',
};
const MT = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
const TMM = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const ALT = '2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY';

describe('parseCctpSettings', () => {
  it('hiçbiri verilmezse kapalı; üçü verilirse programlar ve domain başına ALT', () => {
    expect(
      parseCctpSettings({ messageTransmitter: undefined, tokenMessengerMinter: ' ', lookupTables: '' }, names),
    ).toEqual({ ok: true, settings: null });
    const result = parseCctpSettings(
      { messageTransmitter: MT, tokenMessengerMinter: TMM, lookupTables: ` 0:${ALT}, 6:${MT} ` },
      names,
    );
    if (!result.ok || !result.settings) throw new Error('ayrıştırılamadı');
    expect(result.settings.programs.messageTransmitter.toBase58()).toBe(MT);
    expect([...result.settings.lookupTables].map(([domain, table]) => [domain, table.toBase58()])).toEqual([
      [0, ALT],
      [6, MT],
    ]);
  });

  it('eksik değişken, bozuk adres, bozuk çift, tekrar eden domain ve boş liste reddedilir', () => {
    const problems = (input: Parameters<typeof parseCctpSettings>[0]) => {
      const result = parseCctpSettings(input, names);
      return result.ok ? [] : result.problems;
    };
    expect(problems({ messageTransmitter: MT, tokenMessengerMinter: undefined, lookupTables: `0:${ALT}` })).toEqual([
      'X_CCTP_TOKEN_MESSENGER_MINTER: CCTP değişkenleri birlikte verilir',
    ]);
    expect(problems({ messageTransmitter: 'x', tokenMessengerMinter: TMM, lookupTables: `0:${ALT}` })).toEqual([
      'X_CCTP_MESSAGE_TRANSMITTER: base58 adres bekleniyor',
    ]);
    expect(
      problems({
        messageTransmitter: MT,
        tokenMessengerMinter: TMM,
        lookupTables: `zero:${ALT},0:${ALT},0:${ALT},5:bad`,
      }),
    ).toEqual([
      `X_CCTP_LOOKUP_TABLES: "zero:${ALT}" domain:adres değil`,
      'X_CCTP_LOOKUP_TABLES: domain 0 iki kez verildi',
      'X_CCTP_LOOKUP_TABLES (domain 5): base58 adres bekleniyor',
    ]);
    expect(problems({ messageTransmitter: MT, tokenMessengerMinter: TMM, lookupTables: ',' })).toEqual([
      'X_CCTP_LOOKUP_TABLES: en az bir kaynak gerekli',
    ]);
    expect(
      problems({ messageTransmitter: MT, tokenMessengerMinter: TMM, lookupTables: `4294967296:${ALT}` }),
    ).toHaveLength(1);
  });
});
