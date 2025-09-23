import { DIDDocument, KeyPair, KeyType } from '../types';
import { generateKeyPairSync } from 'crypto';

export class KeyManager {
	async generateKeyPair(type: KeyType): Promise<KeyPair> {
		if (type !== 'ES256K') {
			throw new Error('Only ES256K supported at this time');
		}

    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' }
    });

    const privateKeyMultibase = this.encodePublicKeyMultibase(Buffer.from(privateKey), 'ES256K');
    const publicKeyMultibase = this.encodePublicKeyMultibase(Buffer.from(publicKey), type);

		return {
			privateKey: privateKeyMultibase,
			publicKey: publicKeyMultibase
		};
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
    if (type !== 'ES256K') {
      throw new Error('Only ES256K supported at this time');
    }
    // Minimal multibase using base64url with 'z' prefix
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


