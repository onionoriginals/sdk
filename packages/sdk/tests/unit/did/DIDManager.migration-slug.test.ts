import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';

/**
 * migrateToDIDWebVH derives the did:webvh slug from the last segment of the
 * source DID. (The numalgo-4 did:peer long-form slug-shortening branch was
 * removed with the did:peer purge — did:cel Phase 4·5/5.)
 */

describe('migrateToDIDWebVH slug', () => {
  const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

  // The numalgo-4 long-form slug tests (did:peer createDIDPeer + the special
  // "longest did:peer suffix" branch) were removed with the did:peer purge
  // (did:cel Phase 4·5/5). migrateToDIDWebVH now derives the slug from the last
  // DID segment generically; the case below still guards that.

  test('slug is the last source-DID segment (human-readable, hostable)', async () => {
    const migration = await sdk.did.migrateToDIDWebVH(
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:cel:abc123' },
      'example.com'
    );
    expect(migration.did.split(':')[4]).toBe('abc123');
  }, 30000);
});
