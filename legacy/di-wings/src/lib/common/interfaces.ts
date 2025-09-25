import type { JsonWebKey2020, JsonWebKeyPair } from '../crypto/index.js';
import type { Ed25519VerificationKey2018 } from '../crypto/keypairs/Ed25519VerificationKey2018.js';
import type { Ed25519VerificationKey2020 } from '../crypto/keypairs/Ed25519VerificationKey2020.js';
import type { Secp256k1KeyPair } from '../crypto/keypairs/Secp256k1KeyPair.js';
import type { X25519KeyAgreementKey2019 } from '../crypto/keypairs/X25519KeyAgreementKey2019.js';
import type { X25519KeyAgreementKey2020 } from '../crypto/keypairs/X25519KeyAgreementKey2020.js';

export interface JWTPayload {
    iss?: string;
    sub?: string;
    aud?: string;
    exp?: number;
    nbf?: number;
    iat?: number;
    jt?: string;
    [x: string]: any;
}

export interface Header {
	typ?: string;
	alg: string;
	kid: string;
	apu?: string;
	apv?: string;
	epk?: IJWK;
}

export interface IJWE {
	protected: string;
	iv: string;
	ciphertext: string;
	tag: string;
	aad?: string;
	recipients?: { header: Header; encrypted_key: string }[];
}

export interface IJWS {
	header: Header;
	payload: string;
	signature: string;
	protected?: string;
}

export interface IJWK {
	alg?: string;
	crv: string;
	d?: string;
	dp?: string;
	dq?: string;
	e?: string;
	ext?: boolean;
	k?: string;
	key_ops?: string[];
	kid?: string;
	kty: string;
	n?: string;
	oth?: Array<{
		d?: string;
		r?: string;
		t?: string;
	}>;
	p?: string;
	q?: string;
	qi?: string;
	use?: string;
	x?: string;
	y?: string;
	x5c?: string[];
	x5t?: string;
	'x5t#S256'?: string;
	x5u?: string;
	[propName: string]: unknown
}

export type DocumentLoader = (
	uri: string
) => Promise<{ document: any; documentUrl: string; contextUrl: string }>;

export interface LinkedDataSuite {
	type: string;
	date: string;
	context: string;

	createProof: (
		document: any,
		purpose: string,
		documentLoader: DocumentLoader,
		{domain, challenge}: {
			domain?: string,
			challenge?: string
		}
	) => Promise<{context: string[], proof: ILinkedDataProof}>;

	verifyProof: (
		proofDocument: ILinkedDataProof,
		document: any,
		documentLoader: DocumentLoader
	) => Promise<VerificationResult>;
}

export type AnyKeyType = Ed25519VerificationKey2020 | Ed25519VerificationKey2018 | X25519KeyAgreementKey2019 | X25519KeyAgreementKey2020 | Secp256k1KeyPair;

export interface VerificationResult {
	verified: boolean;
	/**
	 * The checks performed
	 */
	checks?: Array<string>;
	/**
	 * Warnings
	 */
	warnings?: Array<string>;
	/**
	 * Errors
	 */
	errors?: Array<string>;
}

export interface ProofVerification {
	verified: boolean;
	error: string;
}

export enum IProofPurpose {
  verificationMethod = 'verificationMethod',
  assertionMethod = 'assertionMethod',
  authentication = 'authentication',
  keyAgreement = 'keyAgreement',
  contractAgreement = 'contactAgreement',
  capabilityInvocation = 'capabilityInvocation',
  capabilityDelegation = 'capabilityDelegation',
}

export enum IProofType {
  Ed25519Signature2018 = 'Ed25519Signature2018',
  Ed25519Signature2020 = 'Ed25519Signature2020',
  EcdsaSecp256k1Signature2019 = 'EcdsaSecp256k1Signature2019',
  EcdsaSecp256k1RecoverySignature2020 = 'EcdsaSecp256k1RecoverySignature2020',
  JsonWebSignature2020 = 'JsonWebSignature2020',
  RsaSignature2018 = 'RsaSignature2018',
  GpgSignature2020 = 'GpgSignature2020',
  JcsEd25519Signature2020 = 'JcsEd25519Signature2020',
  BbsBlsSignatureProof2020 = 'BbsBlsSignatureProof2020',
  BbsBlsBoundSignatureProof2020 = 'BbsBlsBoundSignatureProof2020',
}

