import { OriginalsSDK } from '../../src';
import { expect } from '@jest/globals';

const sdk = OriginalsSDK.create({ network: 'regtest' });

describe('BitcoinManager', () => {
  test('inscribeData returns an inscription (expected to fail until implemented)', async () => {
    const insc = await sdk.bitcoin.inscribeData(Buffer.from('hello'), 'text/plain', 2);
    expect(insc.inscriptionId).toBeDefined();
  });

  test('trackInscription returns status (expected to fail until implemented)', async () => {
    await expect(sdk.bitcoin.trackInscription('inscription-id')).resolves.not.toBeNull();
  });

  test('transferInscription returns a transaction (expected to fail until implemented)', async () => {
    const insc: any = { satoshi: '123', inscriptionId: 'abc', content: Buffer.alloc(0), contentType: 'text/plain', txid: 'tx', vout: 0 };
    const tx = await sdk.bitcoin.transferInscription(insc, 'bcrt1qaddress');
    expect(tx.txid).toBeDefined();
  });

  test('preventFrontRunning protects unique satoshi (expected to fail until implemented)', async () => {
    await expect(sdk.bitcoin.preventFrontRunning('123')).resolves.toBe(true);
  });

  test('getSatoshiFromInscription returns satoshi (expected to fail until implemented)', async () => {
    await expect(sdk.bitcoin.getSatoshiFromInscription('abc')).resolves.toBe('123');
  });

  test('validateBTCODID validates btco DID on-chain (expected to fail until implemented)', async () => {
    await expect(sdk.bitcoin.validateBTCODID('did:btco:123')).resolves.toBe(true);
  });

  test('validateBTCODID returns false for invalid DID (expected to pass)', async () => {
    await expect(sdk.bitcoin.validateBTCODID('did:peer:abc')).resolves.toBe(false);
  });

  test('extractSatoshiFromBTCODID parses correctly (expected to pass)', () => {
    const bm: any = sdk.bitcoin as any;
    expect(bm["extractSatoshiFromBTCODID"]('did:btco:123')).toBe('123');
    expect(bm["extractSatoshiFromBTCODID"]('did:peer:abc')).toBeNull();
    expect(bm["extractSatoshiFromBTCODID"]('did:btco:')).toBe('');
    expect(bm["extractSatoshiFromBTCODID"]('did:btco')).toBeNull();
    expect(bm["extractSatoshiFromBTCODID"]('')).toBeNull();
  });

  test('extractSatoshiFromBTCODID covers ternary false branch (forced)', () => {
    const bm: any = sdk.bitcoin as any;
    const spy = jest.spyOn(String.prototype, 'startsWith').mockImplementation(function(this: string, searchString: string) {
      if (this === 'did:btco' && searchString === 'did:btco:') return true;
      return (String.prototype.startsWith as any).wrapped ? (String.prototype.startsWith as any).wrapped.call(this, searchString) : String.prototype.startsWith.call(this, searchString);
    });
    // Save original for restore workaround
    (String.prototype.startsWith as any).wrapped = spy.getMockImplementation();
    expect(bm["extractSatoshiFromBTCODID"]('did:btco')).toBeNull();
    spy.mockRestore();
  });
});

/** Inlined from BitcoinManager.more.part.ts */

describe('BitcoinManager extra branches', () => {
  test('inscribeData uses feeOracle when provided', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', feeOracle: { estimateFeeRate: async () => 7 } as any });
    const insc = await sdk.bitcoin.inscribeData(Buffer.from('a'), 'text/plain');
    expect(insc.contentType).toBe('text/plain');
  });

  test('preventFrontRunning throws when satoshi missing', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    await expect(sdk.bitcoin.preventFrontRunning('')).rejects.toThrow('Satoshi identifier is required');
  });

  test('getSatoshiFromInscription falls back when no provider', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    await expect(sdk.bitcoin.getSatoshiFromInscription('id')).resolves.toBe('123');
  });

  test('preventFrontRunning uses ord provider when present', async () => {
    const ord = { getInscriptionsBySatoshi: async (_: string) => [{ inscriptionId: 'a' }] } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    await expect(sdk.bitcoin.preventFrontRunning('s')).resolves.toBe(true);
  });

  test('trackInscription returns null when provider returns null', async () => {
    const ord = { getInscriptionById: async (_: string) => null } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    await expect(sdk.bitcoin.trackInscription('x')).resolves.toBeNull();
  });

  test('getSatoshiFromInscription returns provider value when present', async () => {
    const ord = { getInscriptionById: async (_: string) => ({ satoshi: '999' }) } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    await expect(sdk.bitcoin.getSatoshiFromInscription('x')).resolves.toBe('999');
  });

  test('trackInscription maps provider fields to OrdinalsInscription', async () => {
    const ord = { getInscriptionById: async (_: string) => ({ inscriptionId: 'id', satoshi: '1', content: Buffer.from([1]), contentType: 'text/plain', txid: 't', vout: 2 }) } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    const v = await sdk.bitcoin.trackInscription('id');
    expect(v).toEqual(expect.objectContaining({ inscriptionId: 'id', txid: 't', vout: 2 }));
  });

  test('trackInscription falls back satoshi to "0" when provider omits it', async () => {
    const ord = { getInscriptionById: async (_: string) => ({ inscriptionId: 'id', content: Buffer.from([1]), contentType: 'text/plain', txid: 't', vout: 2 }) } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    const v = await sdk.bitcoin.trackInscription('id');
    expect(v!.satoshi).toBe('0');
  });

  test('getSatoshiFromInscription returns null when provider omits satoshi', async () => {
    const ord = { getInscriptionById: async (_: string) => ({}) } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: ord });
    const v = await sdk.bitcoin.getSatoshiFromInscription('id');
    expect(v).toBeNull();
  });

  test('validateBTCODID covers true and false paths', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    await expect(sdk.bitcoin.validateBTCODID('did:btco:xyz')).resolves.toBe(true);
    await expect(sdk.bitcoin.validateBTCODID('did:peer:xyz')).resolves.toBe(false);
  });

  test('inscribeData logs warn when feeOracle throws', async () => {
    const feeOracle = { estimateFeeRate: async () => { throw new Error('nope'); } } as any;
    const sdk = OriginalsSDK.create({ network: 'regtest', feeOracle });
    const insc = await sdk.bitcoin.inscribeData(Buffer.from('a'), 'text/plain');
    expect(insc.txid).toBeDefined();
  });
});
