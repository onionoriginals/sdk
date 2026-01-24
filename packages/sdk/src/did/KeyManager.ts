// Initialize noble crypto libraries first (idempotent - safe to import multiple times)
import '../crypto/noble-init.js';

import { DIDDocument, KeyPair, KeyType, KeyRecoveryCredential } from '../types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { p256 } from '@noble/curves/p256';
import { multikey, MultikeyType } from '../crypto/Multikey';

function toMultikeyType(type: KeyType): MultikeyType {
        if (type === 'ES256K') return 'Secp256k1';
        if (type === 'Ed25519') return 'Ed25519';
        if (type === 'ES256') return 'P256';
        const _exhaustiveCheck: never = type;
        throw new Error(`Unsupported key type: ${String(_exhaustiveCheck)}`);
}

function fromMultikeyType(type: MultikeyType): KeyType {
        if (type === 'Secp256k1') return 'ES256K';
        if (type === 'Ed25519') return 'Ed25519';
        if (type === 'P256') return 'ES256';
        throw new Error('Unsupported key type');
}

export class KeyManager {
	constructor() {
		// Noble crypto libraries are initialized via noble-init.ts (imported at SDK entry point)
		// No initialization needed here
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
                        const ed25519Module = ed25519 as unknown as { getPublicKeyAsync: (privateKey: Uint8Array) => Promise<Uint8Array> };
                        const publicKeyBytes = await ed25519Module.getPublicKeyAsync(privateKeyBytes);
                        return {
                                privateKey: multikey.encodePrivateKey(privateKeyBytes, 'Ed25519'),
                                publicKey: multikey.encodePublicKey(publicKeyBytes, 'Ed25519')
                        };
                }

                if (type === 'ES256') {
                        const privateKeyBytes = p256.utils.randomPrivateKey();
                        const publicKeyBytes = p256.getPublicKey(privateKeyBytes, true);
                        return {
                                privateKey: multikey.encodePrivateKey(privateKeyBytes, 'P256'),
                                publicKey: multikey.encodePublicKey(publicKeyBytes, 'P256')
                        };
                }

