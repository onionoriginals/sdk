import { describe, it, expect } from 'bun:test';
import { JsonWebKeyPair, JsonWebSignature2020Suite, type VerifiableCredential } from '../../../lib/crypto';


import credential from '../../fixtures/credentials/case-10.json';
import key from '../../fixtures/keypairs/JsonWebKey2020.json';
import { IssuanceService } from '../../../lib/vcs/v1/issue';
import { documentLoader } from '../../fixtures/crypto/documentLoader';


describe('issue and verify', () => {
  let vc: VerifiableCredential;

	it('issues a JsonWebSignature2020 VC', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });
		vc = await IssuanceService.issueCredential(credential, {
			type: 'vc-ld',
			suite,
			documentLoader
		});


    let { proof, ...cred } = vc;
    expect(cred.credentialSubject).toStrictEqual(credential.credentialSubject);
    
		// compare proof separately
		if (Array.isArray(proof)) {
      // Handle array of proofs
      expect(proof.length).toBeGreaterThan(0);
      proof.forEach(singleProof => {
        expect(singleProof).toHaveProperty('jws');
        expect(singleProof.jws).toContain('..');
        expect(singleProof.proofPurpose).toBe('assertionMethod');
        expect(singleProof.type).toBe('JsonWebSignature2020');
        expect(singleProof.verificationMethod).toBe(jwk.id);
      });
    } else {
      // Handle single proof
      expect(proof).toHaveProperty('jws');
      expect(proof.jws).toContain('..');
      expect(proof.proofPurpose).toBe('assertionMethod');
      expect(proof.type).toBe('JsonWebSignature2020');
      expect(proof.verificationMethod).toBe(jwk.id);
    }
	});
});