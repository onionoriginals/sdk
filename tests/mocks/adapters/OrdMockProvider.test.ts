import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider', () => {
  test('createInscription and retrieval works', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('hello');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    expect(typeof res.inscriptionId).toBe('string');
    const fetched = await prov.getInscriptionById(res.inscriptionId);
    expect(fetched?.txid).toBe(res.txid);
  });
});

