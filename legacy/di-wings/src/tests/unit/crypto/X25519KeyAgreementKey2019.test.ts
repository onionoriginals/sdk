import { describe, expect, test } from 'bun:test';
import { X25519KeyAgreementKey2019 } from '../../../lib/crypto/keypairs/X25519KeyAgreementKey2019';
import { base58, base64url } from '../../../lib/crypto/utils/encoding';

describe('X25519KeyAgreementKey2019', () => {
	test('resolves as JWK', async () => {
		const x25519key = require('../../fixtures/keypairs/X25519KeyAgreementKey2019.json');

		const key = new X25519KeyAgreementKey2019(
			x25519key.id,
			x25519key.controller,
			x25519key.publicKeyBase58,
			x25519key.privateKeyBase58
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.privateKeyJwk!.crv).toBe('X25519');
		expect(jwk.privateKeyJwk!.kty).toBe('OKP');
		expect(jwk.privateKeyJwk!.x).toBe(base64url.encode(base58.decode(x25519key.publicKeyBase58)));
		expect(jwk.privateKeyJwk!.d).toBe(base64url.encode(base58.decode(x25519key.privateKeyBase58)));
	});

	test('w/o private key resolves as JWK', async () => {
		let x25519key = require('../../fixtures/keypairs/X25519KeyAgreementKey2019.json');
		x25519key = {
			...x25519key,
			privateKeyBase58: undefined
		};

		const key = new X25519KeyAgreementKey2019(
			x25519key.id,
			x25519key.controller,
			x25519key.publicKeyBase58,
			x25519key.privateKeyBase58
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.publicKeyJwk!.crv).toBe('X25519');
		expect(jwk.publicKeyJwk!.kty).toBe('OKP');
		expect(jwk.publicKeyJwk!.x).toBe(base64url.encode(base58.decode(x25519key.publicKeyBase58)));
	});
});
