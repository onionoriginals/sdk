import { generateKey, JWE_ENC } from '../JWE/xc20p.js';
import { KeyEncryptionKey } from '../JWE/KeyEncryptionKey.js';
import { EncryptTransformer } from '../JWE/EncryptTransformer.js';
import { DecryptTransformer } from '../JWE/DecryptTransformer.js';
import type { Header, IJWE } from '../../common/interfaces.js';
import { X25519KeyAgreementKey2019 } from '../keypairs/X25519KeyAgreementKey2019.js';
import { JsonWebKeyPair } from '../keypairs/JsonWebKey2020.js';
import { base64url } from '../utils/encoding.js';
import { stringToUint8Array } from '../utils/sha256.js';
import type { BaseKeyPair } from '../keypairs/BaseKeyPair.js';
import { Buffer } from 'buffer/index.js';

export class JsonWebEncryptionSuite {
	public encrypt: any;
	public decrypt: any;

	constructor() {
		this.encrypt = this.createEncrypter().encrypt;
		this.decrypt = this.createDecrypter().decrypt;
	}

	private createEncryptTransformer = ({ recipients, publicKeyResolver, chunkSize }: any) => {
		return {
			encrypt: async (data: Uint8Array): Promise<IJWE> => {
				if (!(Array.isArray(recipients) && recipients.length > 0)) {
					throw new TypeError('"recipients" must be a non-empty array.');
				}

				const alg = 'ECDH-ES+A256KW';

				if (!recipients.every((e) => e.header && e.header.alg === alg)) {
					throw new Error(`All recipients must use the algorithm "${alg}".`);
				}

				const cek = await generateKey();
				const publicKeys = await Promise.all(
					recipients.map((e) => publicKeyResolver(e.header.kid))
				);
				// derive ephemeral ECDH key pair to use with all recipients
				const epk = await (
					await X25519KeyAgreementKey2019.generate()
				).export({
					type: 'JsonWebKey2020',
					privateKey: true
				});

				const ephemeralKeyPair = {
					keypair: epk,
					epk: epk.publicKeyJwk
				};
				
				// derive KEKs for each recipient
				const derivedResults = await Promise.all(
					publicKeys.map((staticPublicKey) =>
						KeyEncryptionKey.fromStaticPeer(JsonWebKeyPair)({
							ephemeralKeyPair,
							staticPublicKey
						})
					)
				);

				// update all recipients with ephemeral ECDH key and wrapped CEK
				await Promise.all(
					recipients.map(async (recipient, i) => {
						const { kek, epk, apu, apv } = derivedResults[i];
						recipients[i] = recipient = { header: { ...recipient.header } };
						recipient.header.epk = epk;
						recipient.header.apu = apu;
						recipient.header.apv = apv;
						recipient.encrypted_key = await kek.wrapKey({ unwrappedKey: cek });
					})
				);

				// create shared protected header as associated authenticated data (aad)
				// ASCII(BASE64URL(UTF8(JWE Protected Header)))
				const enc = JWE_ENC;
				const jweProtectedHeader = JSON.stringify({ enc });
				const encodedProtectedHeader = base64url.encode(
					Buffer.from(stringToUint8Array(jweProtectedHeader))
				);
				// UTF8-encoding a base64url-encoded string is the same as ASCII
				const additionalData = stringToUint8Array(encodedProtectedHeader);

				return new EncryptTransformer({
					recipients,
					encodedProtectedHeader,
					additionalData,
					cek,
					chunkSize
				}).encrypt(data);
			}
		};
	};

	createEncrypter = () => {
		return {
			encrypt: async ({
				data,
				recipients,
				publicKeyResolver
			}: {
				data: object | string;
				recipients: { header: Header }[];
				publicKeyResolver: (id: string) => Promise<BaseKeyPair>;
			}): Promise<IJWE> => {
				if (typeof data !== 'object' && typeof data !== 'string') {
					throw new TypeError('"data" must be an object or a string.');
				}
				let binaryData =
					typeof data === 'string'
						? stringToUint8Array(data)
						: stringToUint8Array(JSON.stringify(data));
				const transformer = this.createEncryptTransformer({
					recipients,
					publicKeyResolver
				});
				return transformer.encrypt(binaryData);
			}
		};
	};

	async createDecryptTransformer({ keyAgreementKey }: any) {
		return new DecryptTransformer({
			KeyPairClass: JsonWebKeyPair,
			keyAgreementKey
		});
	}

	createDecrypter = () => {
		return {
			decrypt: async ({ jwe, keyAgreementKey }: { jwe: IJWE; keyAgreementKey: any }) => {
				const transformer = await this.createDecryptTransformer({
					keyAgreementKey
				});
				const decrypted = await transformer.decrypt(jwe);
				return JSON.parse(Buffer.from(decrypted).toString());
			}
		};
	};
}
