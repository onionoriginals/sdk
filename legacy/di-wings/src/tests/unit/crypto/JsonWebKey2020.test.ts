import { describe, expect, it, beforeAll } from 'bun:test';
import { JsonWebKeyPair } from '../../../lib/crypto';

let jwk2020: any;

describe('JsonWebKey2020', () => {
	beforeAll(() => {
		jwk2020 = require('../../fixtures/keypairs/JsonWebKey2020.json');
	})
	it('resolves as JWK', async () => {
		const jwk = new JsonWebKeyPair(
			jwk2020.id,
			jwk2020.controller,
			jwk2020.publicKeyJwk,
			jwk2020.privateKeyJwk
		);

		expect(jwk.id).toBe(jwk2020.id);
		expect(jwk.controller).toBe(jwk2020.controller);
		expect(jwk.publicKeyJwk).toBe(jwk2020.publicKeyJwk);
		expect(jwk.privateKeyJwk).toBe(jwk2020.privateKeyJwk);
	});

	it('w/o private key resolves as JWK', async () => {
		const { privateKeyJwk, ...newjwk } = jwk2020;

		const jwk = new JsonWebKeyPair(
			newjwk.id,
			newjwk.controller,
			newjwk.publicKeyJwk,
			newjwk.privateKeyJwk
		);

		expect(jwk.id).toBe(newjwk.id);
		expect(jwk.controller).toBe(newjwk.controller);
		expect(jwk.publicKeyJwk).toBe(newjwk.publicKeyJwk);
		expect(jwk.privateKeyJwk).toBe(newjwk.privateKeyJwk);
	});

	it('exports as LD', async () => {
		const jwk = new JsonWebKeyPair(
			jwk2020.id,
			jwk2020.controller,
			jwk2020.publicKeyJwk,
			jwk2020.privateKeyJwk
		);

		const keypair = await jwk.exportAsLD({
			privateKey: true
		});

		expect(keypair.type).toBe('Multikey');
		expect(keypair.id).toBe(jwk2020.id);
		expect(keypair).toHaveProperty('publicKeyMultibase');
		expect(keypair).toHaveProperty('secretKeyMultibase');
	});

	it('generates as X25519KeyAgreementKey2019', async () => {
		const keypair = await JsonWebKeyPair.generate({ kty: 'OKP', crv: 'X25519' });
		expect(keypair.type).toBe('X25519KeyAgreementKey2019');
		expect(keypair).toHaveProperty('publicKeyBase58');
		expect(keypair).toHaveProperty('privateKeyBase58');
	});
});
