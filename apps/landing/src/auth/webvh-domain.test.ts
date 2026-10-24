import { describe, test, expect } from 'bun:test';
import * as ed from '@noble/ed25519';
import { LEGACY_WEBVH_DOMAIN, webvhDomain } from './webvh-domain';
import {
  BrowserWebVHSigner,
  buildUserWebVHDid,
  createUserWebVHDid,
  ed25519PublicKeyMultibase,
  readUserWebVHDid,
  userDidLogKey,
  userWebvhSlug,
} from './webvh';

// #976 B, gap G1: the did:webvh domain is the host the SPA was built for, so a
// reader can fetch what was published there (P3.6). It is permanent once used:
// an alias that moves to another host is an alias change by an author entry,
// never a silent re-pin (C12-139, P3.6, P9.3).
describe('the did:webvh domain comes from the build', () => {
  test('VITE_WEBVH_HOST names the domain', () => {
    expect(webvhDomain({ VITE_WEBVH_HOST: 'staging.originals.build' })).toBe('staging.originals.build');
  });

  test('unset keeps the legacy domain, so a dev build mints what it always did', () => {
    expect(webvhDomain({})).toBe(LEGACY_WEBVH_DOMAIN);
    expect(webvhDomain({ VITE_WEBVH_HOST: '' })).toBe(LEGACY_WEBVH_DOMAIN);
  });

  test('anything but a bare lowercase hostname is refused, never minted', () => {
    for (const bad of ['https://originals.build', 'originals.build:8080', 'Originals.Build', 'originals.build/x', 'localhost']) {
      expect(() => webvhDomain({ VITE_WEBVH_HOST: bad })).toThrow(/VITE_WEBVH_HOST/);
    }
  });
});

async function legacyIdentity(subOrgId: string) {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const signer = new BrowserWebVHSigner(priv, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(priv)));
  const built = await buildUserWebVHDid(signer, { domain: LEGACY_WEBVH_DOMAIN, slug: userWebvhSlug(subOrgId) });
  const jsonl = (built.didLog as unknown[]).map((e) => JSON.stringify(e)).join('\n') + '\n';
  return { built, key: userDidLogKey(LEGACY_WEBVH_DOMAIN, userWebvhSlug(subOrgId)), jsonl };
}

// The author DID is fixed at genesis; rotation and moves happen only in the
// author DID's own log (P5.8–P5.10). A build on a new domain therefore finds
// the legacy identity rather than minting a second author for the account.
describe('an identity minted on the legacy domain stays the author', () => {
  const subOrgId = 'suborg-legacy0123456';

  test('reading finds it when the build domain has none', async () => {
    const { built, key, jsonl } = await legacyIdentity(subOrgId);
    const asked: string[] = [];
    const hosting = {
      put: async (k: string) => `https://${k}`,
      get: async (k: string) => (asked.push(k), k === key ? { content: jsonl } : null),
    };
    const found = await readUserWebVHDid({ subOrgId, domain: 'staging.originals.build', hosting });
    expect(found!.did).toBe(built.did);
    expect(asked[0]).toBe(userDidLogKey('staging.originals.build', userWebvhSlug(subOrgId)));
  });

  test('creating returns it instead of minting a second identity', async () => {
    const { built, key, jsonl } = await legacyIdentity(subOrgId);
    const puts: string[] = [];
    const hosting = {
      put: async (k: string) => (puts.push(k), `https://${k}`),
      get: async (k: string) => (k === key ? { content: jsonl } : null),
    };
    const result = await createUserWebVHDid({
      subOrgId,
      email: 'author@example.test',
      domain: 'staging.originals.build',
      client: {} as never,
      identityAddress: 'unused',
      hosting,
    });
    expect(result.did).toBe(built.did);
    expect(puts).toEqual([]);
  });
});
