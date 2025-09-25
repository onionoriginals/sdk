import * as vc from '@digitalbazaar/vc';

import { MULTICODEC_ED25519_PRIV_HEADER, MULTICODEC_ED25519_PUB_HEADER, base64url, multibase, multikey } from '../../../lib/crypto/utils/encoding';
import { describe, expect, it } from 'bun:test';

import { HDKey } from 'micro-ed25519-hdkey';
import { documentLoader } from '../../fixtures/crypto/documentLoader';
import { Ed25519VerificationKey2020 } from '../../../lib/crypto';

describe('Ed25519VerificationKey2020', () => {
	it('fromBase58', async () => {
		const key = 'ByHnpUCFb1vAfh9CFZ8ZkmUZguURW8nSw889hy6rD8L7';
		const keypair = Ed25519VerificationKey2020.fromBase58({ publicKeyBase58: key })
	})
	it('resolves as JWK', async () => {
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2020.json');

		const key = new Ed25519VerificationKey2020(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyMultibase,
			ed25519.privateKeyMultibase
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.privateKeyJwk!.crv).toBe('Ed25519');
		expect(jwk.privateKeyJwk!.kty).toBe('OKP');
		expect(jwk.privateKeyJwk!.x).toBe(base64url.encode(multikey.decode(MULTICODEC_ED25519_PUB_HEADER, ed25519.publicKeyMultibase)));
		expect(jwk.privateKeyJwk!.d).toBe(base64url.encode(multikey.decode(MULTICODEC_ED25519_PRIV_HEADER, ed25519.privateKeyMultibase)));
	});

	it('w/o private key resolves as JWK', async () => {
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2020.json');
		const { privateKeyMultibase, ...newKey } = ed25519;

		const key = new Ed25519VerificationKey2020(
			newKey.id,
			newKey.controller,
			newKey.publicKeyMultibase,
			newKey.privateKeyMultibase
		);

		const jwk = await key.export({ privateKey: true, type: 'JsonWebKey2020' });
		expect(jwk.publicKeyJwk.crv).toEqual('Ed25519');
		expect(jwk.publicKeyJwk.kty).toEqual('OKP');
	});

	it('can generate', async () => {
		const key = await Ed25519VerificationKey2020.generate()
		expect(key.publicKey.length).toEqual(32)
		expect(key).toHaveProperty('publicKey')
		expect(key).toHaveProperty('privateKey')
	})

	it('can create from hd key', async () => {
		const hd = HDKey.fromMasterSeed('fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542')
		// const key = Ed25519VerificationKey2020.fromHD(hd)
		// expect(key.publicKey.length).toEqual(32)
		// expect(key.privateKey!.length).toEqual(64)
		// expect(key.controller).toEqual('did:key:z6Mkp92myXtWkQYxhFmDxqkTwURYZAEjUm9iAuZxyjYzmfSy')
	})

	it('can create valid proof from hd key', async () => {
		const hd = HDKey.fromMasterSeed('fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542')
		const credential = require(`../../fixtures/credentials/case-1.json`);
		// const key = Ed25519VerificationKey2020.fromHD(hd)
		// expect(key.publicKey.length).toEqual(32)
		// expect(key.privateKey!.length).toEqual(64)
		// expect(key.controller).toEqual('did:key:z6Mkp92myXtWkQYxhFmDxqkTwURYZAEjUm9iAuZxyjYzmfSy')
		// const result = await key.createProof(
		// 	credential,
		// 	'assertionMethod',
		// 	documentLoader,
		// 	{ challenge: 'challenge123' }
		// );
		// const verification = await key.verifyProof(result, credential, documentLoader)
		// expect(verification.verified).toBeTruthy()
	})


	it(`Can create proof w/ challenge`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2020.json');

		const key = new Ed25519VerificationKey2020(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyMultibase,
			ed25519.privateKeyMultibase
		);

		const {context, proof} = await key.createProof(
			credential,
			'assertionMethod',
			documentLoader,
			{ challenge: 'challenge123' }
		);

		expect(proof.challenge).toBe('challenge123');
		expect(proof.domain).toBeUndefined();
		expect(proof).toHaveProperty('proofValue')
	});

	it(`Can verify proof case-1`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2020.json');
		const key = new Ed25519VerificationKey2020(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyMultibase,
			ed25519.privateKeyMultibase
		);

		const {context, proof} = await key.createProof(
			credential,
			'assertionMethod',
			documentLoader,
			{ challenge: 'challenge123' }
		);
		const result = await key.verifyProof(proof, credential, documentLoader)
		expect(result.verified).toBeTruthy()
	});

	it(`debug`, async () => {
		const ed25519 = require('../../fixtures/keypairs/Ed25519VerificationKey2020.json');
		const key = new Ed25519VerificationKey2020(
			ed25519.id,
			ed25519.controller,
			ed25519.publicKeyMultibase,
			ed25519.privateKeyMultibase
		);
		const p = {
			'@context': [
				'https://www.w3.org/2018/credentials/v1',
				"https://w3id.org/security/suites/ed25519-2020/v1"
			],
			holder: key.controller,
			type: ['VerifiablePresentation'],
			verifiableCredential: []
		};
		let {proof} = await key.createProof(p, 'authentication', documentLoader, { challenge: '72Jd0frtFmvKjQV65BFz4', domain: 'https://localhost:51433' })
		expect(proof.challenge).toBe('72Jd0frtFmvKjQV65BFz4')
		let verify = await key.verifyProof(proof, p, documentLoader)
		expect(verify.verified).toBeTruthy()
		// {
		// 	type: 'vc-ld',
		// 	suite: key,
		// 	challenge: 'challenge',
		// 	domain: 'domain',
		// 	documentLoader
		// });
	})
});
