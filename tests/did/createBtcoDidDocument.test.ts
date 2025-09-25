import { createBtcoDidDocument } from '../../src/did/createBtcoDidDocument';
import { multikey } from '../../src/crypto/Multikey';

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

	it('creates document for testnet with proper prefix', () => {
		const pub = rangeBytes(33, 3);
		const doc = createBtcoDidDocument(123456, 'testnet', { publicKey: pub, keyType: 'Secp256k1' });
		expect(doc.id).toBe('did:btco:test:123456');
		const vm = doc.verificationMethod![0];
		expect(vm.id).toBe('did:btco:test:123456#0');
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
			// @ts-expect-error testing invalid network
			createBtcoDidDocument('1', 'regtest', { publicKey: pub, keyType: 'Ed25519' })
		).toThrow('Unsupported Bitcoin network: regtest');
	});
});

