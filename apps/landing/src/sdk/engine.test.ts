import { describe, expect, test } from 'bun:test';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { DemoEngine, FeatureUnavailableError, StaleSaveError } from './engine';
import { generateArtwork } from './artwork';
import { FEATURES } from './features';
import * as ed from '@noble/ed25519';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';
import { landingSharedHost } from './shared-host';

async function created() {
  const engine = new DemoEngine();
  const art = generateArtwork('Harbor at dawn', 'Orbits', 7);
  const state = await engine.create('Harbor at dawn', 'Orbits', art.svg);
  return { engine, state };
}

describe('DemoEngine on the Originals Protocol', () => {
  test('creates a did:vh Original signed by a browser-local did:vh author', async () => {
    const { state } = await created();
    expect(state.layer).toBe('did:vh');
    expect(state.did).toMatch(/^did:vh:/);
    expect(state.author).toMatch(/^did:vh:/);
    expect(state.author).not.toBe(state.did);
    expect(state.resource).toMatchObject({ id: 'artwork.svg', contentType: 'image/svg+xml', version: 1 });
    expect(state.metadata?.id).toBe('metadata.json');
    expect(state.history.map((h) => h.operation)).toEqual(['create']);
    expect(state.history[0].authorKey).toBe(`${state.author}#author`);
    // A local Original is never current; it is valid as of its checkpoint (P7.10).
    const provenance = state.provenance as { current: boolean; validAsOf: { checkpoint: string } | null; reasons: string[] };
    expect(provenance.current).toBe(false);
    expect(provenance.validAsOf?.checkpoint).toBe(state.history[0].versionId);
    expect(provenance.reasons).toEqual(['not-anchored']);
  });

  test('a revision appends a signed entry; the artwork version comes from history (P4.4)', async () => {
    const { engine, state } = await created();
    const art = generateArtwork('Harbor at dusk', 'Orbits', 8);
    const revised = await engine.update('Harbor at dusk', 'Orbits', art.svg);
    expect(revised.did).toBe(state.did);
    expect(revised.resource.version).toBe(2);
    expect(revised.history.map((h) => h.operation)).toEqual(['create', 'update']);
    expect(revised.history[1].changes.map((c) => c.resource).sort()).toEqual(['artwork.svg', 'metadata.json']);
    // A rename alone leaves the artwork at its version.
    const renamed = await engine.update('Harbor, dusk', 'Orbits', art.svg);
    expect(renamed.resource.version).toBe(2);
    expect(renamed.history.length).toBe(3);
  });

  test('the evidence package verifies in a fresh reader with no key (C12-01)', async () => {
    const { engine, state } = await created();
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const { report } = await reader.load(await engine.evidencePackage());
    expect(report.original).toBe(state.did);
    expect(report.history.status).toBe('valid');
    expect(report.authorBinding.status).toBe('valid');
    expect(report.identityEvidence.status).toBe('complete');
    expect(report.resources.status).toBe('available');
  });

  test('publication and anchoring refuse by name while they are off', async () => {
    expect(FEATURES.hostedPublication).toBe(false);
    expect(FEATURES.bitcoinAnchoring).toBe(false);
    const { engine } = await created();
    await expect(engine.publish()).rejects.toBeInstanceOf(FeatureUnavailableError);
    await expect(engine.inscribe()).rejects.toBeInstanceOf(FeatureUnavailableError);
  });

  test('a signed-in engine needs a subOrg to find its author DID', async () => {
    const engine = new DemoEngine({ authed: true });
    await expect(engine.create('x', 'Orbits', generateArtwork('x', 'Orbits', 1).svg)).rejects.toThrow(/Sign in again/);
  });

  test('with hosted publication on, publishing gives the Original a did:webvh that a stranger can verify through', async () => {
    const { upload, read } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    const engine = new DemoEngine({
      features: { hostedPublication: true },
      publishTarget: { upload, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
    const state = await engine.create('Harbor at dawn', 'Orbits', generateArtwork('Harbor at dawn', 'Orbits', 7).svg);
    const published = await engine.publish();
    expect(published.layer).toBe('did:webvh');
    expect(published.webvhDid).toMatch(/^did:webvh:/);
    expect(published.webvhLogUrl).toBe(`https://${DOMAIN}/${userWebvhSlug(SUB)}/${published.webvhDid!.split(':').pop()}/did.jsonl`);
    expect(published.history.length).toBe(state.history.length + 1);
    // A retry appends nothing and keeps the alias (P9.2).
    const again = await engine.publish();
    expect(again.history.length).toBe(published.history.length);
    expect(again.webvhDid).toBe(published.webvhDid);
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const r = await stranger.loadPublished(published.webvhDid!, read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.original).toBe(state.did);
  });

  test('an upload that fails after the publish entry is retried under the same alias', async () => {
    const { upload, read } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    let signed = 0;
    const sign = aliasSigner.sign.bind(aliasSigner);
    aliasSigner.sign = (input) => (signed++, sign(input));
    let failing = true;
    const flaky = { put: (key: string, data: Uint8Array | string, o?: { contentType?: string }) => (failing ? Promise.reject(new Error('network down')) : upload.put(key, data, o)) };
    const engine = new DemoEngine({
      features: { hostedPublication: true },
      publishTarget: { upload: flaky, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
    const state = await engine.create('Harbor at dawn', 'Orbits', generateArtwork('Harbor at dawn', 'Orbits', 7).svg);
    await expect(engine.publish()).rejects.toThrow(/network down/);
    failing = false;
    const published = await engine.publish();
    expect(published.history.length).toBe(state.history.length + 1);
    expect(signed).toBe(1); // the alias was built once and reused
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    expect((await stranger.loadPublished(published.webvhDid!, read)).verified).toBe(true);
  });

  test('once published, a revision is saved through the host: the hosted snapshot moves to it (P6.7)', async () => {
    const { upload, read } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    const engine = new DemoEngine({
      features: { hostedPublication: true },
      publishTarget: { upload, read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
    await engine.create('Harbor at dawn', 'Orbits', generateArtwork('Harbor at dawn', 'Orbits', 7).svg);
    const published = await engine.publish();
    const revised = await engine.update('Harbor at dusk', 'Orbits', generateArtwork('Harbor at dusk', 'Orbits', 8).svg);
    expect(revised.history.length).toBe(published.history.length + 1);
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const r = await stranger.loadPublished(published.webvhDid!, read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(revised.history.at(-1)!.versionId);
    expect(r.report.state?.name).toBe('Harbor at dusk');
  });

  test('a new Original does not inherit the previous Original\'s alias', async () => {
    const { upload } = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    const engine = new DemoEngine({
      features: { hostedPublication: true },
      publishTarget: { upload, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
    await engine.create('First', 'Orbits', generateArtwork('First', 'Orbits', 1).svg);
    const first = await engine.publish();
    const second = await engine.create('Second', 'Orbits', generateArtwork('Second', 'Orbits', 2).svg);
    const published = await engine.publish();
    expect(published.webvhDid).not.toBe(first.webvhDid);
    expect(published.webvhDid).toContain(second.did.slice('did:vh:'.length, 'did:vh:'.length + 16));
  });
});

describe('DemoEngine shared-host saves after a lost answer or a refusal (P6.4, P6.8)', () => {
  async function publishedEngine(lossy: { drop: boolean }) {
    const h = host();
    const secret = ed.utils.randomSecretKey();
    const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
    // The host takes the save, but the answer can be lost on the way back.
    const upload = Object.assign(Object.create(Object.getPrototypeOf(h.upload)), h.upload, {
      submit: async (key: string, body: string) => {
        const answer = await h.upload.submit(key, body);
        if (lossy.drop) {
          lossy.drop = false;
          throw new TypeError('network connection lost');
        }
        return answer;
      },
    });
    const engine = new DemoEngine({
      features: { hostedPublication: true },
      publishTarget: { upload, read: h.read, domain: DOMAIN, slug: userWebvhSlug(SUB), aliasSigner: async () => aliasSigner },
    });
    await engine.create('Harbor at dawn', 'Orbits', generateArtwork('Harbor at dawn', 'Orbits', 7).svg);
    const published = await engine.publish();
    return { h, engine, published };
  }

  test('C12-128: a save whose answer was lost is retried with the same signed candidate, not a new one', async () => {
    const lossy = { drop: true };
    const { h, engine, published } = await publishedEngine(lossy);
    const dusk = generateArtwork('Harbor at dusk', 'Orbits', 8).svg;
    await expect(engine.update('Harbor at dusk', 'Orbits', dusk)).rejects.toThrow('network connection lost');
    // The user saves again: the kept candidate is sent byte for byte and recognised; no refusal, no second entry.
    const revised = await engine.update('Harbor at dusk', 'Orbits', dusk);
    expect(revised.history.length).toBe(published.history.length + 1);
    const r = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(published.webvhDid!, h.read);
    expect(r.report.head).toBe(revised.history.at(-1)!.versionId);
  });

  test('C12-126: after a refusal the engine syncs the host\'s head and reconciles the change against it, never merging', async () => {
    const { h, engine, published } = await publishedEngine({ drop: false });
    // Another device of the same author, signed in to the same account (one email is one landing account), saves first.
    const internals = engine as unknown as { sdk: OriginalsSDK; did: string; author(): Promise<{ ref: never; signer: never }>; authoring: { evidence: never } };
    const { ref, signer } = await internals.author();
    const other = OriginalsSDK.create({ store: new MemoryStore(), authors: [internals.authoring.evidence] });
    await other.import((await internals.sdk.package(internals.did)).bytes);
    const otherHost = landingSharedHost({ sdk: other, aliasDid: published.webvhDid!, transport: h.adapterFor(SUB), read: h.read });
    const first = await other.sign(await other.prepareEdit(internals.did, { parent: (await other.get(internals.did)).checkpoint, name: 'Harbor at noon', author: ref }), signer);
    expect((await other.submit(first, otherHost)).status).toBe('accepted');
    const refusal = await engine.update('Harbor at dusk', 'Orbits', generateArtwork('Harbor at dusk', 'Orbits', 8).svg).then(() => undefined, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(StaleSaveError);
    const synced = await engine.syncWithHost();
    expect(synced.history.at(-1)!.versionId).toBe(first.versionId);
    const reconciled = await engine.reconcile((refusal as StaleSaveError).refused, 'Harbor at dusk', 'Orbits', generateArtwork('Harbor at dusk', 'Orbits', 8).svg);
    expect(reconciled.history.length).toBe(synced.history.length + 1);
    const r = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(published.webvhDid!, h.read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.head).toBe(reconciled.history.at(-1)!.versionId);
    expect(r.report.state?.name).toBe('Harbor at dusk');
  });
});
