import { describe, it, expect } from 'bun:test';
import { JsonWebEncryptionSuite, X25519KeyAgreementKey2019 } from '../../../lib/crypto';

const plaintext = require('../../fixtures/crypto/plaintext.json');
const jwe = require('../../fixtures/crypto/jwe.json');
const key = require('../../fixtures/keypairs/X25519KeyAgreementKey2019.json');
const key2 = require('../../fixtures/keypairs/X25519KeyAgreementKey2020.json')

describe('JWE', () => {
	it('Can encrypt data w/ base58 key', async () => {
		const cipher = new JsonWebEncryptionSuite();
		const recipients = [
			{
				header: {
					kid: key.id,
					alg: 'ECDH-ES+A256KW'
				}
			}
		];
		const publicKeyResolver = () => key;

		const result = await cipher.encrypt({
			data: plaintext,
			recipients,
			publicKeyResolver
		});
		expect(result).toHaveProperty('protected');
		expect(result.recipients.length).toBe(1);
		expect(result).toHaveProperty('iv');
		expect(result).toHaveProperty('ciphertext');
		expect(result).toHaveProperty('tag');
	});

	it('Can encrypt data w/ multibase key', async () => {
		const cipher = new JsonWebEncryptionSuite();
		const recipients = [
			{
				header: {
					kid: key2.id,
					alg: 'ECDH-ES+A256KW'
				}
			}
		];
		const publicKeyResolver = () => key2;

		const result = await cipher.encrypt({
			data: plaintext,
			recipients,
			publicKeyResolver
		});
		expect(result).toHaveProperty('protected');
		expect(result.recipients.length).toBe(1);
		expect(result).toHaveProperty('iv');
		expect(result).toHaveProperty('ciphertext');
		expect(result).toHaveProperty('tag');
	});

	it('Can decrypt data', async () => {
		const cipher = new JsonWebEncryptionSuite();
		const keyAgreementKey = new X25519KeyAgreementKey2019(
			key.id,
			key.controller,
			key.publicKeyBase58,
			key.privateKeyBase58
		);

		const result = await cipher.decrypt({
			jwe,
			keyAgreementKey
		});

		expect(result.body).toBe('hello world');
	});
});
