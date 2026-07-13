import { describe, test, expect } from 'bun:test';
import { celSignerFromKeyPair, createKeyStoreCelSigner, hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';
import { KeyManager } from '../../../src/did/KeyManager';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

describe('CEL signer adapter', () => {
  test('keypair variant produces a log verifyEventLog accepts as did:cel', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');
    const { signer, controller, verificationMethod } = celSignerFromKeyPair(kp);
    expect(controller.startsWith('did:key:z')).toBe(true);
    expect(verificationMethod).toBe(`${controller}#${controller.slice('did:key:'.length)}`);
    const log = await createEventLog(
      { name: 'A', controller, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u0001' },
      { signer, verificationMethod }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
  });

  test('keyStore variant signs identically and reads lazily', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');
    const { controller, verificationMethod } = celSignerFromKeyPair(kp);
    const store = new Map<string, string>();
    const keyStore = {
      getPrivateKey: async (vm: string) => store.get(vm) ?? null,
      setPrivateKey: async (vm: string, k: string) => { store.set(vm, k); }
    };
    const signer = createKeyStoreCelSigner(keyStore, verificationMethod);
    await expect(signer({ type: 'create', data: {} })).rejects.toThrow(/not found|KEYSTORE/i); // lazy: key absent yet
    await keyStore.setPrivateKey(verificationMethod, kp.privateKey);
    const log = await createEventLog(
      { name: 'B', controller, resources: [], createdAt: 'x', nonce: 'u0002' },
      { signer, verificationMethod }
    );
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('rejects non-Ed25519 keys', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('ES256K');
    expect(() => celSignerFromKeyPair(kp)).toThrow(/CEL_ED25519_REQUIRED|Ed25519/);
  });

  test('hexSha256ToDigestMultibase matches computeDigestMultibase', () => {
    const bytes = new TextEncoder().encode('hello');
    const hex = bytesToHex(sha256(bytes));
    expect(hexSha256ToDigestMultibase(hex)).toBe(computeDigestMultibase(bytes));
  });
});
