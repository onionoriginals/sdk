import { describe, test, expect } from 'bun:test';
import { BtcoDidResolver } from '../../../src/did/BtcoDidResolver';
import type { ResourceProviderLike } from '../../../src/did/BtcoDidResolver';

/**
 * Pre-release fix: the backwards walk over a sat's inscriptions skipped any
 * entry with an `error` (content-fetch failure, HTTP error, timeout) and
 * returned the next OLDER valid document as current. A transient failure
 * fetching the NEWEST inscription therefore served a rotated-away document —
 * resurrecting a deactivated DID or re-exposing a rotated key (and the result
 * was then cached for 24h by DIDManager).
 *
 * When a newer, potentially lifecycle-relevant inscription is unreadable,
 * resolution must FAIL (resolutionMetadata.error), never fall back to an
 * older document. Readable inscriptions that are demonstrably unrelated
 * content are still skipped.
 */

const DID = 'did:btco:128';
const DOC = JSON.stringify({
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: DID,
  verificationMethod: [{
    id: `${DID}#key-0`,
    type: 'Multikey',
    controller: DID,
    publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
  }]
});

function makeProvider(ids: string[]): ResourceProviderLike {
  return {
    async getSatInfo() { return { inscription_ids: ids }; },
    async resolveInscription(id: string) {
      return { id, sat: 128, content_type: 'text/plain', content_url: `http://local/content/${id}` };
    },
    async getMetadata() { return null; }
  };
}

/** fetchFn serving canned bodies per inscription id; 'FAIL' entries reject. */
function makeFetch(bodies: Record<string, string | 'FAIL'>) {
  return async (url: string): Promise<Response> => {
    const id = url.split('/').pop() as string;
    const body = bodies[id];
    if (body === 'FAIL') {
      throw new Error('network timeout');
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => body } as unknown as Response;
  };
}

describe('BtcoDidResolver: unreadable newest inscription must not serve an older document', () => {
  test('fetch failure on the newest inscription -> resolution error, NOT the older document', async () => {
    const resolver = new BtcoDidResolver({
      provider: makeProvider(['insc-old-doc', 'insc-new-unreadable']),
      fetchFn: makeFetch({ 'insc-old-doc': DOC, 'insc-new-unreadable': 'FAIL' })
    });

    const res = await resolver.resolve(DID);

    // The stale (possibly rotated-away) older document must NOT be returned.
    expect(res.didDocument).toBeNull();
    // And the outcome is a hard resolution error, distinguishable from
    // "no DID on this sat", so callers do not cache a wrong answer.
    expect(res.resolutionMetadata.error).toBe('unresolvable');
    expect(res.resolutionMetadata.message).toContain('insc-new-unreadable');
    expect(res.didDocumentMetadata.deactivated).toBeUndefined();
  });

  test('unreadable newer inscription must not resurrect a deactivated DID', async () => {
    // Old valid doc, then a tombstone, then a newer inscription that cannot be
    // fetched. Before the fix the walk skipped the unreadable entry, hit the
    // tombstone... but if the unreadable entry were the tombstone itself the
    // DID would resurrect. Model exactly that: doc, unreadable tombstone.
    const resolver = new BtcoDidResolver({
      provider: makeProvider(['insc-doc', 'insc-tombstone-unreadable']),
      fetchFn: makeFetch({ 'insc-doc': DOC, 'insc-tombstone-unreadable': 'FAIL' })
    });

    const res = await resolver.resolve(DID);
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('unresolvable');
  });

  test('readable but unrelated newest content still falls back to the older valid document', async () => {
    const resolver = new BtcoDidResolver({
      provider: makeProvider(['insc-doc', 'insc-unrelated']),
      fetchFn: makeFetch({ 'insc-doc': DOC, 'insc-unrelated': 'just an ordinary inscription' })
    });

    const res = await resolver.resolve(DID);
    expect(res.resolutionMetadata.error).toBeUndefined();
    expect(res.didDocument?.id).toBe(DID);
  });

  test('valid newest document is unaffected by an older unreadable inscription', async () => {
    const resolver = new BtcoDidResolver({
      provider: makeProvider(['insc-old-unreadable', 'insc-doc']),
      fetchFn: makeFetch({ 'insc-old-unreadable': 'FAIL', 'insc-doc': DOC })
    });

    const res = await resolver.resolve(DID);
    expect(res.resolutionMetadata.error).toBeUndefined();
    expect(res.didDocument?.id).toBe(DID);
  });

  test('tombstone remains authoritative when it is readable, even with older unreadable entries', async () => {
    const resolver = new BtcoDidResolver({
      provider: makeProvider(['insc-old-unreadable', 'insc-tombstone']),
      fetchFn: makeFetch({ 'insc-old-unreadable': 'FAIL', 'insc-tombstone': `BTCO DID: ${DID} 🔥` })
    });

    const res = await resolver.resolve(DID);
    expect(res.didDocument).toBeNull();
    expect(res.didDocumentMetadata.deactivated).toBe(true);
  });
});
