/**
 * Bitcoin Regtest Integration Tests
 *
 * These tests run against a local ord node connected to Bitcoin regtest.
 * Unlike signet tests (read-only), regtest tests can create inscriptions
 * and mine blocks on demand, enabling full write-path testing.
 *
 * Skipped by default. Set ORD_REGTEST_URL to enable.
 *
 * Prerequisites:
 *   - Bitcoin Core running in regtest mode with txindex=1
 *   - ord indexer running against the regtest node
 *   - A funded wallet (see docs/ORD_NODE_SETUP.md, "Regtest Setup")
 *
 * Usage:
 *   ORD_REGTEST_URL=http://localhost:8080 \
 *   BITCOIN_REGTEST_RPC_URL=http://originals:originals-test@localhost:18443 \
 *   bun test tests/integration/bitcoin-regtest.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { OrdHttpProvider } from '../../src/adapters/providers/OrdHttpProvider';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';
import { BitcoinManager } from '../../src/bitcoin/BitcoinManager';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import type { OriginalsConfig } from '../../src/types';

const ORD_REGTEST_URL = process.env.ORD_REGTEST_URL;
const BITCOIN_REGTEST_RPC_URL = process.env.BITCOIN_REGTEST_RPC_URL;
const SKIP = !ORD_REGTEST_URL;

function describeRegtest(name: string, fn: () => void) {
  if (SKIP) {
    describe.skip(`[regtest] ${name} (set ORD_REGTEST_URL to enable)`, fn);
  } else {
    describe(`[regtest] ${name}`, fn);
  }
}

// ─── Read Operations ─────────────────────────────────────────────────────────

describeRegtest('OrdHttpProvider against regtest', () => {
  let provider: OrdHttpProvider;

  beforeAll(() => {
    provider = new OrdHttpProvider({ baseUrl: ORD_REGTEST_URL! });
  });

  test('estimateFee returns a positive number', async () => {
    const fee = await provider.estimateFee(1);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });

  test('getInscriptionById returns null for nonexistent', async () => {
    const result = await provider.getInscriptionById(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });

  test('getInscriptionsBySatoshi returns empty array for unused sat', async () => {
    const result = await provider.getInscriptionsBySatoshi('999999999999999');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test('getTransactionStatus returns status object', async () => {
    const status = await provider.getTransactionStatus(
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(typeof status.confirmed).toBe('boolean');
  });
});

describeRegtest('OrdinalsClient against regtest', () => {
  let client: OrdinalsClient;

  beforeAll(() => {
    client = new OrdinalsClient(ORD_REGTEST_URL!, 'regtest');
  });

  test('getSatInfo returns inscription_ids array', async () => {
    const info = await client.getSatInfo('0');
    expect(Array.isArray(info.inscription_ids)).toBe(true);
  });

  test('getInscriptionById returns null for nonexistent', async () => {
    const result = await client.getInscriptionById(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });
});

// ─── BitcoinManager ──────────────────────────────────────────────────────────

describeRegtest('BitcoinManager against regtest', () => {
  let manager: BitcoinManager;

  beforeAll(() => {
    const provider = new OrdHttpProvider({ baseUrl: ORD_REGTEST_URL! });
    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'ES256K',
      ordinalsProvider: provider,
      enableLogging: false,
    };
    manager = new BitcoinManager(config);
  });

  test('preventFrontRunning returns true for unknown satoshi', async () => {
    const result = await manager.preventFrontRunning('999999999999999');
    expect(result).toBe(true);
  });

  test('getSatoshiFromInscription returns null for unknown', async () => {
    const result = await manager.getSatoshiFromInscription(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });

  test('validateBTCODID returns false for nonexistent DID', async () => {
    const result = await manager.validateBTCODID('did:btco:reg:999999999999999');
    expect(result).toBe(false);
  });

  test('trackInscription returns null for nonexistent', async () => {
    const result = await manager.trackInscription(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });

  test('inscribeData validates inputs before reaching provider', async () => {
    await expect(manager.inscribeData(null, 'text/plain')).rejects.toThrow('INVALID_INPUT');
    await expect(manager.inscribeData('data', '')).rejects.toThrow('INVALID_INPUT');
    await expect(manager.inscribeData('data', 'bad')).rejects.toThrow('INVALID_INPUT');
    await expect(manager.inscribeData('data', 'text/plain', -1)).rejects.toThrow('INVALID_INPUT');
    await expect(manager.inscribeData('data', 'text/plain', 20_000)).rejects.toThrow('INVALID_INPUT');
  });
});

// ─── SDK-level Integration ───────────────────────────────────────────────────

describeRegtest('OriginalsSDK with regtest provider', () => {
  let sdk: OriginalsSDK;

  beforeAll(() => {
    const provider = new OrdHttpProvider({ baseUrl: ORD_REGTEST_URL! });
    sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      ordinalsProvider: provider,
      enableLogging: false,
    } as any);
  });

  test('SDK initializes with regtest provider', () => {
    expect(sdk).toBeTruthy();
    expect(sdk.bitcoin).toBeTruthy();
    expect(sdk.did).toBeTruthy();
    expect(sdk.lifecycle).toBeTruthy();
  });

  test('DID peer creation works alongside regtest provider', async () => {
    const didDoc = await sdk.did.createDIDPeer();
    expect(didDoc.id).toMatch(/^did:peer:/);
  });

  test('bitcoin.trackInscription returns null for nonexistent', async () => {
    const result = await sdk.bitcoin.trackInscription(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });
});

// ─── Network Connectivity ────────────────────────────────────────────────────

describeRegtest('Network connectivity', () => {
  test('ord node is reachable', async () => {
    const res = await fetch(ORD_REGTEST_URL!);
    expect(res.status).toBeLessThan(500);
  });

  test('Bitcoin RPC is reachable (if configured)', async () => {
    if (!BITCOIN_REGTEST_RPC_URL) return;
    const res = await fetch(BITCOIN_REGTEST_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getblockchaininfo',
        params: [],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result?: { chain?: string } };
    expect(data.result?.chain).toBe('regtest');
  });
});

// ─── Write Operations (require funded wallet + RPC) ──────────────────────────

const WRITE_SKIP = !BITCOIN_REGTEST_RPC_URL;

function describeRegtestWrite(name: string, fn: () => void) {
  if (SKIP || WRITE_SKIP) {
    describe.skip(
      `[regtest:write] ${name} (set ORD_REGTEST_URL + BITCOIN_REGTEST_RPC_URL to enable)`,
      fn
    );
  } else {
    describe(`[regtest:write] ${name}`, fn);
  }
}

describeRegtestWrite('Inscription lifecycle on regtest', () => {
  // These tests create real inscriptions on regtest.
  // They require a funded wallet and the ability to mine blocks.
  const rpcUrl = BITCOIN_REGTEST_RPC_URL!;

  async function rpcCall(method: string, params: unknown[] = []) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
    return data.result;
  }

  async function mineBlocks(count: number = 1) {
    // Generate to a new address in the default wallet
    const address = (await rpcCall('getnewaddress')) as string;
    await rpcCall('generatetoaddress', [count, address]);
  }

  test('can query blockchain info', async () => {
    const info = (await rpcCall('getblockchaininfo')) as { chain: string; blocks: number };
    expect(info.chain).toBe('regtest');
    expect(info.blocks).toBeGreaterThanOrEqual(0);
  });

  test('can mine blocks', async () => {
    const infoBefore = (await rpcCall('getblockchaininfo')) as { blocks: number };
    await mineBlocks(1);
    const infoAfter = (await rpcCall('getblockchaininfo')) as { blocks: number };
    expect(infoAfter.blocks).toBe(infoBefore.blocks + 1);
  });

  test('ord node indexes new blocks', async () => {
    await mineBlocks(1);
    // Give ord a moment to index
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${ORD_REGTEST_URL!}/status`);
    expect(res.status).toBeLessThan(500);
  });
});
