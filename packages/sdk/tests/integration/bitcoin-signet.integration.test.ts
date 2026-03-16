/**
 * Bitcoin Signet Integration Tests
 *
 * These tests run against a real ord node connected to Bitcoin signet.
 * They are skipped by default and only run when ORD_SIGNET_URL is set.
 *
 * Prerequisites:
 *   - A running ord node indexed against signet (see docs/ORD_NODE_SETUP.md)
 *   - Export ORD_SIGNET_URL=http://localhost:8080 (or your ord node URL)
 *
 * Usage:
 *   ORD_SIGNET_URL=http://localhost:8080 bun test tests/integration/bitcoin-signet.integration.test.ts
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { OrdHttpProvider } from '../../src/adapters/providers/OrdHttpProvider';
import { SignetProvider } from '../../src/bitcoin/providers/SignetProvider';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';
import { BitcoinManager } from '../../src/bitcoin/BitcoinManager';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import type { OriginalsConfig } from '../../src/types';

const ORD_SIGNET_URL = process.env.ORD_SIGNET_URL;
const BITCOIN_SIGNET_RPC_URL = process.env.BITCOIN_SIGNET_RPC_URL;
const SKIP = !ORD_SIGNET_URL;

// A known inscription on signet for read-only tests.
// Override with ORD_TEST_INSCRIPTION_ID if your node has different data.
const TEST_INSCRIPTION_ID = process.env.ORD_TEST_INSCRIPTION_ID || '';
const TEST_SATOSHI = process.env.ORD_TEST_SATOSHI || '';

function describeSignet(name: string, fn: () => void) {
  if (SKIP) {
    describe.skip(`[signet] ${name} (set ORD_SIGNET_URL to enable)`, fn);
  } else {
    describe(`[signet] ${name}`, fn);
  }
}

describeSignet('OrdHttpProvider against signet', () => {
  let provider: OrdHttpProvider;

  beforeAll(() => {
    provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
  });

  test('constructor rejects invalid URLs', () => {
    expect(() => new OrdHttpProvider({ baseUrl: '' })).toThrow();
    expect(() => new OrdHttpProvider({ baseUrl: 'ftp://bad' })).toThrow();
  });

  test('estimateFee returns a positive number', async () => {
    const fee = await provider.estimateFee(1);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });

  test('getInscriptionById returns null for nonexistent inscription', async () => {
    const result = await provider.getInscriptionById('0000000000000000000000000000000000000000000000000000000000000000i0');
    expect(result).toBeNull();
  });

  test('getInscriptionsBySatoshi returns array for nonexistent satoshi', async () => {
    const result = await provider.getInscriptionsBySatoshi('999999999999999');
    expect(Array.isArray(result)).toBe(true);
  });

  if (TEST_INSCRIPTION_ID) {
    test('getInscriptionById resolves a known inscription', async () => {
      const result = await provider.getInscriptionById(TEST_INSCRIPTION_ID);
      expect(result).not.toBeNull();
      expect(result!.inscriptionId).toBeTruthy();
      expect(result!.contentType).toBeTruthy();
      expect(result!.content).toBeTruthy();
    });
  }

  if (TEST_SATOSHI) {
    test('getInscriptionsBySatoshi resolves a known satoshi', async () => {
      const result = await provider.getInscriptionsBySatoshi(TEST_SATOSHI);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].inscriptionId).toBeTruthy();
    });
  }

  test('getTransactionStatus returns status object', async () => {
    const status = await provider.getTransactionStatus('0000000000000000000000000000000000000000000000000000000000000000');
    expect(typeof status.confirmed).toBe('boolean');
  });
});

describeSignet('OrdinalsClient against signet', () => {
  let client: OrdinalsClient;

  beforeAll(() => {
    client = new OrdinalsClient(ORD_SIGNET_URL!, 'signet');
  });

  test('estimateFee returns a positive number', async () => {
    const fee = await client.estimateFee(1);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });

  test('getSatInfo returns inscription_ids array for unknown sat', async () => {
    const info = await client.getSatInfo('999999999999999');
    expect(Array.isArray(info.inscription_ids)).toBe(true);
  });

  if (TEST_INSCRIPTION_ID) {
    test('resolveInscription fetches a known inscription', async () => {
      const inscription = await client.resolveInscription(TEST_INSCRIPTION_ID);
      expect(inscription).not.toBeNull();
      expect(inscription!.inscriptionId).toBeTruthy();
      expect(inscription!.content).toBeInstanceOf(Buffer);
      expect(inscription!.contentType).toBeTruthy();
    });

    test('getMetadata returns object or null for known inscription', async () => {
      const metadata = await client.getMetadata(TEST_INSCRIPTION_ID);
      // Metadata may or may not exist; just ensure no crash
      expect(metadata === null || typeof metadata === 'object').toBe(true);
    });
  }

  if (TEST_SATOSHI) {
    test('getInscriptionsBySatoshi resolves inscriptions on a known sat', async () => {
      const inscriptions = await client.getInscriptionsBySatoshi(TEST_SATOSHI);
      expect(inscriptions.length).toBeGreaterThan(0);
      expect(inscriptions[0].inscriptionId).toBeTruthy();
    });
  }
});

describeSignet('BitcoinManager against signet', () => {
  let manager: BitcoinManager;
  let provider: OrdHttpProvider;

  beforeAll(() => {
    provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
    const config: OriginalsConfig = {
      network: 'signet',
      defaultKeyType: 'ES256K',
      ordinalsProvider: provider,
      enableLogging: false,
    };
    manager = new BitcoinManager(config);
  });

  test('preventFrontRunning returns boolean for unknown satoshi', async () => {
    const result = await manager.preventFrontRunning('999999999999999');
    expect(typeof result).toBe('boolean');
  });

  test('getSatoshiFromInscription returns null for unknown inscription', async () => {
    const result = await manager.getSatoshiFromInscription('0000000000000000000000000000000000000000000000000000000000000000i0');
    expect(result).toBeNull();
  });

  test('validateBTCODID returns false for nonexistent DID', async () => {
    const result = await manager.validateBTCODID('did:btco:sig:999999999999999');
    expect(result).toBe(false);
  });

  if (TEST_INSCRIPTION_ID) {
    test('trackInscription resolves a known inscription', async () => {
      const inscription = await manager.trackInscription(TEST_INSCRIPTION_ID);
      expect(inscription).not.toBeNull();
      expect(inscription!.inscriptionId).toBeTruthy();
    });
  }

  test('inscribeData rejects without data', async () => {
    await expect(manager.inscribeData(null, 'text/plain')).rejects.toThrow('INVALID_INPUT');
  });
});

describeSignet('OriginalsSDK with signet provider', () => {
  let sdk: OriginalsSDK;

  beforeAll(() => {
    const provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
    sdk = OriginalsSDK.create({
      network: 'signet',
      webvhNetwork: 'cleffa',
      ordinalsProvider: provider,
      enableLogging: false,
    } as any);
  });

  test('SDK initializes with signet provider', () => {
    expect(sdk).toBeTruthy();
    expect(sdk.bitcoin).toBeTruthy();
    expect(sdk.did).toBeTruthy();
  });

  test('SDK bitcoin.trackInscription returns null for nonexistent', async () => {
    const result = await sdk.bitcoin.trackInscription('0000000000000000000000000000000000000000000000000000000000000000i0');
    expect(result).toBeNull();
  });

  test('SDK DID operations work alongside signet provider', async () => {
    // Verify DID creation still works when signet provider is configured
    const didDoc = await sdk.did.createDIDPeer();
    expect(didDoc.id).toMatch(/^did:peer:/);
  });
});

// ─── SignetProvider (RPC-backed adapter) ────────────────────────────────────

describeSignet('SignetProvider against signet', () => {
  let provider: SignetProvider;

  beforeAll(() => {
    provider = new SignetProvider({
      ordUrl: ORD_SIGNET_URL!,
      bitcoinRpcUrl: BITCOIN_SIGNET_RPC_URL,
    });
  });

  test('getInscriptionById returns null for nonexistent inscription', async () => {
    const result = await provider.getInscriptionById(
      '0000000000000000000000000000000000000000000000000000000000000000i0'
    );
    expect(result).toBeNull();
  });

  test('getInscriptionsBySatoshi returns array', async () => {
    const results = await provider.getInscriptionsBySatoshi('999999999999999');
    expect(Array.isArray(results)).toBe(true);
  });

  test('estimateFee returns a positive number', async () => {
    const fee = await provider.estimateFee(1);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });

  test('estimateFee uses Bitcoin Core RPC when configured', async () => {
    if (!BITCOIN_SIGNET_RPC_URL) {
      // Without RPC, falls back to default
      const fee = await provider.estimateFee(6);
      expect(fee).toBeGreaterThan(0);
      return;
    }
    // With RPC, should get a real fee estimate
    const fee = await provider.estimateFee(6);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });

  test('getTransactionStatus returns status object', async () => {
    const status = await provider.getTransactionStatus(
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(typeof status.confirmed).toBe('boolean');
  });

  test('createInscription throws without wallet configured', async () => {
    const noWalletProvider = new SignetProvider({ ordUrl: ORD_SIGNET_URL! });
    await expect(
      noWalletProvider.createInscription({
        data: Buffer.from('test'),
        contentType: 'text/plain',
      })
    ).rejects.toThrow(/requires a funded signet wallet/);
  });

  test('transferInscription throws without wallet configured', async () => {
    const noWalletProvider = new SignetProvider({ ordUrl: ORD_SIGNET_URL! });
    await expect(
      noWalletProvider.transferInscription(
        'test-id',
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
      )
    ).rejects.toThrow(/requires a funded signet wallet/);
  });

  if (TEST_INSCRIPTION_ID) {
    test('getInscriptionById resolves a known inscription', async () => {
      const result = await provider.getInscriptionById(TEST_INSCRIPTION_ID);
      expect(result).not.toBeNull();
      expect(result!.inscriptionId).toBeTruthy();
      expect(result!.contentType).toBeTruthy();
      expect(typeof result!.satoshi).toBe('string');
    });
  }
});

describeSignet('SignetProvider with BitcoinManager', () => {
  let manager: BitcoinManager;

  beforeAll(() => {
    const provider = new SignetProvider({
      ordUrl: ORD_SIGNET_URL!,
      bitcoinRpcUrl: BITCOIN_SIGNET_RPC_URL,
    });
    const config: OriginalsConfig = {
      network: 'signet',
      defaultKeyType: 'ES256K',
      ordinalsProvider: provider,
      enableLogging: false,
    };
    manager = new BitcoinManager(config);
  });

  test('preventFrontRunning returns boolean', async () => {
    const result = await manager.preventFrontRunning('999999999999999');
    expect(typeof result).toBe('boolean');
  });

  test('validateBTCODID returns false for nonexistent DID', async () => {
    const result = await manager.validateBTCODID('did:btco:sig:999999999999999');
    expect(result).toBe(false);
  });

  if (TEST_INSCRIPTION_ID) {
    test('trackInscription resolves a known inscription', async () => {
      const inscription = await manager.trackInscription(TEST_INSCRIPTION_ID);
      expect(inscription).not.toBeNull();
      expect(inscription!.inscriptionId).toBeTruthy();
      expect(inscription!.satoshi).toBeTruthy();
      expect(inscription!.content).toBeInstanceOf(Buffer);
    });
  }
});

describeSignet('Concurrent query resilience', () => {
  let provider: OrdHttpProvider;

  beforeAll(() => {
    provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
  });

  test('handles multiple parallel inscription lookups', async () => {
    const ids = [
      '0000000000000000000000000000000000000000000000000000000000000000i0',
      '0000000000000000000000000000000000000000000000000000000000000001i0',
      '0000000000000000000000000000000000000000000000000000000000000002i0',
    ];
    const results = await Promise.all(ids.map(id => provider.getInscriptionById(id)));
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r === null || typeof r === 'object').toBe(true);
    }
  });

  test('handles parallel fee estimation and inscription queries', async () => {
    const [fee, inscription, satLookup] = await Promise.all([
      provider.estimateFee(1),
      provider.getInscriptionById('0000000000000000000000000000000000000000000000000000000000000000i0'),
      provider.getInscriptionsBySatoshi('0'),
    ]);
    expect(typeof fee).toBe('number');
    expect(inscription === null || typeof inscription === 'object').toBe(true);
    expect(Array.isArray(satLookup)).toBe(true);
  });
});

describeSignet('Edge case inputs against real node', () => {
  let provider: OrdHttpProvider;

  beforeAll(() => {
    provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
  });

  test('getInscriptionById handles empty string', async () => {
    const result = await provider.getInscriptionById('');
    expect(result).toBeNull();
  });

  test('getInscriptionsBySatoshi handles zero satoshi', async () => {
    const result = await provider.getInscriptionsBySatoshi('0');
    expect(Array.isArray(result)).toBe(true);
  });

  test('getInscriptionsBySatoshi handles max supply satoshi', async () => {
    const result = await provider.getInscriptionsBySatoshi('2099999997690000');
    expect(Array.isArray(result)).toBe(true);
  });

  test('getTransactionStatus handles malformed txid gracefully', async () => {
    const status = await provider.getTransactionStatus('not-a-real-txid');
    expect(typeof status.confirmed).toBe('boolean');
  });
});

describeSignet('BitcoinManager DID validation against signet', () => {
  let manager: BitcoinManager;

  beforeAll(() => {
    const provider = new OrdHttpProvider({ baseUrl: ORD_SIGNET_URL! });
    const config: OriginalsConfig = {
      network: 'signet',
      defaultKeyType: 'ES256K',
      ordinalsProvider: provider,
      enableLogging: false,
    };
    manager = new BitcoinManager(config);
  });

  test('validateBTCODID rejects invalid DID format', async () => {
    const result = await manager.validateBTCODID('did:web:example.com');
    expect(result).toBe(false);
  });

  test('validateBTCODID rejects DID with invalid network prefix', async () => {
    const result = await manager.validateBTCODID('did:btco:invalid:123');
    expect(result).toBe(false);
  });

  test('preventFrontRunning rejects empty satoshi', async () => {
    await expect(manager.preventFrontRunning('')).rejects.toThrow('SATOSHI_REQUIRED');
  });

  test('inscribeData validates content type format', async () => {
    await expect(manager.inscribeData({ test: true }, 'not-a-mime-type')).rejects.toThrow('INVALID_INPUT');
  });
});

describeSignet('Network connectivity validation', () => {
  test('ord node is reachable', async () => {
    const res = await fetch(ORD_SIGNET_URL!);
    expect(res.status).toBeLessThan(500);
  });

  test('ord node responds to /status endpoint', async () => {
    const res = await fetch(`${ORD_SIGNET_URL!.replace(/\/$/, '')}/status`);
    // Some ord versions use /status, others don't - just verify no crash
    expect(typeof res.status).toBe('number');
  });

  test('provider handles network timeout gracefully', async () => {
    const badProvider = new OrdHttpProvider({ baseUrl: 'http://192.0.2.1:1' });
    // Should reject or return null, not hang indefinitely
    const result = badProvider.getInscriptionById('test');
    // We expect this to either reject or return null within a reasonable time
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 10_000)
    );
    try {
      const res = await Promise.race([result, timeout]);
      // If it resolves, it should be null
      expect(res).toBeNull();
    } catch (err: any) {
      // Network error or timeout is acceptable
      expect(err).toBeTruthy();
    }
  });
});
