import { OrdNodeProvider } from '../../src/bitcoin/providers/OrdNodeProvider';

describe('OrdNodeProvider (stub)', () => {
  it('constructs and returns defaults', async () => {
    const p = new OrdNodeProvider({ nodeUrl: 'https://ord.example' });
    const info = await p.getSatInfo('1');
    expect(info.inscription_ids).toEqual([]);
    const insc = await p.resolveInscription('abc');
    expect(insc.content_url).toContain('/content/abc');
  });
});

