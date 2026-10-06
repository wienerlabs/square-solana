import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeUrl, createSafeFetch, guardedLookup, isPublicAddress, SsrfError } from '../src/ssrf.js';

const STRICT = { allowHttp: false, allowPrivateAddresses: false };

describe('isPublicAddress', () => {
  it('özel, döngü, yerel bağlantı, ayrılmış ve çoklu yayın adreslerini reddeder', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      'adres-değil',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('assertSafeUrl', () => {
  it('şema, kullanıcı bilgisi ve IP literal denetlenir', () => {
    const reason = (url: string, policy = STRICT) => {
      try {
        assertSafeUrl(url, policy);
        return 'tamam';
      } catch (error) {
        return (error as SsrfError).reason;
      }
    };
    expect(reason('https://cards.example.org/agent.json')).toBe('tamam');
    expect(reason('http://cards.example.org/agent.json')).toBe('scheme');
    expect(reason('http://cards.example.org/', { ...STRICT, allowHttp: true })).toBe('tamam');
    expect(reason('file:///etc/passwd')).toBe('scheme');
    expect(reason('https://user:pw@cards.example.org/')).toBe('credentials');
    expect(reason('https://169.254.169.254/latest/meta-data')).toBe('private_address');
    expect(reason('https://[::1]/')).toBe('private_address');
    expect(reason('https://[::ffff:127.0.0.1]/')).toBe('private_address');
    expect(reason('https://8.8.8.8/')).toBe('tamam');
    expect(reason('bozuk adres')).toBe('invalid_url');
  });
});

describe('guardedLookup', () => {
  const resolveTo =
    (...addresses: string[]) =>
    (
      _host: string,
      _opts: { all: true },
      cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void,
    ) =>
      cb(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
  const run = (lookup: ReturnType<typeof guardedLookup>, all = false) =>
    new Promise<unknown>((resolve) => lookup('host.example', { all }, (error, address) => resolve(error ?? address)));

  it('çözülen adreslerden biri bile özelse bağlanmaz; bağlanılan adres denetlenendir', async () => {
    expect(await run(guardedLookup(STRICT, resolveTo('93.184.215.14')))).toBe('93.184.215.14');
    expect(await run(guardedLookup(STRICT, resolveTo('93.184.215.14', '10.0.0.5')))).toBeInstanceOf(SsrfError);
    expect(await run(guardedLookup(STRICT, resolveTo('::ffff:169.254.169.254')))).toBeInstanceOf(SsrfError);
    expect(await run(guardedLookup({ ...STRICT, allowPrivateAddresses: true }, resolveTo('127.0.0.1')))).toBe(
      '127.0.0.1',
    );
    expect(await run(guardedLookup(STRICT, resolveTo('93.184.215.14', '2606:4700::1')), true)).toHaveLength(2);
    const failing = guardedLookup(STRICT, (_h, _o, cb) =>
      cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []),
    );
    expect(await run(failing)).toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('createSafeFetch', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://local');
      if (url.pathname === '/card') return void res.end(JSON.stringify({ name: 'agent' }));
      if (url.pathname === '/big') return void res.end('x'.repeat(2048));
      if (url.pathname === '/stream') {
        res.write('x'.repeat(600));
        return void setTimeout(() => res.end('x'.repeat(600)), 10);
      }
      if (url.pathname === '/redirect') return void res.writeHead(302, { location: '/card' }).end();
      if (url.pathname === '/post-redirect') return void res.writeHead(303, { location: '/echo-method' }).end();
      if (url.pathname === '/echo-method') return void res.end(req.method);
      if (url.pathname === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (url.pathname === '/to-credentials') {
        return void res.writeHead(302, { location: `http://user:pw@127.0.0.1:${url.port}/card` }).end();
      }
      if (url.pathname === '/slow') return void setTimeout(() => res.end('late'), 500);
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const internal = { allowHttp: true, allowPrivateAddresses: true, timeoutMs: 2000, maxBytes: 1024, maxRedirects: 2 };

  it('özel adrese çözülen ad bağlanmadan reddedilir', async () => {
    const strict = createSafeFetch({
      ...internal,
      allowPrivateAddresses: false,
      lookup: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const port = new URL(origin).port;
    await expect(strict(`http://cards.example.org:${port}/card`)).rejects.toMatchObject({ reason: 'private_address' });
    await expect(strict(`${origin}/card`)).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('yanıtı okur, yönlendirmeyi her adımda denetler, boyutu ve süreyi sınırlar', async () => {
    const safeFetch = createSafeFetch(internal);
    const card = await safeFetch(`${origin}/card`);
    expect(card.status).toBe(200);
    expect(JSON.parse(Buffer.from(card.body).toString())).toEqual({ name: 'agent' });
    expect((await safeFetch(`${origin}/redirect`)).url).toBe(`${origin}/card`);
    expect(
      Buffer.from((await safeFetch(`${origin}/post-redirect`, { method: 'POST', body: 'x' })).body).toString(),
    ).toBe('GET');
    await expect(safeFetch(`${origin}/loop`)).rejects.toMatchObject({ reason: 'too_many_redirects' });
    await expect(safeFetch(`${origin}/to-credentials`)).rejects.toMatchObject({ reason: 'credentials' });
    await expect(safeFetch(`${origin}/big`)).rejects.toMatchObject({ reason: 'too_large' });
    await expect(safeFetch(`${origin}/stream`)).rejects.toMatchObject({ reason: 'too_large' });
    const quick = createSafeFetch({ ...internal, timeoutMs: 100 });
    await expect(quick(`${origin}/slow`)).rejects.toMatchObject({ reason: 'timeout' });
    expect((await safeFetch(`${origin}/yok`)).status).toBe(404);
    expect(() => createSafeFetch({ ...internal, maxBytes: 0 })).toThrow(/maxBytes/);
  });
});
