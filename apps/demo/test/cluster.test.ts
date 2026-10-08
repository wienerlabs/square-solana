import { describe, expect, it } from 'vitest';
import {
  assertSupportedCluster,
  clusterGuardError,
  DEVNET_CHAIN_REF,
  isLoopbackUrl,
  MAINNET_CHAIN_REF,
} from '../src/cluster.js';
import { assertAgentBaseUrl } from '../src/scenario.js';

const DEVNET_GENESIS = `${DEVNET_CHAIN_REF}wcaWoxPkrZBG`;
const MAINNET_GENESIS = `${MAINNET_CHAIN_REF}Kuc147dw2N9d`;
const LOCAL_GENESIS = 'AEPsuqMZhFVgJTS5Pz7k65SyJYiqNrynZ1cdwvHrqbUx';

describe('küme koruması', () => {
  it('mainnet-beta her küme adında reddedilir', () => {
    for (const cluster of ['devnet', 'localnet', 'mainnet-beta', 'demo']) {
      expect(clusterGuardError(cluster, MAINNET_GENESIS)).toMatch(/mainnet-beta.*ADR 0027/);
    }
  });

  it("devnet adı yalnızca devnet'in genesis'iyle geçer; localnet ve diğer adlar serbest", () => {
    expect(clusterGuardError('devnet', DEVNET_GENESIS)).toBeNull();
    expect(clusterGuardError('devnet', LOCAL_GENESIS)).toMatch(/küme "devnet" ama/);
    expect(clusterGuardError('localnet', LOCAL_GENESIS)).toBeNull();
    expect(clusterGuardError('localnet', DEVNET_GENESIS)).toBeNull();
  });

  it("RPC'nin genesis hash'ini okuyup denetler", async () => {
    await expect(assertSupportedCluster({ getGenesisHash: async () => LOCAL_GENESIS }, 'localnet')).resolves.toBe(
      LOCAL_GENESIS,
    );
    await expect(assertSupportedCluster({ getGenesisHash: async () => MAINNET_GENESIS }, 'localnet')).rejects.toThrow(
      /mainnet-beta/,
    );
  });
});

describe('agent adresi', () => {
  it.each([
    ['http://127.0.0.1:8787', true],
    ['http://127.10.0.1:8787/demo', true],
    ['http://localhost:8787', true],
    ['http://[::1]:8787', true],
    ['http://10.0.0.5:8787', false],
    ['http://agent.example.org', false],
    ['http://127.0.0.1.example.org', false],
  ])('%s yerel mi: %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });

  it('http yalnızca yerel adreste, https her yerde kabul edilir', () => {
    expect(assertAgentBaseUrl('https://agent.example.org/demo')).toBe('https://agent.example.org/demo');
    expect(assertAgentBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => assertAgentBaseUrl('http://agent.example.org')).toThrow(/http yalnızca yerel adreste/);
    expect(() => assertAgentBaseUrl('ftp://127.0.0.1')).toThrow(/https olmalı/);
  });
});
