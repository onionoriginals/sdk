/**
 * didwebvh-ts 3 takes the complete DID document; webvh-document.ts rebuilds it
 * from the SDK's option fields with the 2.8.0 rules. The parity tests replay
 * the inputs behind the independent 2.8.0 fixture through didwebvh-ts 3 and
 * require the identical genesis entry, SCID included (Ed25519 is
 * deterministic), so DIDs the SDK mints keep the shape they had under 2.8.0.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { createDID, deriveNextKeyHash, prepareDataForSigning, resolveDIDFromLog } from 'didwebvh-ts';
import { buildWebVHCreateDocument, buildWebVHUpdateDocument } from '../../../src/did/webvh-document';
import { createDIDOriginal } from '../../../src/did/identity-operations';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../vh/tests/fixtures/didwebvh-ts-2.8.0.json', import.meta.url), 'utf8')
) as { logA: Array<Record<string, unknown>>; logC: Array<Record<string, unknown>>; witnessA: unknown[] };

const key = (seed: number) => {
  const sk = new Uint8Array(32).fill(seed);
  return { sk, multikey: 'z' + base58.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(sk)])) };
};
const k1 = key(11);
const k2 = key(12);
const orig = key(21);
const signer = {
  getVerificationMethodId: () => `did:key:${k1.multikey}#${k1.multikey}`,
  async sign({ document, proof }: { document: unknown; proof: unknown }) {
    const data = await prepareDataForSigning(document as never, proof as never);
    return { proofValue: 'z' + base58.encode(ed25519.sign(data, k1.sk)) };
  },
};
const verifier = { verify: async (s: Uint8Array, m: Uint8Array, p: Uint8Array) => ed25519.verify(s, m, p) };
// The verification method gen-webvh.mjs passed to didwebvh-ts 2.8.0.
const fixtureMethods = () => [{ type: 'Multikey', publicKeyMultibase: orig.multikey, purpose: 'assertionMethod' as const }];

describe('buildWebVHCreateDocument reproduces didwebvh-ts 2.8.0 documents', () => {
  test('a pre-rotation genesis entry is identical to the 2.8.0 fixture, SCID included', async () => {
    const created = await createDID({
      address: 'example.com', signer, verifier, updateKeys: [k1.multikey],
      nextKeyHashes: [await deriveNextKeyHash(k2.multikey)],
      didDocument: buildWebVHCreateDocument({ verificationMethods: fixtureMethods() }) as never,
      created: '2026-10-18T12:00:01Z',
    });
    expect(created.log[0]).toEqual(fixture.logA[0] as never);
  });

  test('a plain genesis entry is identical to the 2.8.0 fixture', async () => {
    const created = await createDID({
      address: 'example.org', signer, verifier, updateKeys: [k1.multikey],
      didDocument: buildWebVHCreateDocument({ verificationMethods: fixtureMethods() }) as never,
      created: '2026-10-18T12:00:01Z',
    });
    expect(created.log[0]).toEqual(fixture.logC[0] as never);
  });

  test('explicit relationships, services and alsoKnownAs replace the derived ones', () => {
    const doc = buildWebVHCreateDocument({
      verificationMethods: [{ id: '#key-0', type: 'Multikey', publicKeyMultibase: orig.multikey }],
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
      services: [{ id: '#s', type: 'LinkedDomains', serviceEndpoint: 'https://example.com' }],
      alsoKnownAs: ['did:peer:abc'],
    });
    expect(doc).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: '{DID}',
      controller: '{DID}',
      verificationMethod: [{ id: '#key-0', type: 'Multikey', controller: '{DID}', publicKeyMultibase: orig.multikey }],
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
      keyAgreement: [],
      capabilityDelegation: [],
      capabilityInvocation: [],
      service: [{ id: '#s', type: 'LinkedDomains', serviceEndpoint: 'https://example.com' }],
      alsoKnownAs: ['did:peer:abc'],
    });
  });

  test('secret key material is stripped before publication', () => {
    const doc = buildWebVHCreateDocument({
      verificationMethods: [{ id: '#key-0', type: 'Multikey', publicKeyMultibase: orig.multikey, secretKeyMultibase: 'zSecret' }],
    });
    expect(JSON.stringify(doc)).not.toContain('zSecret');
  });

  test('verificationMethods are required', () => {
    expect(() => buildWebVHCreateDocument({})).toThrow('verificationMethods must be provided');
  });

  test.each(['', '   '])('a verification method controller of %j is refused at the SDK seam', async (controller) => {
    const run = createDIDOriginal({
      type: 'did', domain: 'example.com', signer: signer as never, verifier, updateKeys: [k1.multikey],
      verificationMethods: [{ id: '#key-0', type: 'Multikey', controller, publicKeyMultibase: orig.multikey }],
    });
    await expect(run).rejects.toMatchObject({ code: 'WEBVH_VERIFICATION_METHOD_CONTROLLER_INVALID' });
  });
});

describe('logs written by didwebvh-ts 2.8.0 still resolve under didwebvh-ts 3', () => {
  test('pre-rotation, rotation and witnessed entries, and a deactivated log', async () => {
    const a = await resolveDIDFromLog(fixture.logA as never, { witnessProofs: fixture.witnessA as never, verifier });
    expect(a.didResolutionMetadata.error).toBeUndefined();
    expect(a.didDocumentMetadata.versionId).toBe(fixture.logA[3].versionId as string);
    const c = await resolveDIDFromLog(fixture.logC as never, { verifier });
    expect(c.didResolutionMetadata.error).toBeUndefined();
    expect(c.didDocumentMetadata.deactivated).toBe(true);
  });
});

describe('buildWebVHUpdateDocument merges onto the previous state with the 2.8.0 rules', () => {
  const previous = fixture.logA[0].state as Record<string, unknown>;

  test('no document field leaves the state to didwebvh-ts', () => {
    expect(buildWebVHUpdateDocument(previous, {})).toBeUndefined();
  });

  test('supplying verificationMethods replaces the methods and all five relationships', () => {
    const doc = buildWebVHUpdateDocument(previous, {
      verificationMethods: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: k2.multikey, purpose: 'keyAgreement' }],
    });
    expect(doc).toMatchObject({
      id: '{DID}',
      controller: '{DID}',
      '@context': previous['@context'],
      verificationMethod: [{ id: '#key-1', type: 'Multikey', controller: '{DID}', publicKeyMultibase: k2.multikey, purpose: 'keyAgreement' }],
      authentication: [],
      assertionMethod: [],
      keyAgreement: ['#key-1'],
      capabilityDelegation: [],
      capabilityInvocation: [],
    });
  });

  test('other fields replace only their property and keep the rest of the state', () => {
    const doc = buildWebVHUpdateDocument(previous, { services: [{ id: '#s', type: 'X', serviceEndpoint: 'https://e' }] })!;
    expect(doc.service).toEqual([{ id: '#s', type: 'X', serviceEndpoint: 'https://e' }]);
    expect(doc.verificationMethod).toEqual(previous.verificationMethod);
    expect(doc.assertionMethod).toEqual(previous.assertionMethod);
  });
});
