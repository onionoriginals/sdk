import { describe, expect, test } from 'bun:test';
import { resolveVidKeys, webvhTspInboxUrl } from '@originals/tsp';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { assertSdkDidDocumentHasNoJwk, localVidFromWebVhKeys } from '../../../src/tsp/index.js';

async function resolveFromLog(log: unknown) {
  const mod = await import('didwebvh-ts') as unknown as {
    resolveDIDFromLog: (
      log: unknown,
      options?: Record<string, unknown>,
    ) => Promise<{ didDocument: Record<string, unknown> | null; didResolutionMetadata: { error?: string } }>;
  };
  const { Ed25519Verifier } = await import('../../../src/did/Ed25519Verifier');
  const resolved = await mod.resolveDIDFromLog(log, { verifier: new Ed25519Verifier() });
  expect(resolved.didResolutionMetadata.error).toBeUndefined();
  return resolved.didDocument!;
}

describe('did:webvh TSP wiring', () => {
  test('default inbox URL and override transport', async () => {
    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com', tsp: true });
    const expected = webvhTspInboxUrl(created.did);
    expect(created.tspEncryption?.encryptionPrivateMultibase).toMatch(/^z/);
    assertSdkDidDocumentHasNoJwk(created.didDocument as Record<string, unknown>);

    const resolved = await resolveFromLog(created.log);
    expect(resolveVidKeys(resolved).transport).toBe(expected);

    const override = 'https://issuer.example/tsp/inbox-v2';
    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: {},
      signer: created.keyPair!,
      tsp: { transport: override },
    });
    expect(resolveVidKeys(await resolveFromLog(updated.log)).transport).toBe(override);

    const local = localVidFromWebVhKeys(
      created.did,
      expected,
      created.keyPair!.privateKey,
      created.tspEncryption!.encryptionPrivateMultibase,
    );
    expect(local.signingPublicKey.length).toBe(32);
  }, 30000);
});