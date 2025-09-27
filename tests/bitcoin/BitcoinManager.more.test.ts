import { OriginalsSDK } from '../../src';

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

