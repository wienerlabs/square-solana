// SDN listesinin okunması ve cüzdanların eşleştirilmesi. Fikstür, OFAC'ın SDN XML'inin biçiminde küçük bir
// listedir (iki kişi kaydı; adres gerçek listeden alınmıştır).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OFAC_SDN_URL, fetchSdn, parseSdn, screen } from './sanctions.mjs';

const XML = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://www.treasury.gov/ofac/DeltaFile/1.0">
  <publshInformation><Publish_Date>10/02/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry><uid>1</uid><idList>
    <id><uid>10</uid><idType>Passport</idType><idNumber>X123</idNumber></id>
    <id><uid>11</uid><idType>Digital Currency Address - SOL</idType><idNumber>42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi</idNumber></id>
  </idList></sdnEntry>
  <sdnEntry><uid>2</uid><idList>
    <id><uid>20</uid><idType>Digital Currency Address - USDT</idType><idNumber>TXyz</idNumber></id>
  </idList></sdnEntry>
</sdnList>`;

test('yayın bilgisi, hash ve bütün dijital para adresleri', () => {
  const list = parseSdn(Buffer.from(XML));
  assert.equal(list.publishDate, '10/02/2026');
  assert.equal(list.recordCount, 2);
  assert.deepEqual(list.sourceHash, createHash('sha256').update(XML).digest());
  assert.deepEqual(
    [...list.addresses],
    [
      ['42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi', 'Digital Currency Address - SOL'],
      ['TXyz', 'Digital Currency Address - USDT'],
    ],
  );
  assert.throws(() => parseSdn(Buffer.from('<html/>')), /SDN listesi değil/);
});

test('listedeki cüzdan flagged, diğerleri clear; adres tam eşleşir', () => {
  const list = parseSdn(Buffer.from(XML));
  const clean = '7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4';
  assert.deepEqual(screen(list, [clean, '42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi', 'TXy']), {
    clear: [clean, 'TXy'],
    flagged: ['42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi'],
  });
});

test('liste OFAC adresinden indirilir; hata durumu fırlatılır', async () => {
  const asked = [];
  const ok = async (url) => (asked.push(url), new Response(XML));
  assert.equal((await fetchSdn(ok)).recordCount, 2);
  assert.deepEqual(asked, [OFAC_SDN_URL]);
  await assert.rejects(
    fetchSdn(async () => new Response('', { status: 503 })),
    /503/,
  );
});

test('record-screening argümanları: cüzdan adres olmalı, dry-run anahtarsız', async () => {
  const { parseArgs } = await import('./record-screening.mjs');
  const wallet = '7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4';
  assert.deepEqual(parseArgs(['--network', 'devnet', '--wallet', wallet, '--dry-run']), {
    network: 'devnet',
    wallets: [wallet],
    dryRun: true,
  });
  assert.throws(() => parseArgs(['--network', 'devnet', '--wallet', wallet]), /--screener ve --payer/);
  assert.throws(() => parseArgs(['--network', 'devnet']), /en az bir --wallet/);
  assert.throws(() => parseArgs(['--wallet', 'nope']), /Invalid public key|Non-base58/);
  assert.throws(() => parseArgs(['--network']), /değer yok/);
  assert.throws(() => parseArgs(['--x', '1']), /bilinmeyen/);
});
