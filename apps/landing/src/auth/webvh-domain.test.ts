import { describe, test, expect } from 'bun:test';
import * as ed from '@noble/ed25519';
import { base58 } from '@scure/base';
import { CANONICAL_WEBVH_DOMAIN, webvhDomain } from './webvh-domain';
import { BrowserWebVHSigner, buildUserWebVHDid, createUserWebVHDid, ed25519PublicKeyMultibase, readUserWebVHDid, userDidLogKey, userWebvhSlug } from './webvh';

describe('configured identity domain', () => {
  test('defaults to the canonical host and honors an explicit deployment host', () => {
    expect(webvhDomain({})).toBe('originals.build');
    expect(webvhDomain({ VITE_WEBVH_HOST: '' })).toBe(CANONICAL_WEBVH_DOMAIN);
    expect(webvhDomain({ VITE_WEBVH_HOST: 'staging.example' })).toBe('staging.example');
  });
  test('rejects malformed hosts before minting an identity', () => {
    for (const host of ['https://originals.build', 'originals.build:8080', 'Originals.Build', 'originals.build/x', 'localhost']) {
      expect(() => webvhDomain({ VITE_WEBVH_HOST: host })).toThrow(/VITE_WEBVH_HOST/);
    }
  });
});

async function fixture(domain = 'retired.example') {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(secret);
  const signer = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(publicKey));
  const subOrgId = 'suborg-domain0123456';
  const built = await buildUserWebVHDid(signer, { domain, slug: userWebvhSlug(subOrgId) });
  const key = userDidLogKey(domain, userWebvhSlug(subOrgId));
  const content = (built.didLog as unknown[]).map(e => JSON.stringify(e)).join('\n') + '\n';
  const files = new Map([[key, content]]);
  const reads: string[] = [];
  const writes: string[] = [];
  const hosting = {
    get: async (k: string) => { reads.push(k); return files.has(k) ? { content: files.get(k)! } : null; },
    put: async (k: string, data: string | Uint8Array) => { writes.push(k); files.set(k, typeof data === 'string' ? data : new TextDecoder().decode(data)); return `https://${k}`; },
  };
  const client = {
    signRawPayload: async ({ payload }: { payload: string }) => {
      const signature = await ed.signAsync(Uint8Array.from(Buffer.from(payload.replace(/^0x/, ''), 'hex')), secret);
      return { activity: { result: { signRawPayloadResult: { r: Buffer.from(signature.slice(0, 32)).toString('hex'), s: Buffer.from(signature.slice(32)).toString('hex') } } } };
    },
  };
  return { subOrgId, built, key, content, files, reads, writes, hosting, client, address: base58.encode(publicKey) };
}

describe('identities belong only to the selected host', () => {
  test('a retired-host identity is not returned, copied or rewritten', async () => {
    const f = await fixture();
    expect(await readUserWebVHDid({ subOrgId: f.subOrgId, domain: 'originals.build', hosting: f.hosting })).toBeNull();
    expect(f.reads).toEqual([userDidLogKey('originals.build', userWebvhSlug(f.subOrgId))]);
    expect(f.writes).toEqual([]);
  });
  test('explicit creation signs a new identity on the canonical host, then reuses it', async () => {
    const f = await fixture();
    const options = { subOrgId: f.subOrgId, email: 'author@example.test', domain: 'originals.build', client: f.client as never, identityAddress: f.address, hosting: f.hosting };
    const created = await createUserWebVHDid(options);
    expect(created.did).not.toBe(f.built.did);
    expect(created.did).toContain(':originals.build:');
    expect(f.files.get(f.key)).toBe(f.content);
    expect(f.writes).toEqual([userDidLogKey('originals.build', userWebvhSlug(f.subOrgId))]);
    expect((await createUserWebVHDid(options)).did).toBe(created.did);
    expect(f.writes).toHaveLength(1);
  });
  test('a failed read does not authorize replacement', async () => {
    const f = await fixture('originals.build');
    f.hosting.get = async () => { throw new Error('offline'); };
    await expect(createUserWebVHDid({ subOrgId: f.subOrgId, email: 'author@example.test', domain: 'originals.build', client: f.client as never, identityAddress: f.address, hosting: f.hosting })).rejects.toThrow('offline');
    expect(f.writes).toEqual([]);
  });
});
