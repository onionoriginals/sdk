/**
 * #598 — publication must not silently strand authoring capability.
 *
 * An anonymous session's authoring key previously lived only in an in-memory
 * field: a page reload generated a brand-new, unrelated key, so an update
 * after reload signed with the wrong controller and the SDK correctly (but
 * silently, from the visitor's perspective) refused it. These pin the fix:
 * durable (webvh) publication now backs the key up before the first hosting
 * write, a same-browser reload restores it transparently, and a browser with
 * no local storage is refused up front rather than losing the key silently.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { createLocalSigner } from '@originals/sdk';
import { DemoEngine } from './engine';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';
import { anonymousAuthorshipStorageKey } from './anonymous-authorship-backup';
import { encryptAuthorshipKey } from './key-backup';

describe('anonymous authorship custody survives a reload (#598)', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());

  test('a browser with no local storage is refused before any hosting write', async () => {
    host = installCel3Host();
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    // @ts-expect-error deliberately removing the polyfill this test relies on elsewhere
    delete globalThis.localStorage;
    try {
      const engine = new DemoEngine();
      await engine.create('Title', 'Upload', 'bytes');
      await expect(engine.publish()).rejects.toThrow(/local storage/i);
      expect(host.writes).toEqual([]);
    } finally {
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    }
  });

  test('an anonymous create → publish → reload → hydrate → update round-trips through the SAME controller', async () => {
    host = installCel3Host();
    const engine = new DemoEngine();
    await engine.create('Original', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg" id="v1"></svg>');
    const published = await engine.publish();
    const genesisProof = engine.asset!.celLog.log[0].proof;
    const genesisController = (Array.isArray(genesisProof) ? genesisProof[0] : genesisProof).verificationMethod.split('#')[0];

    // A reload: a fresh engine instance, this browser's storage untouched.
    const cold = new DemoEngine();
    const hydrated = await cold.hydrateFromWeb(published.webvhDid!);
    expect(hydrated.did).toBe(published.did);

    const updated = await cold.update('Renamed', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg" id="v2"></svg>');
    expect(updated.resource.version).toBe(2);

    const latestEvent = cold.asset!.celLog.log.at(-1)!;
    const latestProof = Array.isArray(latestEvent.proof) ? latestEvent.proof[0] : latestEvent.proof;
    expect(latestProof.verificationMethod.split('#')[0]).toBe(genesisController);

    const verified = await cold.asset!.verify();
    expect(typeof verified === 'boolean' ? verified : (verified as { verified?: boolean }).verified).toBe(true);
  });

  test('an externally-held signer (e.g. injected by a caller) needs no local backup', async () => {
    host = installCel3Host();
    const { engine } = engineWithSigner();
    await engine.create('Original', 'Upload', 'bytes');
    const state = await engine.publish();
    expect(state.webvhDid).toContain(':published:anonymous:');
  });

  test('signed-in publication survives a fresh engine/session and keeps editing', async () => {
    host = installCel3Host('sub-1');
    const signer = createLocalSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    Object.assign(engine, { authorshipSigner: signer });
    await engine.create('Durable', 'Upload', 'bytes');
    const published = await engine.publish();

    // A fresh process/session that restores the SAME account controller —
    // exactly what signing in again does in production.
    const cold = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    Object.assign(cold, { authorshipSigner: signer });
    await cold.hydrateFromWeb(published.webvhDid!);
    const updated = await cold.update('Durable, revised', 'Upload', 'more bytes');
    expect(updated.resource.version).toBe(2);
    const latestEvent = cold.asset!.celLog.log.at(-1)!;
    const latestProof = Array.isArray(latestEvent.proof) ? latestEvent.proof[0] : latestEvent.proof;
    expect(latestProof.verificationMethod.split('#')[0]).toBe(signer.controller);
  });
});

describe('explicit encrypted authorship key backup/restore (#598)', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());

  test('export then restore reconstructs the same controller and keeps editing after publish', async () => {
    host = installCel3Host();
    const engine = new DemoEngine();
    await engine.create('Original', 'Upload', 'bytes');
    const backup = await engine.exportAuthorshipKeyBackup('a strong passphrase');
    const published = await engine.publish();

    const cold = new DemoEngine();
    const signer = await cold.restoreAuthorshipFromBackup(backup, 'a strong passphrase');
    expect(signer.controller).toBe(backup.controller);

    await cold.hydrateFromWeb(published.webvhDid!);
    const updated = await cold.update('Renamed', 'Upload', 'more bytes');
    expect(updated.resource.version).toBe(2);
  });

  test('restoring with the wrong passphrase fails clearly instead of producing a mismatched key', async () => {
    host = installCel3Host();
    const engine = new DemoEngine();
    await engine.create('Original', 'Upload', 'bytes');
    const backup = await engine.exportAuthorshipKeyBackup('correct horse battery staple');

    const cold = new DemoEngine();
    await expect(cold.restoreAuthorshipFromBackup(backup, 'wrong passphrase')).rejects.toThrow(/wrong|corrupted/i);
  });

  test('a backup does not silently accept ciphertext re-encrypted under a different controller', async () => {
    host = installCel3Host();
    const foreignSecret = crypto.getRandomValues(new Uint8Array(32));
    const foreignController = createLocalSigner('Ed25519', foreignSecret).controller;
    const tampered = await encryptAuthorshipKey(crypto.getRandomValues(new Uint8Array(32)), foreignController, 'a strong passphrase');
    // Tamper the claimed controller so it no longer matches the decrypted key.
    const forged = { ...tampered, controller: 'did:key:zNotTheRealController' };
    const engine = new DemoEngine();
    await expect(engine.restoreAuthorshipFromBackup(forged, 'a strong passphrase')).rejects.toThrow(/does not match/i);
  });

  test('signed-in sessions have no local key to back up', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    Object.assign(engine, { authorshipSigner: createLocalSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32))) });
    await expect(engine.exportAuthorshipKeyBackup('a strong passphrase')).rejects.toThrow(/already held by your account/i);
  });
});

describe('the transparent local backup this browser writes on publish', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());

  test('is keyed by asset id and never stores the raw secret key bytes', async () => {
    host = installCel3Host();
    const engine = new DemoEngine();
    const state = await engine.create('Original', 'Upload', 'bytes');
    await engine.publish();

    const raw = localStorage.getItem(anonymousAuthorshipStorageKey(state.did));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.backup.ciphertextBase64).toBeTruthy();
    expect(JSON.stringify(parsed)).not.toContain('"secretKey"');
  });
});
