
import { describe, expect, test } from "bun:test"
import { Secp256k1KeyPair } from "../../../lib/crypto";

const key = require('../../fixtures/keypairs/EcdsaSecp256k1VerificationKey2019.json');

describe('Secp256k1 KeyPair tests', () => {
	test('should construct from object', async () => {
		const keypair = Secp256k1KeyPair.from(key);

		expect(keypair.id).toBe(key.id);
		expect(keypair.privateKeyBase58).toBe(key.privateKeyBase58);
		expect(keypair.publicKeyBase58).toBe(key.publicKeyBase58);
		expect(keypair.type).toBe(key.type);
		expect(keypair.controller).toBe(key.controller);
	});

	test('should sign and verify', async () => {
		const msg = 'hello tester';
		const encoder = new TextEncoder();
		const encodedMsg = encoder.encode(msg);
		const keypair = Secp256k1KeyPair.from(key);

		const signature = await keypair.sign(encodedMsg);
		const verified = await keypair.verify(encodedMsg, signature);

		expect(verified).toBeTrue();
	});

	test('generates', async () => {
		let keypair = await Secp256k1KeyPair.generate();
		expect(keypair).toHaveProperty('privateKey');
		expect(keypair).toHaveProperty('publicKey');
	});

	test('exports as JWK', async () => {
		const keypair = await Secp256k1KeyPair.generate();
		const jwk = await keypair.export({
			privateKey: true,
			type: 'JsonWebKey2020'
		});
		expect(jwk).toHaveProperty('privateKeyJwk');
		expect(jwk.privateKeyJwk).toHaveProperty('d');
		expect(jwk).toHaveProperty('publicKeyJwk');
		expect(jwk.publicKeyJwk).toHaveProperty('x');
		expect(jwk.publicKeyJwk).toHaveProperty('y');
	});
	
	test('exports as JWK w/o private key', async () => {
		const keypair = await Secp256k1KeyPair.generate();
		const jwkJustPub = await keypair.export();
		expect(jwkJustPub).toHaveProperty('publicKeyJwk');
		expect(jwkJustPub.publicKeyJwk).toHaveProperty('x');
		expect(jwkJustPub.publicKeyJwk).toHaveProperty('y');
		expect(jwkJustPub.privateKeyJwk).toBeUndefined();
	});

	test('from xpub', async () => {
		const xpub = 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';
		const keypair = await Secp256k1KeyPair.fromXpub(xpub);
		expect(keypair!.id).toContain('zQ3shizorZPFPkPVctdMRanf441efDPxWhPu9e4fq5ZwtHN5D')
	})
});
