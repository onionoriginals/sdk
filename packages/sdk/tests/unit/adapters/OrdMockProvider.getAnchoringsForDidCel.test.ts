import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

const DID_CEL = 'did:cel:uZZZ';

function btcoDoc(satoshi: string, alsoKnownAs: string[]) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs,
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: 'uHEAD' } }],
  };
}

async function inscribe(p: OrdMockProvider, satoshi: string, alsoKnownAs: string[]) {
  const res = await p.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, alsoKnownAs))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return res.inscriptionId;
}

describe('OrdMockProvider.getAnchoringsForDidCel', () => {
  test('returns every inscription whose alsoKnownAs back-links the did:cel', async () => {
    const p = new OrdMockProvider();
    const iX = await inscribe(p, '100', [DID_CEL, 'did:webvh:example.com:x']);
    const iY = await inscribe(p, '200', [DID_CEL]);
    // Unrelated inscription: different did:cel, must NOT be returned.
    await inscribe(p, '300', ['did:cel:uOTHER']);

    const anchorings = await p.getAnchoringsForDidCel(DID_CEL);
    const bySat = new Map(anchorings.map((a) => [a.satoshi, a]));

    expect(anchorings).toHaveLength(2);
    expect(bySat.get('100')!.inscriptionId).toBe(iX);
    expect(bySat.get('200')!.inscriptionId).toBe(iY);
    // OrdMock stamps every inscription with a confirmed block height.
    expect(typeof bySat.get('100')!.blockHeight).toBe('number');
  });

  test('returns an empty array when no inscription back-links the did:cel', async () => {
    const p = new OrdMockProvider();
    await inscribe(p, '100', ['did:cel:uSOMETHINGELSE']);
    expect(await p.getAnchoringsForDidCel(DID_CEL)).toEqual([]);
  });

  test('skips non-JSON / non-DID-document inscriptions', async () => {
    const p = new OrdMockProvider();
    await p.createInscription({ data: Buffer.from('not json'), contentType: 'text/plain', targetSatoshi: '100' });
    expect(await p.getAnchoringsForDidCel(DID_CEL)).toEqual([]);
  });
});
