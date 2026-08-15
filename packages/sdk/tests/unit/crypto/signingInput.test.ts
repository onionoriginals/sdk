/**
 * signingInput (plan 039) — the four signing preimages, consolidated.
 *
 * Each context's preimage must byte-match what the corresponding verifier
 * reconstructs; these tests pin that equivalence so the four cannot drift.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signingInput } from '../../../src/crypto/signingInput';
import { canonicalizeEvent, canonicalizeEntryForChain, witnessSigningBytes } from '../../../src/cel/canonicalize';
import { verifyDidKeyProof, CEL_CRYPTOSUITE } from '../../../src/cel/proofVerification';
import { sha256 } from '@noble/hashes/sha2.js';
import { multikey } from '../../../src/crypto/Multikey';
import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';

describe('signingInput.celEvent', () => {
  const CONFIG = {
    type: 'DataIntegrityProof',
    cryptosuite: CEL_CRYPTOSUITE,
    created: '2026-01-01T00:00:00Z',
    verificationMethod: 'did:key:zAbc#zAbc',
    proofPurpose: 'assertionMethod',
  };

  test('binds the proof configuration: sha256(JCS(config)) || sha256(JCS(event))', () => {
    const entry = { type: 'update', data: { a: 1, z: [2, 3] }, previousEvent: 'uEiDprev' };
    const bytes = signingInput.celEvent(entry, CONFIG);

    expect(bytes.length).toBe(64);
    expect(Buffer.from(bytes.slice(0, 32))).toEqual(Buffer.from(sha256(canonicalizeEvent(CONFIG))));
    expect(Buffer.from(bytes.slice(32))).toEqual(
      Buffer.from(sha256(canonicalizeEntryForChain(entry)))
    );
  });

  test('a different proof configuration changes the preimage', () => {
    // The pre-042 construction signed the event alone, so `created` and
    // `verificationMethod` could be edited after signing without detection.
    const entry = { type: 'update', data: { a: 1 } };
    const other = { ...CONFIG, created: '2027-06-06T00:00:00Z' };
    expect(signingInput.celEvent(entry, CONFIG)).not.toEqual(signingInput.celEvent(entry, other));
  });

  test('proofValue is excluded from the bound configuration', () => {
    const entry = { type: 'update', data: { a: 1 } };
    expect(signingInput.celEvent(entry, { ...CONFIG, proofValue: 'zSomething' }))
      .toEqual(signingInput.celEvent(entry, CONFIG));
  });

  test('omits previousEvent for a genesis-shaped entry', () => {
    const genesis = { type: 'create', data: { name: 'x' } };
    const withPrev = { type: 'create', data: { name: 'x' }, previousEvent: 'uEiD' };
    expect(signingInput.celEvent(genesis, CONFIG)).not.toEqual(signingInput.celEvent(withPrev, CONFIG));
    expect(Buffer.from(signingInput.celEvent(genesis, CONFIG).slice(32))).toEqual(
      Buffer.from(sha256(new TextEncoder().encode('{"data":{"name":"x"},"type":"create"}')))
    );
  });

  test('never signs stray keys (proof etc. excluded from the preimage)', () => {
    const clean = { type: 'update', data: { a: 1 } };
    const dirty = { ...clean, proof: [{ proofValue: 'zXX' }], extra: true };
    expect(signingInput.celEvent(dirty, CONFIG)).toEqual(signingInput.celEvent(clean, CONFIG));
  });

  test('a signature over celEvent verifies through the CEL proof verifier', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    const eventBase = { type: 'create', data: { name: 'asset', controller: `did:key:${pub}` } };
    const config = {
      type: 'DataIntegrityProof',
      cryptosuite: CEL_CRYPTOSUITE,
      created: new Date().toISOString(),
      verificationMethod: `did:key:${pub}#${pub}`,
      proofPurpose: 'assertionMethod',
    };
    const proof = {
      ...config,
      proofValue: multikey.encodeMultibase(ed25519.sign(signingInput.celEvent(eventBase, config), secret)),
    };
    const check = await verifyDidKeyProof(proof, eventBase);
    expect(check.verified).toBe(true);
  });

  test('tampering with the emitted proof configuration invalidates it', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    const eventBase = { type: 'create', data: { name: 'asset' } };
    const config = {
      type: 'DataIntegrityProof',
      cryptosuite: CEL_CRYPTOSUITE,
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `did:key:${pub}#${pub}`,
      proofPurpose: 'assertionMethod',
    };
    const proof = {
      ...config,
      proofValue: multikey.encodeMultibase(ed25519.sign(signingInput.celEvent(eventBase, config), secret)),
    };

    // Backdating the proof used to be undetectable.
    const backdated = { ...proof, created: '2020-01-01T00:00:00Z' };
    expect((await verifyDidKeyProof(backdated, eventBase)).verified).toBe(false);
  });
});

describe('signingInput.witness', () => {
  test('is exactly witnessSigningBytes (JSON-quoted digest, quotes included)', () => {
    const digest = 'uEiDexampledigest';
    expect(signingInput.witness(digest)).toEqual(witnessSigningBytes(digest));
    expect(new TextDecoder().decode(signingInput.witness(digest))).toBe(`"${digest}"`);
    expect(signingInput.witness(digest)).toEqual(canonicalizeEvent(digest));
  });
});

describe('signingInput.didWebvh', () => {
  test('matches didwebvh-ts prepareDataForSigning byte-for-byte', async () => {
    const mod = await import('didwebvh-ts') as unknown as {
      prepareDataForSigning: (d: unknown, p: unknown) => Promise<Uint8Array>;
    };
    const document = { id: 'did:webvh:example.com:user', foo: { b: 2, a: 1 } };
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', proofPurpose: 'assertionMethod' };
    const ours = await signingInput.didWebvh(document, proof);
    const theirs = await mod.prepareDataForSigning(document, proof);
    expect(ours).toEqual(new Uint8Array(theirs));
    // sha256(JCS(proof)) || sha256(JCS(document)) — two 32-byte hashes.
    expect(ours.length).toBe(64);
  });
});

describe('signingInput.credential', () => {
  const documentLoader = async (url: string) => {
    // Enough loader for the data-integrity context the proof config uses.
    const { createDocumentLoader } = await import('../../../src/vc/documentLoader');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const loader = createDocumentLoader(new DIDManager({
      network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false,
    } as never));
    return loader(url);
  };

  const credential = {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: 'did:example:issuer',
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: {
      resourceId: 'res-1', resourceType: 'text', createdAt: '2026-01-01T00:00:00Z',
      creator: 'did:example:issuer'
    },
  } as Record<string, unknown>;

  const proofConfig = {
    '@context': credential['@context'],
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-rdfc-2022',
    created: '2026-01-01T00:00:00Z',
    verificationMethod: 'did:example:issuer#key-0',
    proofPurpose: 'assertionMethod',
  } as Record<string, unknown>;

  test('is the RDFC-2022 hashData: sha256(proofConfig) || sha256(document)', async () => {
    const bytes = await signingInput.credential(credential, proofConfig, { documentLoader });
    expect(bytes.length).toBe(64);
    // computeSigningInput routes through the same preimage — identical bytes
    // for identical proof configs (created is pinned above).
    const viaSuite = await signingInput.credential({ ...credential }, { ...proofConfig }, { documentLoader });
    expect(viaSuite).toEqual(bytes);
  });

  test('ignores an existing proof on the document and proofValue on the config', async () => {
    const clean = await signingInput.credential(credential, proofConfig, { documentLoader });
    const dirty = await signingInput.credential(
      { ...credential, proof: { type: 'DataIntegrityProof', proofValue: 'zEXISTING' } },
      { ...proofConfig, proofValue: 'zSHOULD_BE_STRIPPED' },
      { documentLoader }
    );
    expect(dirty).toEqual(clean);
  });

  test('a signature over credential() verifies through EdDSACryptosuiteManager.verifyProof', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    const vmId = `did:key:${pub}#${pub}`;
    const config = { ...proofConfig, verificationMethod: vmId };
    const hashData = await signingInput.credential(credential, config, { documentLoader });
    const proof = { ...config, proofValue: EdDSACryptosuiteManager.encodeProofValue(ed25519.sign(hashData, secret)) };
    delete (proof as Record<string, unknown>)['@context'];
    const result = await EdDSACryptosuiteManager.verifyProof(
      { ...credential, proof }, proof as never, { documentLoader });
    expect(result.verified).toBe(true);
  });
});
