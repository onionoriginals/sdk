import { describe, test, expect, it } from 'bun:test';
import { createBtcoDidDocument } from '../../../src/did/createBtcoDidDocument';
import { multikey } from '../../../src/crypto/Multikey';

function rangeBytes(len: number, start: number): Uint8Array {
	return new Uint8Array(len).map((_, i) => (start + i) & 0xff);
}

describe('createBtcoDidDocument', () => {
	it('creates document for mainnet with deterministic fragment and relationships', () => {
		const pub = rangeBytes(32, 1);
		const doc = createBtcoDidDocument('1066296127976657', 'mainnet', { publicKey: pub, keyType: 'Ed25519' });
		expect(doc['@context']).toEqual([
			'https://www.w3.org/ns/did/v1',
			'https://w3id.org/security/multikey/v1'
		]);
		expect(doc.id).toBe('did:btco:1066296127976657');
		expect(doc.verificationMethod?.length).toBe(1);
		const vm = doc.verificationMethod![0];
		expect(vm.id).toBe('did:btco:1066296127976657#0');
		expect(vm.type).toBe('Multikey');
		expect(vm.controller).toBe(doc.id);
		expect(doc.authentication).toEqual([vm.id]);
		expect(doc.assertionMethod).toEqual([vm.id]);
		const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
		expect(decoded.type).toBe('Ed25519');
		expect(Array.from(decoded.key)).toEqual(Array.from(pub));
	});

	it('creates document for regtest with proper prefix', () => {
		const pub = rangeBytes(33, 3);
		const doc = createBtcoDidDocument(123456, 'regtest', { publicKey: pub, keyType: 'Secp256k1' });
		expect(doc.id).toBe('did:btco:reg:123456');
		const vm = doc.verificationMethod![0];
		expect(vm.id).toBe('did:btco:reg:123456#0');
		const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
		expect(decoded.type).toBe('Secp256k1');
		expect(Array.from(decoded.key)).toEqual(Array.from(pub));
	});

	it('creates document for signet with proper prefix', () => {
		const pub = rangeBytes(96, 5);
		const doc = createBtcoDidDocument(999, 'signet', { publicKey: pub, keyType: 'Bls12381G2' });
		expect(doc.id).toBe('did:btco:sig:999');
		const vm = doc.verificationMethod![0];
		expect(vm.id).toBe('did:btco:sig:999#0');
		const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
		expect(decoded.type).toBe('Bls12381G2');
		expect(Array.from(decoded.key)).toEqual(Array.from(pub));
	});

	it('supports overriding controller', () => {
		const pub = rangeBytes(32, 7);
		const controller = 'did:example:controller';
		const doc = createBtcoDidDocument('42', 'mainnet', { publicKey: pub, keyType: 'Ed25519', controller });
		expect(doc.verificationMethod![0].controller).toBe(controller);
	});

	it('throws on unsupported network', () => {
		const pub = rangeBytes(32, 9);
		expect(() =>
			// @ts-expect-error testing invalid network ('testnet' is now supported)
			createBtcoDidDocument('1', 'mars', { publicKey: pub, keyType: 'Ed25519' })
		).toThrow('Unsupported Bitcoin network: mars');
	});

	it('canonicalizes a satoshi string with surrounding whitespace into a resolvable id', () => {
		// Regression: validateSatoshiNumber trims before validating, so ' 42 ' passes,
		// but the emitted id must not contain the raw whitespace (which would be
		// unresolvable). Previously produced "did:btco: 42 ".
		const pub = rangeBytes(32, 1);
		const doc = createBtcoDidDocument(' 42 ', 'mainnet', { publicKey: pub, keyType: 'Ed25519' });
		expect(doc.id).toBe('did:btco:42');
		expect(doc.verificationMethod![0].id).toBe('did:btco:42#0');
		expect(doc.verificationMethod![0].controller).toBe('did:btco:42');
		expect(doc.authentication).toEqual(['did:btco:42#0']);
	});

	it('strips non-canonical leading zeros so the id matches the inscribed form', () => {
		// Regression: '007' passed validation but produced "did:btco:007", which
		// never equals the canonically-inscribed "did:btco:7".
		const pub = rangeBytes(32, 2);
		const doc = createBtcoDidDocument('007', 'regtest', { publicKey: pub, keyType: 'Ed25519' });
		expect(doc.id).toBe('did:btco:reg:7');
		expect(doc.verificationMethod![0].id).toBe('did:btco:reg:7#0');
	});
});