		const _exhaustiveCheck: never = type;
		throw new Error(`Unsupported key type: ${String(_exhaustiveCheck)}`);
        }

	rotateKeys(didDoc: DIDDocument, newKeyPair: KeyPair): DIDDocument {
		const multikeyContext = 'https://w3id.org/security/multikey/v1';
		const securityContext = 'https://w3id.org/security/v1';
		
		// Ensure required contexts are present
		const updatedContext = [...didDoc['@context']];
		if (!updatedContext.includes(multikeyContext)) {
			updatedContext.push(multikeyContext);
		}
		if (!updatedContext.includes(securityContext)) {
			updatedContext.push(securityContext);
		}

		// Generate new key ID
		const existingKeys = didDoc.verificationMethod || [];
		const keyIndex = existingKeys.length;
		const newKeyId = `${didDoc.id}#keys-${keyIndex}`;
		
		// Mark all existing verification methods as revoked with current timestamp
		const revokedTimestamp = new Date().toISOString();
		const revokedVerificationMethods = existingKeys.map(vm => ({
			...vm,
			revoked: revokedTimestamp
		}));

		// Create new verification method
		const newVerificationMethod = {
			id: newKeyId,
			type: 'Multikey',
			controller: didDoc.id,
			publicKeyMultibase: newKeyPair.publicKey
		};

		// Update authentication and assertionMethod arrays to reference only the new key
		const newKeyReference = newKeyId;
		
		const updated: DIDDocument = {
			...didDoc,
			'@context': updatedContext,
			verificationMethod: [...revokedVerificationMethods, newVerificationMethod],
			authentication: [newKeyReference],
			assertionMethod: [newKeyReference]
		};

		// Preserve other properties if they exist
		if (didDoc.keyAgreement) {
			updated.keyAgreement = didDoc.keyAgreement;
		}
		if (didDoc.capabilityInvocation) {
			updated.capabilityInvocation = didDoc.capabilityInvocation;
		}
		if (didDoc.capabilityDelegation) {
			updated.capabilityDelegation = didDoc.capabilityDelegation;
		}
		if (didDoc.service) {
			updated.service = didDoc.service;
		}

		return updated;
	}

	async recoverFromCompromise(didDoc: DIDDocument): Promise<{ 
		didDocument: DIDDocument; 
		recoveryCredential: KeyRecoveryCredential;
		newKeyPair: KeyPair;
	}> {
		// Determine key type from existing verification methods or default to Ed25519
		let keyType: KeyType = 'Ed25519';
		if (didDoc.verificationMethod && didDoc.verificationMethod.length > 0) {
			try {
				const firstKey = didDoc.verificationMethod[0];
				const decoded = multikey.decodePublicKey(firstKey.publicKeyMultibase);
				keyType = fromMultikeyType(decoded.type);
			} catch (e) {
				// If decoding fails, use default Ed25519
			}
		}

		// Generate new key pair
		const newKeyPair = await this.generateKeyPair(keyType);

		// Ensure required contexts
		const multikeyContext = 'https://w3id.org/security/multikey/v1';
		const securityContext = 'https://w3id.org/security/v1';
		const credentialsContext = 'https://www.w3.org/2018/credentials/v1';
		
		const updatedContext = [...didDoc['@context']];
		if (!updatedContext.includes(multikeyContext)) {
			updatedContext.push(multikeyContext);
		}
		if (!updatedContext.includes(securityContext)) {
			updatedContext.push(securityContext);
		}

		// Mark all existing verification methods as compromised
		const compromisedTimestamp = new Date().toISOString();
		const existingKeys = didDoc.verificationMethod || [];
		const compromisedVerificationMethods = existingKeys.map(vm => ({
			...vm,
			compromised: compromisedTimestamp
		}));

		// Collect IDs of compromised keys
		const previousVerificationMethodIds = existingKeys.map(vm => vm.id);

		// Generate new key ID
		const keyIndex = existingKeys.length;
		const newKeyId = `${didDoc.id}#keys-${keyIndex}`;

		// Create new verification method
		const newVerificationMethod = {
			id: newKeyId,
			type: 'Multikey',
			controller: didDoc.id,
			publicKeyMultibase: newKeyPair.publicKey
		};

		// Update DID document
		const updatedDidDocument: DIDDocument = {
			...didDoc,
			'@context': updatedContext,
			verificationMethod: [...compromisedVerificationMethods, newVerificationMethod],
			authentication: [newKeyId],
			assertionMethod: [newKeyId]
		};

		// Preserve other properties
		if (didDoc.keyAgreement) {
			updatedDidDocument.keyAgreement = didDoc.keyAgreement;
		}
		if (didDoc.capabilityInvocation) {
			updatedDidDocument.capabilityInvocation = didDoc.capabilityInvocation;
		}
		if (didDoc.capabilityDelegation) {
			updatedDidDocument.capabilityDelegation = didDoc.capabilityDelegation;
		}
		if (didDoc.service) {
			updatedDidDocument.service = didDoc.service;
		}

		// Create recovery credential
		const recoveryCredential: KeyRecoveryCredential = {
			'@context': [credentialsContext, securityContext],
			type: ['VerifiableCredential', 'KeyRecoveryCredential'],
			issuer: didDoc.id,
			issuanceDate: compromisedTimestamp,
			credentialSubject: {
				id: didDoc.id,
				recoveredAt: compromisedTimestamp,
				recoveryReason: 'key_compromise',
				previousVerificationMethods: previousVerificationMethodIds,
				newVerificationMethod: newKeyId
			}
		};

		return { didDocument: updatedDidDocument, recoveryCredential, newKeyPair };
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


