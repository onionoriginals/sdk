import { OrdinalsClientProvider } from '../../src/bitcoin/providers/OrdinalsProvider';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';

describe('OrdinalsClientProvider extra branches', () => {
  test('resolveInscription throws when client returns null', async () => {
    const client: jest.Mocked<OrdinalsClient> = new OrdinalsClient('http://ord', 'regtest') as any;
    (client.getInscriptionById as any) = jest.fn(async () => null as any);
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord' });
    await expect(p.resolveInscription('missing')).rejects.toThrow('Inscription not found');
  });
});

