import { describe, test, expect } from 'bun:test';
import * as ed from '@noble/ed25519';
import {
  BrowserWebVHSigner,
  DEFAULT_WEBVH_DOMAIN,
  buildUserWebVHDid,
  ed25519PublicKeyMultibase,
  readUserWebVHDid,
  userDidLogKey,
  userWebvhSlug,
  WebVHIdentityError,
} from './webvh';

async function makeSigner(): Promise<{ signer: BrowserWebVHSigner; priv: Uint8Array; pub: Uint8Array }> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(priv);
  const signer = new BrowserWebVHSigner(priv, ed25519PublicKeyMultibase(pub));
  return { signer, priv, pub };
}

describe('BrowserWebVHSigner — real Ed25519 did:webvh', () => {
  test('creates a valid did:webvh whose proof self-verifies for real', async () => {
    const { signer } = await makeSigner();
    const { did, didDocument, didLog } = await buildUserWebVHDid(signer, {
      domain: 'magby.originals.build',
      slug: 'user-abc0123456789a',
    });
    // Reaching here means createDIDOriginal ran didwebvh-ts's post-sign
    // self-verification and the Ed25519 proof over the log entry verified —
    // i.e. the signature is genuine, not a stub.
    expect(did.startsWith('did:webvh:')).toBe(true);
    expect(didDocument).toBeTruthy();
    expect(didLog).toBeTruthy();
  });

  test('verify() accepts a genuine signature and rejects a tampered one', async () => {
    const { signer, priv, pub } = await makeSigner();
    const msg = new TextEncoder().encode('originals-webvh');
    const sig = await ed.signAsync(msg, priv);
    expect(await signer.verify(sig, msg, pub)).toBe(true);
    const tampered = Uint8Array.from(sig);
    tampered[0] ^= 0xff;
    expect(await signer.verify(tampered, msg, pub)).toBe(false);
  });

  test('getVerificationMethodId is did:key of the bare multibase', async () => {
    const { signer } = await makeSigner();
    expect(signer.getPublicKeyMultibase().startsWith('z')).toBe(true);
    expect(signer.getVerificationMethodId()).toBe(`did:key:${signer.getPublicKeyMultibase()}`);
  });
});

describe('the DID document publishes two distinct keys', () => {
  test('identity signs and authenticates; the authorship key only asserts', async () => {
    const { signer } = await makeSigner();
    const authorshipPub = await ed.getPublicKeyAsync(crypto.getRandomValues(new Uint8Array(32)));
    const authorship = ed25519PublicKeyMultibase(authorshipPub);

    const { didDocument } = await buildUserWebVHDid(signer, {
      domain: 'magby.originals.build',
      slug: 'user-abc0123456789a',
      authorshipPublicKeyMultibase: authorship,
    });

    const doc = didDocument as {
      verificationMethod: Array<{ id: string; publicKeyMultibase: string }>;
      authentication: string[];
      assertionMethod: string[];
    };
    const byId = (frag: string) => doc.verificationMethod.find((v) => v.id.endsWith(frag));

    // The two keys are genuinely different — this used to be one key under two ids.
    expect(byId('#key-0')!.publicKeyMultibase).toBe(signer.getPublicKeyMultibase());
    expect(byId('#key-1')!.publicKeyMultibase).toBe(authorship);
    expect(byId('#key-0')!.publicKeyMultibase).not.toBe(byId('#key-1')!.publicKeyMultibase);

    expect(doc.authentication).toEqual(['#key-0']);
    expect(doc.assertionMethod).toEqual(['#key-1']);
  });

  test('with no authorship key there is no #key-1 to advertise', async () => {
    const { signer } = await makeSigner();
    const { didDocument } = await buildUserWebVHDid(signer, {
      domain: 'magby.originals.build',
      slug: 'user-abc0123456789a',
    });
    const doc = didDocument as {
      verificationMethod: Array<{ id: string }>;
      assertionMethod: string[];
    };
    expect(doc.verificationMethod.some((v) => v.id.endsWith('#key-1'))).toBe(false);
    expect(doc.assertionMethod).toEqual(['#key-0']);
  });
});

describe('reading an identity never creates one', () => {
  test('readUserWebVHDid returns null for an unpublished user and writes nothing', async () => {
    const puts: string[] = [];
    const hosting = {
      put: async (key: string) => {
        puts.push(key);
        return `https://${key}`;
      },
      get: async () => null,
    };
    const found = await readUserWebVHDid({ subOrgId: 'suborg-never-published', hosting });
    expect(found).toBeNull();
    expect(puts).toEqual([]);
  });

  test('it returns the published DID without re-deriving a new SCID', async () => {
    const { signer } = await makeSigner();
    const built = await buildUserWebVHDid(signer, {
      domain: DEFAULT_WEBVH_DOMAIN,
      slug: userWebvhSlug('suborg-abc0123456789'),
    });
    const jsonl = (built.didLog as unknown[]).map((e) => JSON.stringify(e)).join('\n') + '\n';
    const hosting = {
      put: async (key: string) => `https://${key}`,
      get: async (key: string) =>
        key === userDidLogKey(DEFAULT_WEBVH_DOMAIN, userWebvhSlug('suborg-abc0123456789'))
          ? { content: jsonl }
          : null,
    };
    const found = await readUserWebVHDid({ subOrgId: 'suborg-abc0123456789', hosting });
    expect(found!.did).toBe(built.did);
  });
});

describe('a failed read never overwrites a published identity', () => {
  const slug = () => userWebvhSlug('suborg-abc0123456789');
  const key = () => userDidLogKey(DEFAULT_WEBVH_DOMAIN, slug());

  /**
   * The expensive failure this guards: reporting a transient read failure as
   * "no identity yet" makes the caller mint a NEW SCID over the user's stable
   * did.jsonl, so the original DID stops resolving and every Original authored
   * under it is orphaned. A thrown error costs a retry instead.
   */
  test('a network failure propagates instead of reading as absent', async () => {
    const puts: string[] = [];
    const hosting = {
      put: async (k: string) => {
        puts.push(k);
        return `https://${k}`;
      },
      get: async () => {
        throw new Error('network down');
      },
    };
    await expect(
      readUserWebVHDid({ subOrgId: 'suborg-abc0123456789', hosting })
    ).rejects.toThrow(/network down/);
    expect(puts).toEqual([]);
  });

  test('a truncated log throws rather than inviting a remint', async () => {
    const hosting = {
      put: async (k: string) => `https://${k}`,
      get: async () => ({ content: '{"versionId":"1-abc","stat' }),
    };
    await expect(
      readUserWebVHDid({ subOrgId: 'suborg-abc0123456789', hosting })
    ).rejects.toThrow(WebVHIdentityError);
  });

  test('bytes that are not a did:webvh log are still not an empty slot', async () => {
    const hosting = {
      put: async (k: string) => `https://${k}`,
      get: async () => ({ content: '[{"state":{"id":"did:example:not-webvh"}}]' }),
    };
    await expect(
      readUserWebVHDid({ subOrgId: 'suborg-abc0123456789', hosting })
    ).rejects.toThrow(WebVHIdentityError);
  });

  test('only an affirmative 404 — a null from the adapter — reads as absent', async () => {
    const hosting = { put: async (k: string) => `https://${k}`, get: async () => null };
    expect(await readUserWebVHDid({ subOrgId: 'suborg-abc0123456789', hosting })).toBeNull();
    expect(key()).toContain(slug());
  });
});
