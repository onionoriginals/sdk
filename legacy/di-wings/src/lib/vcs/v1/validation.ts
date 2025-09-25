import { ValidationError } from '../../common/errors';
import type { Credential, Presentation } from '../../common/interfaces';

export const checkCredential = (credential: Credential) => {
	if (!credential['@context']) {
		throw new ValidationError('Verifiable Credentials MUST include a @context property.');
	}

	// TODO check jsonld is valid

	if (!credential.type) {
		throw new ValidationError('"type" property is required.');
	} else {
		let type = typeof credential.type === 'string' ? [credential.type] : credential.type;
		if (!type.includes('VerifiableCredential')) {
			throw new ValidationError('"type" property must contain "VerifiableCredential".');
		}
	}

	if (!credential.issuanceDate) { 
		throw new ValidationError('"issuanceDate" is required');
	}
	if (new Date(credential.issuanceDate).toISOString().slice(0, -5) + 'Z' !== credential.issuanceDate) {
		console.warn('"issuanceDate" (', credential.issuanceDate, ') is not an ISO date');
	}

	if (credential.expirationDate) {
		let expirationDate = new Date(credential.expirationDate).toISOString();
		if (expirationDate.slice(0, -5) + 'Z' !== credential.expirationDate) {
			console.warn('"expirationDate" is not an ISO date');
		}
	}

	let issuer = typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id;
	if (!issuer) {
		throw new ValidationError('"issuer" is required');
	}

	if (credential.credentialStatus) {
		if (!credential.credentialStatus.id) {
			throw new Error('"credentialStatus" must include an id.');
		}
		if (!credential.credentialStatus.type) {
			throw new Error('"credentialStatus" must include a type.');
		}
	}

	// Add validation for credentialSubject
	if (!credential.credentialSubject || typeof credential.credentialSubject !== 'object' || Object.keys(credential.credentialSubject).length === 0) {
		throw new ValidationError('"credentialSubject" is required and must be a non-empty object');
	}
};

export function validateCredential<T extends any[]>(
	fn: (...args: T) => any,
	index: number
): (...args: T) => any {
	return function(this: unknown, ...args: T) {
		const credential = args[index];
		try {
			checkCredential(credential);
		} catch (e) {
			console.error(e);
			throw e;
		}
		return fn.apply(this, args);
	};
}

export const checkPresentation = (presentation: Presentation) => {
	if (!presentation['@context']) {
		throw new ValidationError('Verifiable Presentations MUST include a @context property.');
	}

	// TODO check jsonld is valid

	if (!presentation.type) {
		throw new ValidationError('"type" property is required.');
	} else {
		let type = typeof presentation.type === 'string' ? [presentation.type] : presentation.type;
		if (!type.includes('VerifiablePresentation')) {
			throw new ValidationError('"type" property must contain "VerifiablePresentation".');
		}
	}
};

export function validatePresentation<T extends any[]>(
	fn: (...args: T) => any,
	index: number
): (...args: T) => any {
	return function(this: unknown, ...args: T) {
		const presentation = args[index];
		try {
			checkPresentation(presentation);
		} catch (e) {
			console.error(e);
			throw e;
		}

		if (presentation.verifiableCredential) {
			const vcs = Array.isArray(presentation.verifiableCredential)
				? presentation.verifiableCredential
				: [presentation.verifiableCredential];
			vcs.forEach((vc: Credential) => {
				try {
					checkCredential(vc);
				} catch (e) {
					console.error(e);
					throw e;
				}
			});
		}
		return fn.apply(this, args);
	};
}
