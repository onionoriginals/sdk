import type { JWTCredential, Credential } from '../../common/interfaces';

export const LDCredentialToJWT = (credential: Credential): JWTCredential => {
	let newCred = {} as JWTCredential;

	/* copy credential subject id */
	if (credential.credentialSubject.id) {
		newCred.sub = credential.credentialSubject.id;
	}

	/* copy credential id */
	if (credential.id) {
		newCred.jti = credential.id;
	}

	/* copy issuer */
	if (typeof credential.issuer === 'string') {
		newCred.iss = credential.issuer;
	} else {
		newCred.iss = credential.issuer?.id ?? '';
	}

	/* copy issuance date */
	const issuanceDate = Math.floor(+new Date(credential.issuanceDate ?? new Date()) / 1000);
	newCred.nbf = issuanceDate;
	newCred.iat = issuanceDate;

	/* copy expiration date */
	if (credential.expirationDate) {
		newCred.exp = Math.floor(+new Date(credential.expirationDate) / 1000);
	}

	/* nonce */
	newCred.nonce = crypto.getRandomValues(new Uint8Array(12)).toString();
	/* copy the remaining claims into vc */
	newCred.vc = credential;

	return newCred;
};