/**
 * A JSON-LD Linked Data proof.
 */
 export interface ILinkedDataProof {
  type: IProofType | string // The proof type
  created?: string // The ISO8601 date-time string for creation
  proofPurpose: IProofPurpose | string // The specific intent for the proof
  verificationMethod: string // A set of parameters required to independently verify the proof
  challenge?: string // A challenge to protect against replay attacks
  domain?: string // A string restricting the (usage of a) proof to the domain and protects against replay attacks
	cryptosuite?: string // The cryptosuite used to create the proof
  proofValue?: string // One of any number of valid representations of proof values
  jws?: string // JWS based proof
  nonce?: string // Similar to challenge. A nonce to protect against replay attacks, used in some ZKP proofs
  requiredRevealStatements?: string[] // The parts of the proof that must be revealed in a derived proof
}

export interface JWTCredential {
	/**
	 * The credential subject ID
	 */
	sub?: string;
	/**
	 * The ID of the credential
	 */
	jti?: string;
	/**
	 * The issuer of the credential
	 */
	iss: string;
	/**
	 * The issuance date of the credential (unix timestamp)
	 */
	nbf: number;
	/**
	 * The issuance date of the credential (unix timestamp)
	 */
	iat: number;
	/**
	 * The expiry date of the credential (unix timestamp)
	 */
	exp?: number;
	/**
	 * The nonce included in the signed data payload
	 */
	nonce: string;
	/**
	 * The remaining credential properties
	 */
	vc: {
		'@context': Array<string> | string;
		type: string[];
		credentialSubject: any;
		[k: string]: any;
	};
}

/**
 * A JSON-LD Credential.
 */
export interface Credential {
	/**
	 * The JSON-LD context of the credential.
	 */
	'@context': Array<string> | string;
	/**
	 * The ID of the credential.
	 */
	id?: string;
	/**
	 * The JSON-LD type of the credential.
	 */
	type: string[];
	issuer?: { id: string, name?: string, image?: string, url?: string, type?: string } | string;
	/**
	 * The issuanceDate
	 */
	issuanceDate?: string;
	/**
	 * The expirationDate
	 */
	expirationDate?: string;
	/**
	 * The credential subject
	 */
	credentialSubject: {
		/**
		 * credential subject ID
		 */
		id?: string;
		[k: string]: any;
	};
	/**
	 * The status of the credential
	 */
	credentialStatus?: {
		id: string;
		type: string;
	};

  [x: string]: unknown
}

/**
 * A JSON-LD Presentation.
 */
export interface Presentation {
	/**
	 * The JSON-LD context of the presentation.
	 */
	'@context': Array<string> | string;
	/**
	 * The ID of the presentation.
	 */
	id?: string;
	/**
	 * The JSON-LD type of the presentation.
	 */
	type: string[];
	/**
	 * The Verifiable Credentials included in the presentation
	 */
	verifiableCredential?: Array<VerifiableCredential> | VerifiableCredential;
	/**
	 * The holder of the presentation
	 */
	holder: {
		id: string;
	};
  [x: string]: unknown
}

export interface VerifiablePresentation extends Presentation {
	proof: ILinkedDataProof | Array<ILinkedDataProof>;
}

export interface VerifiableCredential extends Credential {
	proof: ILinkedDataProof | Array<ILinkedDataProof>;
}

export interface LinkedDataKey {
	id: string;
	type: string;
}

export interface ProofVerificationResult {
	verified: boolean;
	error?: string;
}


// export interface SignatureSuite {
//   key?: JsonWebKey | LinkedDataKey;

//   getVerificationMethod: (options: {
//     proof: LinkedDataProof;
//     documentLoader: DocumentLoader;
//   }) => Promise<JsonWebKey | LinkedDataKey>;

//   deriveProof?: (
//     verifiableCredential: VerifiableCredential,
//     frame: object
//   ) => Promise<VerifiableCredential>;

//   createProof: (
//     credential: Credential | JWTCredential,
//     proofPurpose: string,
//     options: { documentLoader: DocumentLoader }
//   ) => Promise<LinkedDataProof>;

//   verifyProof: (
//     proof: LinkedDataProof,
//     verifiableCredential: VerifiableCredential,
//     options: { documentLoader: DocumentLoader }
//   ) => Promise<ProofVerification>;
// }

/**
 * A secret.
 */
export interface ISecret {
  id: string;
  type: string;
  /** The value of the private key in PEM format. Only one value field will be present. */
  privateKeyPem?: string;

  /** The value of the private key in JWK format. Only one value field will be present. */
  privateKeyJwk?: any;

