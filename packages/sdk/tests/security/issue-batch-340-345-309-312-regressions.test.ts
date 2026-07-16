/**
 * Security regressions for the 2026-07 issue batch:
 *
 * - #340: Verifier.verifyCredentialMultiSig bypassed validity-period and
 *   revocation checks — expired/revoked multi-sig credentials verified valid.
 * - #345: CredentialManager.checkRevocationStatus/isRevoked consulted an
 *   attacker-suppliable status list with no id binding at all.
 * - #309: signCredential's fail-closed refusal depended on error-message
 *   string matching; it now keys on typed StructuredError codes.
 * - #312: the BTCO_NETWORK_MISMATCH guard ran after the cache lookup, so a
 *   shared persistent DID cache could serve cross-network documents.
 * - #351: quote-only fee estimation bypassed the MAX_REASONABLE_FEE_RATE cap,
 *   letting a compromised estimator show users absurd quotes.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { Verifier } from '../../src/vc/Verifier';
import { Issuer, isSecuritySigningRefusal } from '../../src/vc/Issuer';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';
import { OriginalsSDK } from '../../src';
import { StructuredError } from '../../src/utils/telemetry';
import { MockOrdinalsProvider } from '../mocks/adapters';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import type { MultiSigPolicy, VerifiableCredential } from '../../src/types';

const did = 'did:peer:batch-issuer';
const sk = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
const pk = ed25519.getPublicKey(sk);
const vm = {
  id: `${did}#keys-1`,
  controller: did,
  type: 'Multikey',
  publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
  secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
};

const didManager = new DIDManager({} as never);

beforeEach(() => {
  registerVerificationMethod(vm);
});

async function issueSigned(extra: Record<string, unknown> = {}): Promise<VerifiableCredential> {
  const issuer = new Issuer(didManager, vm);
  return issuer.issueCredential(
    {
      type: ['VerifiableCredential', 'Test'],
      issuer: did,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject1' },
      ...extra
    } as never,
    { proofPurpose: 'assertionMethod' }
  );
}

function policyFor(vc: VerifiableCredential): MultiSigPolicy {
  const proof = Array.isArray(vc.proof) ? vc.proof[0] : vc.proof;
  return {
    required: 1,
    total: 1,
    signerVerificationMethods: [(proof as { verificationMethod: string }).verificationMethod]
  } as MultiSigPolicy;
}

describe('#340 — Verifier.verifyCredentialMultiSig enforces validity and revocation', () => {
  test('an expired credential with a valid m-of-n proof set does NOT verify', async () => {
    const vc = await issueSigned({ expirationDate: new Date(Date.now() - 60_000).toISOString() });
    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(vc, policyFor(vc));
    expect(result.validSignatures).toBe(1); // the signature itself is genuine
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /expired/i.test(e))).toBe(true);
  });

  test('a not-yet-valid credential does NOT verify', async () => {
    const vc = await issueSigned({ validFrom: new Date(Date.now() + 3_600_000).toISOString() });
    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(vc, policyFor(vc));
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /not yet valid/i.test(e))).toBe(true);
  });

  test('a declared BitstringStatusListEntry fails closed without a statusListResolver', async () => {
    const vc = await issueSigned({
      credentialStatus: {
        id: 'https://example.com/status/1#0',
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: '0',
        statusListCredential: 'https://example.com/status/1'
      }
    });
    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(vc, policyFor(vc));
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /statusListResolver/.test(e))).toBe(true);
  });

  test('baseline: a currently-valid credential without status still verifies', async () => {
    const vc = await issueSigned();
    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(vc, policyFor(vc));
    expect(result.verified).toBe(true);
  });
});

describe('#345 — low-level revocation helpers bind the supplied list', () => {
  test('checkRevocationStatus rejects a status list whose id differs from the credential reference', () => {
    const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
    const entry = sdk.statusList.allocateStatusEntry('https://issuer.example/status/1', 3, 'revocation');
    const credential = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer: did,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject1' },
      credentialStatus: entry
    } as unknown as VerifiableCredential;

    // Attacker-supplied all-zeros list published under a DIFFERENT id.
    const fabricated = sdk.statusList.createStatusListCredential({
      id: 'https://attacker.example/status/other',
      issuer: did,
      statusPurpose: 'revocation'
    });

    expect(() => sdk.credentials.checkRevocationStatus(credential, fabricated))
      .toThrow(/does not match the credential's statusListCredential reference/);
    expect(() => sdk.credentials.isRevoked(credential, fabricated))
      .toThrow(/does not match the credential's statusListCredential reference/);
  });
});

describe('#309 — fail-closed signing refusal keys on typed error codes', () => {
  test('typed codes are security refusals regardless of message wording', () => {
    expect(isSecuritySigningRefusal(new StructuredError('ISSUER_BINDING_MISMATCH', 'nope'))).toBe(true);
    expect(isSecuritySigningRefusal(new StructuredError('VM_RETIRED', 'nope'))).toBe(true);
    // Non-security errors still fall through to the legacy signer path.
    expect(isSecuritySigningRefusal(new Error('DID not resolved: did:peer:x'))).toBe(false);
    expect(isSecuritySigningRefusal(new StructuredError('SOME_OTHER_CODE', 'nope'))).toBe(false);
  });

  test('legacy message patterns still refuse (defense in depth)', () => {
    expect(isSecuritySigningRefusal(new Error('Issuer DID (a) does not match the verification method controller (b)'))).toBe(true);
    expect(isSecuritySigningRefusal(new Error('Verification method is retired (revoked or compromised): x'))).toBe(true);
  });

  test('Issuer throws the typed ISSUER_BINDING_MISMATCH code on impersonation', async () => {
    const issuer = new Issuer(didManager, vm);
    const err = await issuer.issueCredential(
      {
        type: ['VerifiableCredential'],
        issuer: 'did:peer:victim',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as never,
      { proofPurpose: 'assertionMethod' }
    ).then(() => null, (e) => e as StructuredError);
    expect(err).not.toBeNull();
    expect(err!.code).toBe('ISSUER_BINDING_MISMATCH');
  });
});

describe('#312 — cross-network did:btco documents cannot be served from cache', () => {
  test('a cached regtest DID still trips BTCO_NETWORK_MISMATCH on a mainnet-configured SDK', async () => {
    const dm = new DIDManager({
      network: 'mainnet',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new MockOrdinalsProvider()
    } as never);

    // Simulate a shared persistent cache already holding the cross-network
    // document (e.g. populated by a regtest-configured sibling instance).
    const crossNetworkDid = 'did:btco:reg:123';
    await (dm as unknown as { cache: { set: (d: string, doc: unknown) => Promise<void> } }).cache.set(
      crossNetworkDid,
      { '@context': ['https://www.w3.org/ns/did/v1'], id: crossNetworkDid }
    );

    const err = await dm.resolveDID(crossNetworkDid).then(() => null, (e) => e as StructuredError);
    expect(err).not.toBeNull();
    expect(err!.code).toBe('BTCO_NETWORK_MISMATCH');
  });
});

describe('#351 — cost quotes apply the MAX_REASONABLE_FEE_RATE cap', () => {
  test('an absurd fee-oracle estimate is ignored for estimateCost quotes', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      storageAdapter: new MemoryStorageAdapter(),
      ordinalsProvider: new MockOrdinalsProvider(),
      feeOracle: { estimateFeeRate: async () => 5_000_000 } // compromised estimator
    } as never);
    const asset = await sdk.lifecycle.createAsset([
      {
        id: 'res1',
        type: 'text',
        content: 'hello world',
        contentType: 'text/plain',
        hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
      }
    ]);

    const estimate = await sdk.lifecycle.estimateCost(asset, 'did:btco');
    // The absurd oracle rate is skipped; the quote falls through to the next
    // source (mock provider) or the conservative default — never 5M sat/vB.
    expect(estimate.feeRate).toBeLessThanOrEqual(10_000);
  });
});
