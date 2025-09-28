import { DIDDocument, KeyPair, KeyType } from '../types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { multikey, MultikeyType } from '../crypto/Multikey';

function toMultikeyType(type: KeyType): MultikeyType {
        if (type === 'ES256K') return 'Secp256k1';
        if (type === 'Ed25519') return 'Ed25519';
        if (type === 'ES256') return 'P256';
        throw new Error(`Unsupported key type: ${type}`);
}

function fromMultikeyType(type: MultikeyType): KeyType {
        if (type === 'Secp256k1') return 'ES256K';
        if (type === 'Ed25519') return 'Ed25519';
        if (type === 'P256') return 'ES256';
        throw new Error('Unsupported key type');
}

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
                                privateKey: multikey.encodePrivateKey(privateKeyBytes, 'Secp256k1'),
                                publicKey: multikey.encodePublicKey(publicKeyBytes, 'Secp256k1')
                        };
                }

                if (type === 'Ed25519') {
                        const privateKeyBytes = ed25519.utils.randomPrivateKey();
                        const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
                        return {
                                privateKey: multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519'),
                                publicKey: multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519')
                        };
                }

			// NOTE: ES256 is allowed in OriginalsConfig.defaultKeyType but is not yet
			// implemented here. Callers should guard against requesting ES256 until
			// P-256 support is added to KeyManager and the signing stack.
			// TODO(keys): Add ES256 (P-256) generation and signing support.
			throw new Error('Only ES256K and Ed25519 supported at this time');
        }

	async rotateKeys(didDoc: DIDDocument, newKeyPair: KeyPair): Promise<DIDDocument> {
		// Minimal placeholder rotation that attaches the new public key as a verification method
		const multikeyContext = 'https://w3id.org/security/multikey/v1';
		const updatedContext = didDoc['@context'].includes(multikeyContext) 
			? didDoc['@context'] 
			: [...didDoc['@context'], multikeyContext];

		const updated: DIDDocument = {
			...didDoc,
			'@context': updatedContext,
			verificationMethod: [
				{
					id: `${didDoc.id}#keys-1`,
                                        type: 'Multikey',
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
                const mkType = toMultikeyType(type);
                return multikey.encodePublicKey(new Uint8Array(publicKey), mkType);
        }

        decodePublicKeyMultibase(encoded: string): { key: Buffer; type: KeyType } {
                if (!encoded || typeof encoded !== 'string') {
                        throw new Error('Invalid multibase string');
                }
                try {
                        const decoded = multikey.decodePublicKey(encoded);
                        return { key: Buffer.from(decoded.key), type: fromMultikeyType(decoded.type) };
                } catch {
                        throw new Error('Invalid multibase string');
                }
        }
}


