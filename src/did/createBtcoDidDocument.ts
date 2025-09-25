import { DIDDocument, VerificationMethod } from '../types/did';
import { multikey, MultikeyType } from '../crypto/Multikey';

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet';

interface CreateBtcoDidDocumentParams {
	publicKey: Uint8Array;
	keyType: MultikeyType;
	controller?: string;
}

function getDidPrefix(network: BitcoinNetwork): string {
	if (network === 'mainnet') return 'did:btco';
	if (network === 'signet') return 'did:btco:sig';
	if (network === 'testnet') return 'did:btco:test';
	throw new Error(`Unsupported Bitcoin network: ${network}`);
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
	const did = `${getDidPrefix(network)}:${String(satNumber)}`;
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

