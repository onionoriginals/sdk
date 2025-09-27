import { OriginalsSDK } from '../../src';

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
import './BitcoinManager.more.part';
