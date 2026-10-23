import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK, type HostedFetch, type OriginalsSigner } from '@originals/sdk/originals';
import { DemoEngine, PublicationNotVerifiedError, type PublishTarget } from './engine';
import { generateArtwork } from './artwork';
import { IndexedDbStore } from './idb-store';
import { createLocalAuthor, type LocalAuthor } from './local-author';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';

// #976 B4, gaps G4 and G5. A publication interrupted after its entry, or
// during its uploads, resumes after a browser restart with the same alias and
// checkpoint and no second publish entry (P9.2). Publication is complete only
// once a stranger with no cookie verifies the exact snapshot, every byte
// included (P3.6, P7.3); until then the page never says it is published.
const art = (title: string, seed: number) => generateArtwork(title, 'Orbits', seed).svg;

async function setup() {
  const idb = new IDBFactory();
  const author = await createLocalAuthor();
  const { upload, read, serve } = host();
  const secret = ed.utils.randomSecretKey();
  const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
  let aliasSignatures = 0;
  const sign = aliasSigner.sign.bind(aliasSigner);
  aliasSigner.sign = (input) => (aliasSignatures++, sign(input));
  const engine = (target: Partial<PublishTarget> = {}, a: LocalAuthor = author) =>
    new DemoEngine({
      authed: true,
      subOrgId: SUB,
      features: { hostedPublication: true },
      openStore: () => IndexedDbStore.open(SUB, idb),
      author: async () => a,
      publishTarget: { upload, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner, ...target },
    });
  const stranger = async (alias: string) => {
    try {
      return await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(alias, read);
    } catch {
      return null;
    }
  };
  return { engine, upload, read, serve, author, stranger, aliasSignatures: () => aliasSignatures };
}

/** An uploader that fails every PUT whose key matches, until `heal()`. */
function failing(upload: ReturnType<typeof host>['upload'], match: (key: string, n: number) => boolean) {
  let n = 0;
  let healed = false;
  return {
    put: (key: string, data: Uint8Array | string, o?: { contentType?: string }) =>
      !healed && match(key, n++) ? Promise.reject(new Error('connection lost')) : upload.put(key, data, o),
    submit: upload.submit.bind(upload),
    heal: () => (healed = true),
  };
}

describe('an interrupted publication resumes after a restart', () => {
  for (const [name, match] of [
    ['after the publish entry, before any upload', () => true],
    ['during the uploads, once the logs are up', (key: string) => key.includes('/originals/resources/')],
  ] as const) {
    test(`interrupted ${name}`, async () => {
      const s = await setup();
      const flaky = failing(s.upload, match);
      const before = s.engine({ upload: flaky });
      const created = await before.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
      await expect(before.publish()).rejects.toThrow(/connection lost/);
      const interrupted = before.snapshot();
      expect(interrupted.publication).toBe('incomplete');
      expect(interrupted.layer).toBe('did:vh');

      // The browser closes. A new one opens the same profile.
      const after = s.engine({ upload: flaky });
      const reopened = await after.open(created.did);
      expect(reopened.publication).toBe('incomplete');
      expect(reopened.layer).toBe('did:vh');
      // Nothing is edited on top of a half-published snapshot.
      await expect(after.update('Harbor at dusk', 'Orbits', art('Harbor at dusk', 8))).rejects.toThrow(/Finish publishing/);
      // A stranger can't read the complete snapshot: missing bytes leave `verified` alone (P7.3), so availability is checked too.
      const partial = await s.stranger(reopened.webvhDid ?? interrupted.webvhDid!);
      expect(!!partial?.verified && partial.report.resources.status === 'available').toBe(false);

      flaky.heal();
      const resumed = await after.publish();
      expect(resumed.publication).toBe('complete');
      expect(resumed.layer).toBe('did:webvh');
      expect(resumed.webvhDid).toBe(interrupted.webvhDid);
      // One publish entry: created + 1, the same checkpoint the interrupted run committed.
      expect(resumed.history.length).toBe(created.history.length + 1);
      expect(resumed.history.at(-1)!.versionId).toBe(interrupted.history.at(-1)!.versionId);
      expect(s.aliasSignatures()).toBe(1);
      const r = await s.stranger(resumed.webvhDid!);
      expect(r?.verified).toBe(true);
      expect(r?.report.resources.status).toBe('available');
    });
  }

  test('interrupted before the publish entry: the restart reuses the alias it built', async () => {
    const s = await setup();
    // The first signature is the genesis; the second is the publish entry, interrupted once.
    let signatures = 0;
    const inner = s.author.signer;
    const signer: OriginalsSigner = {
      verificationMethod: inner.verificationMethod,
      cryptosuite: inner.cryptosuite,
      sign: (request) => (++signatures === 2 ? Promise.reject(new Error('signing interrupted')) : inner.sign(request)),
    };
    const author: LocalAuthor = { ...s.author, signer };
    const before = s.engine({}, author);
    const created = await before.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    await expect(before.publish()).rejects.toThrow(/signing interrupted/);
    const after = s.engine({}, author);
    await after.open(created.did);
    const resumed = await after.publish();
    expect(resumed.publication).toBe('complete');
    expect(s.aliasSignatures()).toBe(1);
    expect(resumed.history.length).toBe(created.history.length + 1);
  });

  test('uploads that a stranger can\'t verify are never reported complete', async () => {
    const s = await setup();
    let blind = true;
    const read: HostedFetch = (url, o) => (blind ? Promise.reject(new Error('not served')) : s.read(url, o));
    const engine = s.engine({ read });
    await engine.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
    await expect(engine.publish()).rejects.toBeInstanceOf(PublicationNotVerifiedError);
    expect(engine.snapshot().publication).toBe('incomplete');
    blind = false;
    expect((await engine.publish()).publication).toBe('complete');
  });
});

describe('what the page says about an unfinished publication', () => {
  test('never "published", and how to finish', async () => {
    const { demoFailureMessage } = await import('../components/demo-logic');
    const { demo } = await import('../content');
    expect(demoFailureMessage(new PublicationNotVerifiedError(['x']))).toBe(demo.hosting.notVerified);
    expect(demoFailureMessage(new Error('Finish publishing this Original first, then keep editing.'))).toBe(demo.hosting.finishFirst);
    expect(demo.hosting.notVerified).toMatch(/isn’t published/);
  });
});

describe('the default reader (the page\'s own fetch)', () => {
  test('an absent optional file (did-witness.json) is missing, not a failure: publication completes through it', async () => {
    const s = await setup();
    // The page's fetch, answered by the fixture host for the alias's https URLs, with its real 404s.
    const saved = globalThis.fetch;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      return href.startsWith('https://') ? s.serve(new Request(href.replace(/^https:/, 'http:'))) : saved(url, init);
    }) as typeof fetch;
    try {
      const engine = s.engine({ read: undefined });
      await engine.create('Harbor at dawn', 'Orbits', art('Harbor at dawn', 7));
      expect((await engine.publish()).publication).toBe('complete');
    } finally {
      globalThis.fetch = saved;
    }
  });
});
