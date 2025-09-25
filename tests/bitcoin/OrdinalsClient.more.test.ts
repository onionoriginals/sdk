import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';

describe('OrdinalsClient additional branches', () => {
  const originalFetch = global.fetch as any;
  afterEach(() => { (global as any).fetch = originalFetch; });

  test('getInscriptionById returns null for falsy id', async () => {
    const c = new OrdinalsClient('http://ord', 'mainnet');
    const v = await c.getInscriptionById('');
    expect(v).toBeNull();
  });

  test('getMetadata handles quoted json string and bad hex', async () => {
    const c = new OrdinalsClient('http://ord', 'mainnet');
    (global as any).fetch = jest.fn(async (u: string) => {
      if (u.endsWith('/r/metadata/ins-1')) return { ok: true, text: async () => '"not-hex"' } as any;
      if (u.includes('/sat/')) return { ok: true, json: async () => ({ inscription_ids: [] }) } as any;
      return { ok: true, json: async () => ({}) } as any;
    });
    const v = await c.getMetadata('ins-1');
    expect(v).toBeNull();
  });
});

