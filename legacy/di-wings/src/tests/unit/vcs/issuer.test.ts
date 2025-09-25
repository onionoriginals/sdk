import { describe, it, expect, spyOn } from 'bun:test';


import credential from '../../fixtures/credentials/case-10.json';
import key from '../../fixtures/keypairs/JsonWebKey2020.json';
import { MockSignatureSuite } from '../../mocks/MockSignatureSuite';
import { IssuanceService } from '../../../lib/vcs/v1/issue';
import { documentLoader } from '../../fixtures/crypto/documentLoader';
import { JsonWebKeyPair, JsonWebSignature2020Suite } from '../../../lib/crypto';

describe('issuer service', () => {
	it("calls 'sign' on a suite when issuing a valid credential", async () => {
		const mockSig = new MockSignatureSuite();
		spyOn(mockSig, 'createProof');

		const vc = await IssuanceService.issueCredential(credential, {
			type: 'vc-ld',
			suite: mockSig,
			documentLoader
		});

		expect(mockSig.createProof).toBeCalled();
	});

	it("doesn't call 'sign' on a suite when issuing a bad credential", async () => {
		const mockSig = new MockSignatureSuite();
		spyOn(mockSig, 'createProof');
		let badCred = { ...credential };
    // @ts-ignore
		delete badCred['@context'];

		try {
			const vc = await IssuanceService.issueCredential(badCred, {
				type: 'vc-ld',
				suite: mockSig,
				documentLoader
			});
		} catch (e) {
			expect(mockSig.createProof).toBeCalledTimes(0);
		}
	});

	it('issues a JsonWebSignature2020 VC', async () => {
		const jwk = await JsonWebKeyPair.fromJWK(key);
		const suite = new JsonWebSignature2020Suite({ key: jwk, date: new Date().toISOString() });

		const vc = await IssuanceService.issueCredential(credential, {
			type: 'vc-ld',
			suite,
			documentLoader
		});

		// compare proof separately
		let { proof, ...cred } = vc;
		if (!Array.isArray(proof)) {
			proof = [proof];
		}
		expect(cred.credentialSubject).toStrictEqual(credential.credentialSubject);
		expect(proof[0]).toHaveProperty('jws');
		expect(proof[0].jws).toContain('..');
		expect(proof[0].proofPurpose).toBe('assertionMethod');
		expect(proof[0].type).toBe('JsonWebSignature2020');
		expect(proof[0].verificationMethod).toBe(jwk.id);
	});
});