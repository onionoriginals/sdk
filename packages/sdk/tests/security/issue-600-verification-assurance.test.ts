/**
 * Security regression tests for issue #600: verification entry points that
 * returned a green boolean while silently skipping a security-relevant check
 * (status, chain freshness) instead of reporting it as unknown/failed.
 *
 * Two entry points are covered:
 *  - `CredentialManager.verifyCredential`, which used to hardcode
 *    `checkStatus: false` — a credential declaring `credentialStatus` verified
 *    on signature alone with no way to tell status was never evaluated.
 *  - `UnifiedVerifier`, whose credential branch did the same, and whose
 *    event-log branch didn't surface whether head-freshness actually ran.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { multikey } from '@originals/cel';
import * as ed from '@noble/ed25519';
import { DIDManager } from '../../src/did/DIDManager';
import { UnifiedVerifier } from '../../src/verify/UnifiedVerifier';

/**
 * did:key signing helper. The verificationMethod MUST be the fragmented
 * `${did}#${multikey}` form (not the bare DID) — signCredential resolves it
 * through the document loader to decide whether to take the Data Integrity
 * (cryptosuite-bearing) path or fall back to the legacy digest path, and the
 * loader's did:key self-certifying synthesis only fires for a fragment
 * lookup. A bare-DID verificationMethod silently falls back to a legacy
 * proof with no `cryptosuite`, which the strict DI-only `Verifier` class
 * (used directly by UnifiedVerifier, and internally for status-list-credential
 * trust checks) rejects as "Unsupported cryptosuite: undefined".
 */
function vmFor(pkMb: string): string {
  return `did:key:${pkMb}#${pkMb}`;
}

async function makeKeyPair() {
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);
  const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
  const pkMb = multikey.encodePublicKey(pk, 'Ed25519');
  const issuer = `did:key:${pkMb}`;
  return { skMb, pkMb, issuer, vm: vmFor(pkMb) };
}

async function makeSignedCredentialWithStatus(
  sdk: OriginalsSDK,
  statusListId: string,
  index: number
) {
  const { skMb, pkMb, issuer, vm } = await makeKeyPair();
  const entry = sdk.statusList.allocateStatusEntry(statusListId, index, 'revocation');
  const unsigned = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:example:subject-600' },
    credentialStatus: entry,
  };
  const signed = await sdk.credentials.signCredential(unsigned as any, skMb, vm);
  return { signed, issuer, skMb, pkMb, vm };
}

async function signStatusList(
  sdk: OriginalsSDK,
  statusListVC: unknown,
  skMb: string,
  vm: string
) {
  return sdk.credentials.signCredential(statusListVC as any, skMb, vm);
}

describe('CredentialManager.verifyCredential is safe by default (issue #600)', () => {
  test('fails closed on a declared credentialStatus when no statusListResolver is configured', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const { signed } = await makeSignedCredentialWithStatus(sdk, 'https://example.com/status/600/1', 5);

    // Before the fix, verifyCredential hardcoded checkStatus:false: a
    // credential that merely DECLARES a status entry — revoked or not —
    // verified as true with no way to tell status was never checked.
    expect(sdk.credentials.statusListResolver).toBeUndefined();
    expect(await sdk.credentials.verifyCredential(signed)).toBe(false);
  });

  test('a credential with no credentialStatus is unaffected (still verifies on signature alone)', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const { skMb, issuer, vm } = await makeKeyPair();
    const unsigned = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:subject-600b' },
    };
    const signed = await sdk.credentials.signCredential(unsigned as any, skMb, vm);
    expect(await sdk.credentials.verifyCredential(signed)).toBe(true);
  });

  test('checks status and passes once a statusListResolver reports the credential is not revoked', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/2';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 1);
    const unsignedList = sdk.statusList.createStatusListCredential({
      id: listId,
      issuer,
      statusPurpose: 'revocation',
    });
    const statusListVC = await signStatusList(sdk, unsignedList, skMb, vm);

    let resolverCalls = 0;
    sdk.credentials.statusListResolver = async (url) => {
      resolverCalls++;
      return url === listId ? statusListVC : null;
    };

    expect(await sdk.credentials.verifyCredential(signed)).toBe(true);
    expect(resolverCalls).toBeGreaterThan(0);
  });

  test('checks status and fails once the resolved status list reports revocation', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/3';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 2);
    const unsignedList = sdk.statusList.createStatusListCredential({
      id: listId,
      issuer,
      statusPurpose: 'revocation',
    });
    const revokedList = sdk.statusList.setStatus(unsignedList, 2, true);
    const statusListVC = await signStatusList(sdk, revokedList, skMb, vm);
    sdk.credentials.statusListResolver = async () => statusListVC;

    expect(await sdk.credentials.verifyCredential(signed)).toBe(false);
  });

  test('verifyCredentialSignature is explicitly signature-only: it ignores a declared credentialStatus', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/4';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 3);
    const unsignedList = sdk.statusList.createStatusListCredential({ id: listId, issuer, statusPurpose: 'revocation' });
    const revokedList = sdk.statusList.setStatus(unsignedList, 3, true);
    const statusListVC = await signStatusList(sdk, revokedList, skMb, vm);
    sdk.credentials.statusListResolver = async () => statusListVC;

    // Same credential, same (revoked) resolver state: the safe default fails,
    // but the explicitly-named signature-only entry point does not — because
    // it never looks at status at all.
    expect(await sdk.credentials.verifyCredential(signed)).toBe(false);
    expect(await sdk.credentials.verifyCredentialSignature(signed)).toBe(true);
  });

  test('verifyCredentialWithStatus (caller-supplied list) is unaffected by the manager statusListResolver default', async () => {
    // Regression guard: verifyCredentialWithStatus must keep checking
    // signature via verifyCredentialSignature internally, not the new
    // status-checking-by-default verifyCredential — otherwise it would
    // double-evaluate status (once via its own explicit statusListCredential
    // argument, once via a manager-configured resolver) and could fail
    // closed for the wrong reason.
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/5';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 4);
    const unsignedList = sdk.statusList.createStatusListCredential({ id: listId, issuer, statusPurpose: 'revocation' });
    const statusListVC = await signStatusList(sdk, unsignedList, skMb, vm);

    // No manager-level resolver configured — verifyCredentialWithStatus must
    // still work purely off its own caller-supplied statusListCredential.
    expect(sdk.credentials.statusListResolver).toBeUndefined();
    const result = await sdk.credentials.verifyCredentialWithStatus(signed, statusListVC);
    expect(result.verified).toBe(true);
    expect(result.revoked).toBe(false);
  });
});

