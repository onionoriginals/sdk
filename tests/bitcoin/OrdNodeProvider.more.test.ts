import { OrdNodeProvider } from '../../src/bitcoin/providers/OrdNodeProvider';

describe('OrdNodeProvider additional coverage', () => {
  test('covers constructor and simple methods', async () => {
    const provider = new OrdNodeProvider({ nodeUrl: 'http://node', timeout: 1234, network: 'signet' });

    const res = await provider.resolve('abc');
    expect(res).toMatchObject({ id: 'abc', content_url: 'http://node/content/abc' });

    const ins = await provider.resolveInscription('ins-1');
    expect(ins).toMatchObject({ id: 'ins-1', content_url: 'http://node/content/ins-1' });

    const info = await provider.resolveInfo('rid');
    expect(info.id).toBe('rid');

    const coll = await provider.resolveCollection('did:btco:1');
    expect(coll).toEqual([]);

    expect(await provider.getSatInfo('123')).toEqual({ inscription_ids: [] });
    expect(await provider.getMetadata('ins-1')).toBeNull();

    const gen = provider.getAllResources();
    const { done } = await gen.next();
    expect(done).toBe(true);

    const genChrono = provider.getAllResourcesChronological();
    const { done: done2 } = await genChrono.next();
    expect(done2).toBe(true);

    expect(await provider.getInscriptionLocationsByAddress('addr')).toEqual([]);

    const ins0 = await provider.getInscriptionByNumber(0);
    expect(ins0.id).toBe('0');

    expect(await provider.getAddressOutputs('addr')).toEqual([]);

    const out = await provider.getOutputDetails('txid:0');
    expect(out).toEqual({ value: 0, script_pubkey: '', spent: false, inscriptions: [] });
  });
});

