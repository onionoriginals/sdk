import type {
	Credential,
	LinkedDataSuite,
	Presentation,
	VerifiableCredential,
	VerifiablePresentation
} from '../../common/interfaces';
import type { DocumentLoader } from '../../common/interfaces';
import { DataIntegrityProofManager } from '../v2/proofs/data-integrity';
import type { ProofOptions } from '../v2/proofs/data-integrity';
import { validateCredential, validatePresentation } from './validation.js';

export class PresentationService {
	static deriveCredential = validateCredential(
		async function(
			credential: Credential | VerifiableCredential,
			options: {
				type: 'vc-jwt' | 'vc-ld';
				suite: any;
				documentLoader: DocumentLoader;
			},
			proofOptions?: any
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
				let newProof;
				if (typeof credential['proof'] === 'undefined') {
					newProof = await suite.createProof(
						credential,
						'assertionMethod',
						documentLoader,
						proofOptions
					);
				} else {
					let oldProof = (credential as VerifiableCredential).proof;
					if (!Array.isArray(oldProof)) {
						oldProof = [oldProof];
					}
					newProof = [
						await suite.createProof(credential, 'assertionMethod', documentLoader, proofOptions),
						...oldProof
					];
				}
				return { ...credential, proof: newProof };
			}
			throw new TypeError('"type" parameter is required and must be "vc-jwt" or "vc-ld".');
		},
		0
	);

	static provePresentation = validatePresentation(
		async function(
			presentation: Presentation,
			options: {
				type: 'vc-jwt' | 'vc-ld';
				suite: any;
				documentLoader: DocumentLoader;
				domain?: string;
				challenge: string;
				[key: string]: any;
			}
		): Promise<VerifiablePresentation> {
			try {
				const { type, suite, documentLoader, ...opts } = options;
				if (type === 'vc-jwt') {
					// TODO: Implement JWT signing
					throw new Error('JWT signing not implemented');
				} else if (type === 'vc-ld') {
					const proofOptions: ProofOptions = {
						verificationMethod: suite.verificationMethod,
						type: 'DataIntegrityProof',
						proofPurpose: 'authentication',
						created: new Date().toISOString().slice(0, -5) + 'Z',
						privateKey: suite.key.privateKey,
						cryptosuite: suite.cryptosuite,
						documentLoader,
						// Remove domain and challenge from ProofOptions
					};

					const proof = await DataIntegrityProofManager.createProof(presentation, proofOptions);
					return { ...presentation, proof };
				}
				throw new TypeError('"type" parameter is required and must be "vc-jwt" or "vc-ld".');
			} catch (e: any) {
				console.error(e.details ?? e.message ?? e);
				throw new Error('Failed to prove presentation');
			}
		},
		0
	);
}
