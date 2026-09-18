/**
 * Issue #824 — `config.keyStore` was accepted and stored by the default SDK
 * but never read by `sdk.credentials`: `signCredential` required an explicit
 * `privateKeyMultibase` on every call, so a configured keyStore backed
 * nothing. `signCredential`'s `privateKeyMultibase` is now optional: when
 * omitted, the configured `keyStore` is probed for `verificationMethod`'s
 * private key.
 */
import { describe, test, expect } from 'bun:test';
import { multikey, StructuredError } from '@originals/cel';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import type { VerifiableCredential } from '../../../src/types';

const baseConfig = { network: 'mainnet' as const, defaultKeyType: 'Ed25519' as const };

const vc: VerifiableCredential = {
  '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
  type: ['VerifiableCredential'],
  issuer: 'did:ex:issuer',
  issuanceDate: new Date().toISOString(),
  credentialSubject: { id: 'did:ex:subject' } as any,
};

describe('#824 — signCredential falls back to config.keyStore when no key is supplied', () => {
  test('signs using a key found in the configured keyStore', async () => {
    const sk = new Uint8Array(32).fill(7);
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    const vmId = 'did:ex:issuer#key-0';

    const keyStore = new MockKeyStore();
    await keyStore.setPrivateKey(vmId, skMb);

    const dm = new DIDManager({ ...baseConfig, keyStore } as any);
    const cm = new CredentialManager({ ...baseConfig, keyStore } as any, dm);

    const signed = await cm.signCredential(vc, undefined, vmId);
    expect(signed.proof).toBeDefined();
    expect((signed.proof as any).verificationMethod).toBe(vmId);
  });

  test('an explicit privateKeyMultibase still wins over the keyStore', async () => {
    const sk = new Uint8Array(32).fill(7);
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    const otherSk = new Uint8Array(32).fill(9);
    const otherSkMb = multikey.encodePrivateKey(otherSk, 'Ed25519');
    const vmId = 'did:ex:issuer#key-0';

    const keyStore = new MockKeyStore();
    await keyStore.setPrivateKey(vmId, otherSkMb);

    const dm = new DIDManager({ ...baseConfig, keyStore } as any);
    const cm = new CredentialManager({ ...baseConfig, keyStore } as any, dm);

    const signed = await cm.signCredential(vc, skMb, vmId);
    expect(signed.proof).toBeDefined();
  });

  test('throws CREDENTIAL_SIGNING_KEY_REQUIRED when no key is supplied and no keyStore is configured', async () => {
    const dm = new DIDManager({ ...baseConfig } as any);
    const cm = new CredentialManager({ ...baseConfig } as any, dm);

    let thrown: unknown;
    try {
      await cm.signCredential(vc, undefined, 'did:ex:issuer#key-0');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    expect((thrown as StructuredError).code).toBe('CREDENTIAL_SIGNING_KEY_REQUIRED');
  });

  test('throws CREDENTIAL_SIGNING_KEY_REQUIRED when the keyStore has no matching entry', async () => {
    const keyStore = new MockKeyStore();
    const dm = new DIDManager({ ...baseConfig, keyStore } as any);
    const cm = new CredentialManager({ ...baseConfig, keyStore } as any, dm);

    let thrown: unknown;
    try {
      await cm.signCredential(vc, undefined, 'did:ex:issuer#missing');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    expect((thrown as StructuredError).code).toBe('CREDENTIAL_SIGNING_KEY_REQUIRED');
  });

  test('throws CREDENTIAL_VERIFICATION_METHOD_REQUIRED when verificationMethod is omitted', async () => {
    const dm = new DIDManager({ ...baseConfig } as any);
    const cm = new CredentialManager({ ...baseConfig } as any, dm);

    let thrown: unknown;
    try {
      await cm.signCredential(vc, 'zSomeKey' as any, undefined as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    expect((thrown as StructuredError).code).toBe('CREDENTIAL_VERIFICATION_METHOD_REQUIRED');
  });
});
