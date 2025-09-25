import { describe, expect, test } from 'bun:test';
import { base64url, multikey, MULTICODEC_X25519_PRIV_HEADER, MULTICODEC_X25519_PUB_HEADER, X25519KeyAgreementKey2020 } from '../../../lib/crypto';

describe('X25519KeyAgreementKey2020', () => {
	test('resolves as JWK', async () => {
		const x25519key = require('../../fixtures/keypairs/X25519KeyAgreementKey2020.json');

		const key = new X25519KeyAgreementKey2020(
			x25519key.id,
			x25519key.controller,
			x25519key.publicKeyMultibase,
			x25519key.privateKeyMultibase
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.privateKeyJwk!.crv).toBe('X25519');
		expect(jwk.privateKeyJwk!.kty).toBe('OKP');
		expect(jwk.privateKeyJwk!.x).toBe(base64url.encode(multikey.decode(MULTICODEC_X25519_PUB_HEADER, x25519key.publicKeyMultibase)));
		expect(jwk.privateKeyJwk!.d).toBe(base64url.encode(multikey.decode(MULTICODEC_X25519_PRIV_HEADER, x25519key.privateKeyMultibase)));
	});

	test('w/o private key resolves as JWK', async () => {
		let x25519key = require('../../fixtures/keypairs/X25519KeyAgreementKey2020.json');
		x25519key = {
			...x25519key,
			privateKeyMultibase: undefined
		};

		const key = new X25519KeyAgreementKey2020(
			x25519key.id,
			x25519key.controller,
			x25519key.publicKeyMultibase,
			x25519key.privateKeyMultibase
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.publicKeyJwk!.crv).toBe('X25519');
		expect(jwk.publicKeyJwk!.kty).toBe('OKP');
		expect(jwk.publicKeyJwk!.x).toBe(base64url.encode(multikey.decode(MULTICODEC_X25519_PUB_HEADER, x25519key.publicKeyMultibase)));
	});

	test('can generate', async () => {
		const key = await X25519KeyAgreementKey2020.generate()
		expect(key).toHaveProperty('publicKey')
		expect(key).toHaveProperty('privateKey')
	})
});
