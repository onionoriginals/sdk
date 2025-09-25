import type { DocumentLoader, Credential, VerifiableCredential } from '../../common/interfaces.js';
import type { DataIntegrityProof } from '../v2/proofs/data-integrity';
import { NotImplementedError } from '../../common/errors.js';
import { validateCredential } from './validation.js';

export class IssuanceService {
	static issueCredential = validateCredential(
		async function(
			credential: Credential,
			options: {
				type: 'vc-jwt' | 'vc-ld';
				suite: any;
				documentLoader: DocumentLoader;
			}
		): Promise<VerifiableCredential> {
			const { type, suite, documentLoader } = options;

			if (!documentLoader) {
				throw new TypeError('"documentLoader" parameter is required.');
			}

			if (!suite) {
				throw new TypeError('"suite" parameter is required.');
			}

			if (type === 'vc-jwt') {
				/* sign jwt vc */
				// TODO JWT
				// return suite.sign(LDCredentialToJWT(credential), { documentLoader });
			} else if (type === 'vc-ld') {
				/* sign linked data vc */
				const {context, proof}  = await suite.createProof(credential, 'assertionMethod', documentLoader);
				const vc: VerifiableCredential = { ...credential, proof: [proof]};
				vc['@context'] = context;
				return vc;
			}
			throw new TypeError('"type" parameter is required and must be "vc-jwt" or "vc-ld".');
		},
		0
	);

	static updateCredentialStatus() {
		throw new NotImplementedError('updateCredentialStatus not implemented yet');
	}
}
