import { DIDDocument, VerificationMethod } from '../types/did.js';
import { multikey, MultikeyType } from '../crypto/Multikey.js';
import { canonicalizeSatoshi } from '../utils/satoshi-validation.js';

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';

interface CreateBtcoDidDocumentParams {
	publicKey: Uint8Array;
	keyType: MultikeyType;
	controller?: string;
}

function getDidPrefix(network: BitcoinNetwork): string {
	if (network === 'mainnet') return 'did:btco';
	if (network === 'signet') return 'did:btco:sig';
	if (network === 'regtest') return 'did:btco:reg';
	if (network === 'testnet') return 'did:btco:test';
	const _exhaustiveCheck: never = network;
	throw new Error(`Unsupported Bitcoin network: ${String(_exhaustiveCheck)}`);
}

function buildVerificationMethod(did: string, params: CreateBtcoDidDocumentParams): VerificationMethod {
	const fragment = '#0';
	const id = `${did}${fragment}`;
	const controller = params.controller ?? did;
	return {
		id,
		type: 'Multikey',
		controller,
		publicKeyMultibase: multikey.encodePublicKey(params.publicKey, params.keyType)
	};
}

export function createBtcoDidDocument(
	satNumber: number | string,
	network: BitcoinNetwork,
	params: CreateBtcoDidDocumentParams
): DIDDocument {
	// Validate and canonicalize satNumber at entry. The canonical string (no
	// whitespace, no leading zeros) is what gets embedded in the DID so the
	// identifier is resolvable and matches its canonically-inscribed form.
	let canonicalSat: string;
	try {
		canonicalSat = canonicalizeSatoshi(satNumber);
	} catch (err) {
		throw new Error(`Invalid satoshi number: ${err instanceof Error ? err.message : String(err)}`);
	}

	const did = `${getDidPrefix(network)}:${canonicalSat}`;
	const vm = buildVerificationMethod(did, params);

	const document: DIDDocument = {
		'@context': [
			'https://www.w3.org/ns/did/v1',
			'https://w3id.org/security/multikey/v1'
		],
		id: did,
		verificationMethod: [vm],
		authentication: [vm.id],
		assertionMethod: [vm.id]
	};

	return document;
}

