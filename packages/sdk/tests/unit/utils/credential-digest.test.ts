import { test, expect } from 'bun:test';
import { computeCredentialDigest } from '../../../src/utils/credential-digest';
import { canonicalizeDocument } from '../../../src/utils/serialization';
import { sha256 } from '@noble/hashes/sha2.js';

const credential = {
  '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
  type: ['VerifiableCredential'],
  issuer: 'did:peer:issuer',
  issuanceDate: '2024-01-01T00:00:00Z',
  credentialSubject: { id: 'did:peer:subject', role: 'member' },
};

const proofBase = {
  type: 'DataIntegrityProof',
  created: '2024-01-01T00:00:00Z',
  verificationMethod: 'did:key:zABC',
  proofPurpose: 'assertionMethod',
};

// Replicate the original inlined logic so the helper can't change bytes silently.
async function legacyDigest(cred: any, proof: any): Promise<Uint8Array> {
  const proofSansValue = { ...proof } as Record<string, unknown>;
  delete proofSansValue.proofValue;
  delete proofSansValue.publicKeyMultibase;
  const proofInput: Record<string, unknown> = { ...proofSansValue };
  const ctx = cred['@context'];
  if (ctx && !proofInput['@context']) proofInput['@context'] = ctx;
  const unsigned = { ...cred };
  delete unsigned.proof;
  const c14nProof = await canonicalizeDocument(proofInput);
  const c14nCred = await canonicalizeDocument(unsigned);
  const hProof = sha256(Buffer.from(c14nProof, 'utf8'));
  const hCred = sha256(Buffer.from(c14nCred, 'utf8'));
  const out = new Uint8Array(hProof.length + hCred.length);
  out.set(hProof, 0);
  out.set(hCred, hProof.length);
  return out;
}

test('matches the legacy inlined digest byte-for-byte (golden)', async () => {
  const expected = await legacyDigest(credential, proofBase);
  const actual = await computeCredentialDigest(credential as any, proofBase as any);
  expect(Buffer.from(actual).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
});

test('injects the credential @context into the proof input when missing', async () => {
  const withCtx = await computeCredentialDigest(credential as any, proofBase as any);
  const proofWithCtx = { ...proofBase, '@context': credential['@context'] };
  const explicit = await computeCredentialDigest(credential as any, proofWithCtx as any);
  // Injecting the same context the helper would inject yields the same digest.
  expect(Buffer.from(withCtx).toString('hex')).toBe(Buffer.from(explicit).toString('hex'));
});

test('excludes publicKeyMultibase from the digest (sign/verify parity)', async () => {
  const base = await computeCredentialDigest(credential as any, proofBase as any);
  const withKey = await computeCredentialDigest(credential as any, { ...proofBase, publicKeyMultibase: 'zHINT' } as any);
  expect(Buffer.from(withKey).toString('hex')).toBe(Buffer.from(base).toString('hex'));
});