describe('UnifiedVerifier reports what it actually checked (issue #600)', () => {
  const didManager = new DIDManager({} as never);

  test('a credential with no declared status: assurance.status is "checked" (vacuously)', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const { skMb, issuer, vm } = await makeKeyPair();
    const signed = await sdk.credentials.signCredential(
      {
        '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
        type: ['VerifiableCredential'],
        issuer,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject-600c' },
      } as any,
      skMb,
      vm
    );

    const unified = new UnifiedVerifier(didManager);
    const res = await unified.verify(signed);
    expect(res.verified).toBe(true);
    expect(res.assurance).toEqual({ signature: 'checked', status: 'checked' });
  });

  test('a credential declaring credentialStatus with no statusListResolver: unknown, and fails closed', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const { signed } = await makeSignedCredentialWithStatus(sdk, 'https://example.com/status/600/6', 0);

    const unified = new UnifiedVerifier(didManager);
    const res = await unified.verify(signed);
    expect(res.assurance.signature).toBe('checked');
    expect(res.assurance.status).toBe('unknown');
    // Unknown must never read as a pass: verified still fails closed.
    expect(res.verified).toBe(false);
    expect(res.errors.join(' ')).toMatch(/statusListResolver/i);
  });

  test('signatureOnly explicitly opts out of status checking, and reports it as unknown rather than checked', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/7';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 1);
    const unsignedList = sdk.statusList.createStatusListCredential({ id: listId, issuer, statusPurpose: 'revocation' });
    const revokedList = sdk.statusList.setStatus(unsignedList, 1, true);
    const statusListVC = await signStatusList(sdk, revokedList, skMb, vm);

    const unified = new UnifiedVerifier(didManager, {
      statusListResolver: async () => statusListVC,
      signatureOnly: true,
    });
    const res = await unified.verify(signed);
    // A resolver IS configured and WOULD report revoked, but signatureOnly
    // means it is deliberately not consulted — signature-only verification
    // must not silently inherit the revoked verdict, but it also must not
    // silently claim the credential is good on the status dimension.
    expect(res.verified).toBe(true);
    expect(res.assurance).toEqual({ signature: 'checked', status: 'unknown' });
  });

  test('the same declared-revoked credential fails once a statusListResolver is actually configured', async () => {
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), defaultKeyType: 'Ed25519' });
    const listId = 'https://example.com/status/600/8';
    const { signed, issuer, skMb, vm } = await makeSignedCredentialWithStatus(sdk, listId, 6);
    const unsignedList = sdk.statusList.createStatusListCredential({ id: listId, issuer, statusPurpose: 'revocation' });
    const revokedList = sdk.statusList.setStatus(unsignedList, 6, true);
    const statusListVC = await signStatusList(sdk, revokedList, skMb, vm);

    const unified = new UnifiedVerifier(didManager, { statusListResolver: async () => statusListVC });
    const res = await unified.verify(signed);
    expect(res.assurance).toEqual({ signature: 'checked', status: 'failed' });
    expect(res.verified).toBe(false);
  });

  test('an event log with no ordinalsProvider reports freshness as unknown, not silently checked', async () => {
    const unified = new UnifiedVerifier(didManager);
    // Structurally-minimal event log with no witness proof: routing/assurance
    // reporting is what's asserted here, not chain-proof validity.
    const res = await unified.verify({ events: [] } as any);
    expect(res.kind).toBe('eventLog');
    expect(res.assurance.freshness).toBe('unknown');
  });
});
