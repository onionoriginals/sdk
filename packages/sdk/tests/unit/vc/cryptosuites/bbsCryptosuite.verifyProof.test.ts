import { describe, test, expect } from 'bun:test';
import { BBSCryptosuiteManager, BBSCryptosuiteUtils, multikey } from '../../../../src';
import type { DataIntegrityProof } from '../../../../src/vc/cryptosuites/eddsa';

/**
 * Regression test for the BBS key-substitution forgery hole:
 * verifyProof must verify against the public key resolved from the DID
 * document, not the attacker-controlled key embedded in the proof.
 */

function blsKey(fill: number): Uint8Array {
  // BLS12381G2 public keys are 96 bytes.
  return new Uint8Array(96).fill(fill);
}

function bytes(len: number, start = 0): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (start + i) & 0xff;
  return a;
}

function buildBaseProof(embeddedPublicKey: Uint8Array, verificationMethod: string): DataIntegrityProof {
  const proofValue = BBSCryptosuiteUtils.serializeBaseProofValue(
    bytes(80, 1), // bbsSignature
    bytes(64, 2), // bbsHeader
    embeddedPublicKey,
    bytes(32, 4), // hmacKey
    ['/issuer'],
    'baseline'
  );
  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'bbs-2023',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue
  };
}

const document = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  issuer: 'did:example:victim',
  credentialSubject: { id: 'did:example:subject' }
};

describe('BBSCryptosuiteManager.verifyProof key binding', () => {
  const vm = 'did:example:victim#bls';

  test('rejects a proof whose embedded public key differs from the DID document key', async () => {
    const attackerKey = blsKey(0xaa);
    const victimKey = blsKey(0xbb);
    const proof = buildBaseProof(attackerKey, vm);

    const documentLoader = async (url: string) => {
      if (url === vm) {
        return {
          document: {
            id: vm,
            type: 'Multikey',
            controller: 'did:example:victim',
            publicKeyMultibase: multikey.encodePublicKey(victimKey, 'Bls12381G2')
          }
        };
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await BBSCryptosuiteManager.verifyProof(document, proof, { documentLoader });

    expect(result.verified).toBe(false);
    expect(result.errors?.[0]).toContain('does not match');
    // Must reject on the key mismatch, NOT reach BbsSimple.verify (not implemented).
    expect(result.errors?.[0]).not.toMatch(/not implemented/i);
  });

  test('matching key proceeds to signature verification (reaches BbsSimple.verify)', async () => {
    const key = blsKey(0xcc);
    const proof = buildBaseProof(key, vm);

    const documentLoader = async (url: string) => ({
      document: {
        id: vm,
        type: 'Multikey',
        controller: 'did:example:victim',
        publicKeyMultibase: multikey.encodePublicKey(key, 'Bls12381G2')
      }
    });

    const result = await BBSCryptosuiteManager.verifyProof(document, proof, { documentLoader });

    // Keys match, so it progresses past the binding check to the signature
    // check, which currently throws "not implemented".
    expect(result.verified).toBe(false);
    expect(result.errors?.[0]).toMatch(/not implemented/i);
  });

  test('fails closed when no documentLoader is supplied', async () => {
    const proof = buildBaseProof(blsKey(0xaa), vm);
    const result = await BBSCryptosuiteManager.verifyProof(document, proof, {});
    expect(result.verified).toBe(false);
    expect(result.errors?.[0]).toContain('documentLoader is required');
  });

  test('rejects when the DID document key is not Bls12381G2', async () => {
    const proof = buildBaseProof(blsKey(0xaa), vm);
    const ed25519Key = new Uint8Array(32).fill(7);
    const documentLoader = async () => ({
      document: {
        id: vm,
        publicKeyMultibase: multikey.encodePublicKey(ed25519Key, 'Ed25519')
      }
    });
    const result = await BBSCryptosuiteManager.verifyProof(document, proof, { documentLoader });
    expect(result.verified).toBe(false);
    expect(result.errors?.[0]).toContain('not Bls12381G2');
  });
});