  /** The value of the private key in hex format. Only one value field will be present. */
  privateKeyHex?: string;

  /** The value of the private key in Base64 format. Only one value field will be present. */
  privateKeyBase64?: string;

  /** The value of the private key in Base58 format. Only one value field will be present. */
  privateKeyBase58?: string;

  /** The value of the private key in Multibase format. Only one value field will be present. */
  privateKeyMultibase?: string;

  asJsonWebKey(): Promise<JsonWebKey2020>;
}

export interface ISecretResolver {
  resolve(id: string): Promise<ISecret>;
}

/**
 * A verification method definition entry in a DID Document.
 */
export interface IDIDDocumentVerificationMethod {
  /** Fully qualified identifier of this public key, e.g. did:example:123#key-1 */
  id: string;

  /** The type of this public key, as defined in: https://w3c-ccg.github.io/ld-cryptosuite-registry/ */
  type: string;

  /** The DID of the controller of this key. */
  controller: string;

  /** The value of the public key in PEM format. Only one value field will be present. */
  publicKeyPem?: string;

  /** The value of the public key in JWK format. Only one value field will be present. */
  publicKeyJwk?: IJWK;

  /** The value of the public key in hex format. Only one value field will be present. */
  publicKeyHex?: string;

  /** The value of the public key in Base64 format. Only one value field will be present. */
  publicKeyBase64?: string;

  /** The value of the public key in Base58 format. Only one value field will be present. */
  publicKeyBase58?: string;

  /** The value of the public key in Multibase format. Only one value field will be present. */
  publicKeyMultibase?: string;

  /** Returns the public key in JWK format regardless of the current type */
  asJsonWebKey?: () => Promise<JsonWebKey2020>;

  toJSON?: () => object;
}

/**
 * A verification method with secret key information.
 */
export interface PrivateVerificationMethod extends IDIDDocumentVerificationMethod {
  secretKeyMultibase?: string;
}

/**
 * Defines a service descriptor entry present in a DID Document.
 */
export interface IDIDDocumentServiceDescriptor {
  /** id of this service, e.g. `did:example:123#id`. */
  id: string;

  /** The type of this service. */
  type: string;

  /** The endpoint of this service. */
  serviceEndpoint: string | any;

  /** didcomm service extension */
  routingKeys: string[];
}

/**
 * Decentralized Identity Document.
 */
export interface IDIDDocument {
  /** The JSON Document (self) */
  document: object;

  /** The JSON-LD context of the DID Documents. */
  "@context": string[] | string;

  /** The DID to which this DID Document pertains. */
  id: string;

  /** The controller of the DID */
  controller?: string;

  /** This DID is also known as */
  alsoKnownAs?: string;

  /** Array of verification methods associated with the DID. */
  verificationMethod?: IDIDDocumentVerificationMethod[];

  /** Array of services associated with the DID. */
  service?: IDIDDocumentServiceDescriptor[];

  /** Array of authentication methods. */
  authentication?: IDIDDocumentVerificationMethod[];

  /** Array of assertion methods. */
  assertionMethod?: IDIDDocumentVerificationMethod[];

  /** Array of key agreement methods */
  keyAgreement?: IDIDDocumentVerificationMethod[];

  /** Array of capability invocation methods */
  capabilityInvocation?: IDIDDocumentVerificationMethod[];

  /** Array of capability delegation methods */
  capabilityDelegation?: IDIDDocumentVerificationMethod[];

  normalizeVerificationMethod: (
    methods: (string | IDIDDocumentVerificationMethod)[]
  ) => IDIDDocumentVerificationMethod[];
  getVerificationMethodById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  getServiceById: (id: string) => IDIDDocumentServiceDescriptor | undefined;
  getServiceByType: (type: string) => IDIDDocumentServiceDescriptor | undefined;
  getKeyAgreementById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  getAllKeyAgreements: () => IDIDDocumentVerificationMethod[];
  getAuthenticationById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  getCapabilityInvocationById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  getCapabilityDelegationById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  getAssertionMethodById: (id: string) => IDIDDocumentVerificationMethod | undefined;
  toJSON: () => object;
}

export interface IDIDResolver {
  resolve(id: string): Promise<IDIDDocument>;
}

export interface Readable<T> {
  subscribe(run: (value: T) => void, invalidate?: (value?: T) => void): () => void;
}

export interface StartStopNotifier<T> {
  (set: (value: T) => void): (() => void) | void;
}

export declare function readable<T>(
  value?: T,
  start?: StartStopNotifier<T>
): Readable<T>;