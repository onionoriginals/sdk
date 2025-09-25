import { Ed25519VerificationKey2018 } from '../../../lib/crypto/keypairs/Ed25519VerificationKey2018';
import { base58, base64url } from '../../../lib/crypto/utils/encoding';
import { describe, expect, it } from 'bun:test';
import { documentLoader } from '../../fixtures/crypto/documentLoader';

describe('Ed25519VerificationKey2018', () => {
	it('resolves as JWK', async () => {
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2018.json');

		const key = new Ed25519VerificationKey2018(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyBase58,
			ed25519.privateKeyBase58
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.privateKeyJwk!.crv).toBe('Ed25519');
		expect(jwk.privateKeyJwk!.kty).toBe('OKP');
		expect(jwk.privateKeyJwk!.x).toBe(base64url.encode(base58.decode(ed25519.publicKeyBase58)));
		expect(jwk.privateKeyJwk!.d).toBe(base64url.encode(base58.decode(ed25519.privateKeyBase58)));
	});

	it('w/o private key resolves as JWK', async () => {
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2018.json');
		const { privateKeyBase58, ...newKey } = ed25519

		const key = new Ed25519VerificationKey2018(
			newKey.id,
			newKey.controller,
			newKey.publicKeyBase58,
			newKey.privateKeyBase58
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.publicKeyJwk!.crv).toBe('Ed25519');
		expect(jwk.publicKeyJwk!.kty).toBe('OKP');
		expect(jwk.publicKeyJwk!.x).toBe(base64url.encode(base58.decode(ed25519.publicKeyBase58)));
	});

	it(`Can create proof w/ challenge`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2018.json');
		const key = new Ed25519VerificationKey2018(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyBase58,
			ed25519.privateKeyBase58
		);

		const {context, proof} = await key.createProof(
			credential,
			'assertionMethod',
			documentLoader,
			{challenge: 'challenge123'}
		);

		expect(proof.challenge).toBe('challenge123');
		expect(proof.domain).toBeUndefined();
		expect(proof.jws).toBeDefined();
	});
});
