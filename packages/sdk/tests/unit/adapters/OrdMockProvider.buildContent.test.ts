import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider deferred content', () => {
  test('buildContent receives the satoshi that appears in the result', async () => {
    const provider = new OrdMockProvider();
    let seenSat: string | undefined;
    const result = await provider.createInscription({
      buildContent: (satoshi: string) => {
        seenSat = satoshi;
        return Buffer.from(JSON.stringify({ id: `did:btco:${satoshi}` }));
      },
      contentType: 'application/did+json'
    });
    expect(seenSat).toBe(result.satoshi);
    const stored = await provider.getInscriptionById(result.inscriptionId);
    expect(JSON.parse(stored!.content.toString()).id).toBe(`did:btco:${result.satoshi}`);
  });

  test('targetSatoshi reinscribes on the same sat (appends to sat history)', async () => {
    const provider = new OrdMockProvider();
    const first = await provider.createInscription({
      data: Buffer.from('one'), contentType: 'text/plain'
    });
    const second = await provider.createInscription({
      data: Buffer.from('two'), contentType: 'text/plain', targetSatoshi: first.satoshi
    });
    expect(second.satoshi).toBe(first.satoshi);
    const list = await provider.getInscriptionsBySatoshi(first.satoshi!);
    expect(list.map(i => i.inscriptionId)).toEqual([first.inscriptionId, second.inscriptionId]);
  });

  test('rejects when neither or both of data/buildContent given', async () => {
    const provider = new OrdMockProvider();
    await expect(provider.createInscription({ contentType: 'text/plain' } as never))
      .rejects.toThrow();
    await expect(provider.createInscription({
      data: Buffer.from('x'),
      buildContent: () => Buffer.from('y'),
      contentType: 'text/plain'
    } as never)).rejects.toThrow();
  });
});
