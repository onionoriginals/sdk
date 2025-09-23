import { DIDDocument, KeyPair, KeyType } from '../types';
import { generateKeyPairSync } from 'crypto';

export class KeyManager {
	async generateKeyPair(type: KeyType): Promise<KeyPair> {
		if (type === 'ES256K') {
			const { privateKey, publicKey } = generateKeyPairSync('ec', {
				namedCurve: 'secp256k1',
				privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
				publicKeyEncoding: { format: 'pem', type: 'spki' }
			});
			return {
				privateKey: this.encodePublicKeyMultibase(Buffer.from(privateKey), 'ES256K'),
				publicKey: this.encodePublicKeyMultibase(Buffer.from(publicKey), 'ES256K')
			};
		}

		if (type === 'Ed25519') {
			const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
				privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
				publicKeyEncoding: { format: 'pem', type: 'spki' }
			});
			return {
				privateKey: this.encodePublicKeyMultibase(Buffer.from(privateKey), 'Ed25519'),
				publicKey: this.encodePublicKeyMultibase(Buffer.from(publicKey), 'Ed25519')
			};
		}

		throw new Error('Only ES256K and Ed25519 supported at this time');
	}

	async rotateKeys(didDoc: DIDDocument, newKeyPair: KeyPair): Promise<DIDDocument> {
		// Minimal placeholder rotation that attaches the new public key as a verification method
		const updated: DIDDocument = {
			...didDoc,
			verificationMethod: [
				{
					id: `${didDoc.id}#keys-1`,
					type: 'EcdsaSecp256k1VerificationKey2019',
					controller: didDoc.id,
					publicKeyMultibase: newKeyPair.publicKey
				}
			],
			authentication: [`${didDoc.id}#keys-1`]
		};

		return updated;
	}

	async recoverFromCompromise(didDoc: DIDDocument): Promise<DIDDocument> {
		// Minimal placeholder that returns the provided DID document unchanged
		return { ...didDoc };
	}

	encodePublicKeyMultibase(publicKey: Buffer, type: KeyType): string {
		// Minimal multibase using base64url with 'z' prefix for all supported types
		return 'z' + Buffer.from(publicKey).toString('base64url');
	}

	decodePublicKeyMultibase(encoded: string): { key: Buffer; type: KeyType } {
		if (!encoded || typeof encoded !== 'string' || encoded[0] !== 'z') {
			throw new Error('Invalid multibase string');
		}
    const base = encoded.slice(1);
    const bytes = Buffer.from(base, 'base64url');
    return { key: bytes, type: 'ES256K' };
	}
}


