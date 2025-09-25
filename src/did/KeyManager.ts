import { DIDDocument, KeyPair, KeyType } from '../types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';

export class KeyManager {
	constructor() {
		const sAny: any = secp256k1 as any;
		const eAny: any = ed25519 as any;
		sAny.utils = sAny.utils || {};
		sAny.utils.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
			hmac(sha256, key, concatBytes(...msgs));
		eAny.utils = eAny.utils || {};
		eAny.utils.sha512Sync = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));
	}
	async generateKeyPair(type: KeyType): Promise<KeyPair> {
		if (type === 'ES256K') {
			const privateKeyBytes = secp256k1.utils.randomPrivateKey();
			const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
			return {
				privateKey: 'z' + Buffer.from(privateKeyBytes).toString('base64url'),
				publicKey: 'z' + Buffer.from(publicKeyBytes).toString('base64url')
			};
		}

		if (type === 'Ed25519') {
			const privateKeyBytes = ed25519.utils.randomPrivateKey();
			const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
			return {
				privateKey: 'z' + Buffer.from(privateKeyBytes as Uint8Array).toString('base64url'),
				publicKey: 'z' + Buffer.from(publicKeyBytes as Uint8Array).toString('base64url')
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


