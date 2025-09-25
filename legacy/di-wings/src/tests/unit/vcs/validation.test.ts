import { describe, it, expect } from 'bun:test';

import cred1 from '../../fixtures/credentials/case-10.json';
import pres1 from '../../fixtures/presentations/case-10.json';
import { validateCredential, validatePresentation } from '../../../lib/vcs/v1/validation';
import type { Credential, Presentation } from '../../../lib/crypto';

class DummyCredentialClass {
	static methodBeingValidated = validateCredential(
		function(credential: Credential) {
			return 42;
		},
		0
	);
}

class DummyPresentationClass {
	static methodBeingValidated = validatePresentation(
		function(presentation: Presentation) {
			return 42;
		},
		0
	);
}

describe('validation utils', () => {
	it('validateCredential should pass through valid credential', () => {
		const result = DummyCredentialClass.methodBeingValidated(cred1 as any);
		expect(result).toBe(42);
	});

	it('validateCredential should throw error for invalid credential', () => {
		try {
			let credBad = { ...cred1 };
			// @ts-ignore
			delete credBad.type;
			const result = DummyCredentialClass.methodBeingValidated(credBad as any);
			expect(true).toBeFalse();
		} catch (e: any) {
			expect(e.message).toBe('"type" property is required.');
		}
	});

	it('can validate credential with an ISO string date w/o milliseconds', () => {
		let cred = {
			...cred1,
			issuanceDate: new Date().toISOString().slice(0, -5) + 'Z'
		};
		const result = DummyCredentialClass.methodBeingValidated(cred as Credential);
		expect(result).toBe(42);
	});

	it('validatePresentation should pass through valid presentation', () => {
		const result = DummyPresentationClass.methodBeingValidated(pres1 as unknown as Presentation);
		expect(result).toBe(42);
	});

	it('validatePresentation should throw error for invalid presentation', () => {
		try {
			let presBad = JSON.parse(JSON.stringify(pres1));
			delete presBad.type;
			const result = DummyPresentationClass.methodBeingValidated(presBad);
			expect(true).toBeFalse();
		} catch (e: any) {
			expect(e.message).toBe('"type" property is required.');
		}
	});

	it('validatePresentation should throw error for invalid credential in presentation', () => {
		try {
			let presBad = JSON.parse(JSON.stringify(pres1));
			delete presBad.verifiableCredential[0].type;
			const result = DummyPresentationClass.methodBeingValidated(presBad);
			expect(true).toBeFalse();
		} catch (e: any) {
			expect(e.message).toBe('"type" property is required.');
		}
	});
});