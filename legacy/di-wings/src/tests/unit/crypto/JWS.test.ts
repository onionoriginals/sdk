import { describe, it, expect } from 'bun:test';
import { Buffer } from 'buffer/index.js';
import { documentLoader } from '../../fixtures/crypto/documentLoader';
import { JsonWebSignature2020Suite } from '../../../lib/crypto/JWS/Suite';
import { JsonWebKeyPair } from '../../../lib/crypto';

const plaintext = require('../../fixtures/crypto/plaintext.json');
const jwk2020 = require('../../fixtures/keypairs/JsonWebKey2020.json');
const jws = require('../../fixtures/crypto/jws.json');

describe('JWS', () => {
	it('Can sign data', async () => {
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const result = await suite.sign(Buffer.from(plaintext.body, 'utf-8'));

		expect(result).toBe(jws.jws);
		expect(result).toContain('..');
	});

	it('Can verify data', async () => {
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const result = await suite.verify(Buffer.from(plaintext.body, 'utf-8'), key, { jws: jws.jws });

		expect(result.verified).toBeTrue();
	});

	it(`Can create proof w/ challenge`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const {proof} = await suite.createProof(
			credential,
			'assertionMethod',
			documentLoader,
			{challenge: 'challenge123'}
		);

		expect(proof.challenge).toBe('challenge123');
		expect(proof.domain).toBeUndefined();
	});

	it(`Can create proof w/ domain`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const {proof} = await suite.createProof(
			credential,
			'assertionMethod',
			documentLoader,{domain: 'domain123'}
		);

		expect(proof.domain).toBe('domain123');
		expect(proof.challenge).toBeUndefined();
	});

	it(`Can create proof w/ challenge & domain`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const {proof} = await suite.createProof(
			credential,
			'assertionMethod',
			documentLoader,
			{
				domain: 'domain123',
				challenge: 'challenge123'
			}
		);

		expect(proof.domain).toBe('domain123');
		expect(proof.challenge).toBe('challenge123');
	});

	it(`Can verify proof w/ challenge & domain`, async () => {
		const credential = require(`../../fixtures/credentials/case-1.json`);
		const proof = require('../../fixtures/crypto/proofs/with-challenge-and-domain.json');
		const key = await JsonWebKeyPair.fromJWK(jwk2020);
		const suite = new JsonWebSignature2020Suite({
			key,
			date: new Date().toISOString()
		});

		const result = await suite.verifyProof(proof, credential, documentLoader);

		expect(result.verified).toBeTrue();
	});

	// cases
	['1', '2'].forEach((v) => {
		it(`Can create proof: case-${v}`, async () => {
			const credential = require(`../../fixtures/credentials/case-${v}.json`);
			const key = await JsonWebKeyPair.fromJWK(jwk2020);
			const suite = new JsonWebSignature2020Suite({
				key,
				date: new Date().toISOString()
			});
			
			const {proof} = await suite.createProof(credential, 'assertionMethod', documentLoader);
			expect(proof.proofPurpose).toBe('assertionMethod');
			expect(proof.type).toBe('JsonWebSignature2020');
			expect(proof).toHaveProperty('created');
			expect(proof.verificationMethod).toBe(jwk2020.id);
			expect(proof).toHaveProperty('jws');
			expect(proof.jws).toContain('..');
		});

		it(`Can verify proof: case-${v}`, async () => {
			const credential = require(`../../fixtures/credentials/case-${v}.json`);
			const proof = require(`../../fixtures/crypto/proofs/case-${v}.json`);
			const key = await JsonWebKeyPair.fromJWK(jwk2020);
			const suite = new JsonWebSignature2020Suite({
				key,
				date: new Date().toISOString()
			});

			const result = await suite.verifyProof(proof, credential, documentLoader);

			expect(result.verified).toBeTrue();
		});

		it(`Can create and verify proof: case-${v}`, async () => {
			const credential = require(`../../fixtures/credentials/case-${v}.json`);
			const key = await JsonWebKeyPair.fromJWK(jwk2020);
			const suite = new JsonWebSignature2020Suite({
				key,
				date: new Date().toISOString()
			});

			const {proof} = await suite.createProof(credential, 'assertionMethod', documentLoader);
			const result = await suite.verifyProof(proof, credential, documentLoader);

			expect(result.verified).toBeTrue();
		});
	});
});
