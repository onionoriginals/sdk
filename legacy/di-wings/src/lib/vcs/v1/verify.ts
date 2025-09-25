import type {
	VerifiableCredential,
	VerifiablePresentation,
	VerificationResult,
	DocumentLoader,
	ILinkedDataProof
} from '../../common/interfaces';
import { DataIntegrityProofManager } from '../v2/proofs/data-integrity';
import type { DataIntegrityProof } from '../v2/proofs/data-integrity';
import { VerificationError } from '../v2/errors';
import { JsonWebSignature2020Suite } from '../../crypto/JWS/Suite';

/* Verifier Service */
export class VerificationService {
	private static async verifyProof(
		document: any,
		proof: ILinkedDataProof | ILinkedDataProof[],
		documentLoader: DocumentLoader
	): Promise<boolean> {
		const proofs = Array.isArray(proof) ? proof : [proof];

		for (const p of proofs) {
			if (p.type === 'DataIntegrityProof') {
				const { verified, errors } = await DataIntegrityProofManager.verifyProof(
					document,
					p as DataIntegrityProof,
					{ documentLoader }
				);
				if (!verified) {
					throw new VerificationError(JSON.stringify(errors));
				}
			} else if (p.type === 'JsonWebSignature2020') {
				const {document: key} = await documentLoader(p.verificationMethod);
				const jws = new JsonWebSignature2020Suite({ key });
				const result = await jws.verifyProof(p as any, document, documentLoader);
				if (!result.verified) {
					throw new VerificationError('JsonWebSignature2020 verification failed');
				}
			} else {
				throw new VerificationError(`Unsupported proof type: ${p.type}`);
			}
		}
		return true;
	}

	static async verifyCredential(
		verifiableCredential: VerifiableCredential,
		suite: any,
		documentLoader: DocumentLoader
	): Promise<VerificationResult> {
		const checks: string[] = [];
		const { proof, ...credential } = verifiableCredential;

		try {
			const result = await suite.verifyProof(proof, credential, documentLoader);
			if (!result.verified) {
				throw new VerificationError(result.errors?.join(', '));
			}
			checks.push(...(Array.isArray(proof) ? proof : [proof]).map(p => p.proofPurpose));
			return {
				verified: true,
				checks,
				warnings: undefined,
				errors: undefined
			};
		} catch (error: any) {
			throw new VerificationError(`Credential verification failed: ${error.message}`);
		}
	}

	static async verifyPresentation(
		verifiablePresentation: VerifiablePresentation,
		suite: any,
		documentLoader: DocumentLoader
	): Promise<VerificationResult> {
		const checks: string[] = [];
		const { proof, ...presentation } = verifiablePresentation;

		try {
			await this.verifyProof(presentation, proof, documentLoader);
			checks.push(...(Array.isArray(proof) ? proof : [proof]).map(p => p.proofPurpose));
			// Verify each credential in the presentation
			if (presentation.verifiableCredential) {
				const credentials = Array.isArray(presentation.verifiableCredential)
					? presentation.verifiableCredential
					: [presentation.verifiableCredential];
				
				for (const credential of credentials) {
					await this.verifyCredential(credential, suite, documentLoader);
				}
			}

			return {
				verified: true,
				checks,
				warnings: undefined,
				errors: undefined
			};
		} catch (error: any) {
			throw new VerificationError(`Presentation verification failed: ${error.message}`);
		}
	}
}
