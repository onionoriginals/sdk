import { DIDDocument, KeyPair, KeyType } from '../types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { base58btc } from 'multiformats/bases/base58';

export class KeyManager {
	async generateKeyPair(type: KeyType): Promise<KeyPair> {
		if (type === 'ES256K') {
			const privateKeyBytes = secp256k1.utils.randomPrivateKey();
			const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
			return {
				privateKey: base58btc.encode(privateKeyBytes),
				publicKey: base58btc.encode(publicKeyBytes)
			};
		}

		if (type === 'Ed25519') {
			const privateKeyBytes = ed25519.utils.randomPrivateKey();
			const publicKeyBytes = await ed25519.getPublicKey(privateKeyBytes);
			return {
				privateKey: base58btc.encode(privateKeyBytes as Uint8Array),
				publicKey: base58btc.encode(publicKeyBytes as Uint8Array)
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
		// Use multibase base58btc (prefix 'z') for all supported types
		return base58btc.encode(publicKey);
	}

	decodePublicKeyMultibase(encoded: string): { key: Buffer; type: KeyType } {
		if (!encoded || typeof encoded !== 'string' || encoded[0] !== 'z') {
			throw new Error('Invalid multibase string');
		}
		const bytes = base58btc.decode(encoded);
		return { key: Buffer.from(bytes), type: 'ES256K' };
	}
}


