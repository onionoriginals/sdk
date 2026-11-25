import { describe, expect, test } from 'bun:test';
import { resolveVidKeys } from '@originals/tsp';
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
  test('create and update publish Multikey TSP VID material', async () => {
    const manager = new WebVHManager();
    const transport = 'https://issuer.example/tsp/inbox';
    const created = await manager.createDIDWebVH({ domain: 'example.com', tsp: { transport } });
    expect(created.tspEncryption?.encryptionPrivateMultibase).toMatch(/^z/);
    assertSdkDidDocumentHasNoJwk(created.didDocument as Record<string, unknown>);

    const resolved = await resolveFromLog(created.log);
    const keys = resolveVidKeys(resolved);
    expect(keys.transport).toBe(transport);
    expect(keys.id).toBe(created.did);

    const local = localVidFromWebVhKeys(
      created.did,
      transport,
      created.keyPair!.privateKey,
      created.tspEncryption!.encryptionPrivateMultibase,
    );
    expect(local.signingPublicKey.length).toBe(32);

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: {},
      signer: created.keyPair!,
      tsp: { transport: 'https://issuer.example/tsp/inbox-v2' },
    });
    assertSdkDidDocumentHasNoJwk(updated.didDocument as Record<string, unknown>);
    const resolved2 = await resolveFromLog(updated.log);
    expect(resolveVidKeys(resolved2).transport).toBe('https://issuer.example/tsp/inbox-v2');
  }, 30000);
});