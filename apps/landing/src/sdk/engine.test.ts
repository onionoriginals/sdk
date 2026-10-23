import { describe, expect, test } from 'bun:test';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { DemoEngine, FeatureUnavailableError } from './engine';
import { generateArtwork } from './artwork';
import { FEATURES } from './features';
import * as ed from '@noble/ed25519';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { DOMAIN, SUB, host } from './publish.fixture';

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
    expect((state.provenance as { current: boolean }).current).toBe(true);
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
