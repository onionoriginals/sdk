import { describe, it, expect } from 'bun:test';

import verifiableCredential from '../../fixtures/verifiableCredentials/case-10.json';
import verifiablePresentation from '../../fixtures/verifiablePresentations/case-10.json';
import key from '../../fixtures/keypairs/JsonWebKey2020.json';
import { JsonWebKeyPair, JsonWebSignature2020Suite } from '../../../lib/crypto';
import { VerificationService } from '../../../lib/vcs/v1/verify';
import { documentLoader } from '../../fixtures/crypto/documentLoader';

describe('verifier service', () => {
	it('fails verification for an invalid JsonWebKeySignature2020 VC', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });
		const vcCopy = JSON.parse(JSON.stringify(verifiableCredential));
		vcCopy.proof.jws = 'ey..123';
		let result, err;
		try {
			result = await VerificationService.verifyCredential(vcCopy, suite, documentLoader);
		} catch (e) {
			err = e;
		}
		expect(result).toBeUndefined();
		expect(err).toBeDefined();
	});
	it.skip('verifies a JsonWebKeySignature2020 VC', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });
		const result = await VerificationService.verifyCredential(
			verifiableCredential,
			suite,
			documentLoader
		);

		expect(result.verified).toBeTrue();
	});

	it('fails verification for an invalid JsonWebKeySignature2020 VP', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });
		const vpCopy = JSON.parse(JSON.stringify(verifiablePresentation));
		vpCopy.proof.jws = 'ey..123';
		let result, err;
		try {
			result = await VerificationService.verifyPresentation(vpCopy, suite, documentLoader);
		} catch (e) {
			err = e;
		}
		expect(result).toBeUndefined();
		expect(err).toBeDefined();
	});

	it.skip('verifies a JsonWebKeySignature2020 VP', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });
		const result = await VerificationService.verifyPresentation(
			verifiablePresentation,
			suite,
			documentLoader
		);

		expect(result.verified).toBeTrue();
	});
});