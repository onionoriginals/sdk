# Originals SDK API Reference

> Complete API documentation for the Originals SDK v1.0

## Table of Contents

- [OriginalsSDK](#originalssdk)
- [DIDManager](#didmanager)
- [CredentialManager](#credentialmanager)
- [LifecycleManager](#lifecyclemanager)
- [BitcoinManager](#bitcoinmanager)
- [Types](#types)
- [Error Handling](#error-handling)

---

## OriginalsSDK

The main entry point for the Originals SDK. Orchestrates all managers and provides unified access to protocol functionality.

### Creating an Instance

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

// Basic creation with defaults
const sdk = OriginalsSDK.create();

// Full configuration
const sdk = OriginalsSDK.create({
  network: 'mainnet',              // 'mainnet' | 'testnet' | 'signet' | 'regtest'
  webvhNetwork: 'pichu',           // 'pichu' | 'cleffa' | 'magby'
  defaultKeyType: 'ES256K',        // 'ES256K' | 'Ed25519' | 'ES256'
  ordinalsProvider: new OrdMockProvider(),  // Required for Bitcoin ops
  enableLogging: true,
  feeOracle: customFeeOracle,      // Optional
  storageAdapter: customStorage,    // Optional
});
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `did` | `DIDManager` | Manages DID operations across all three layers |
| `credentials` | `CredentialManager` | Handles Verifiable Credential creation and verification |
| `lifecycle` | `LifecycleManager` | Orchestrates asset migration between layers |
| `bitcoin` | `BitcoinManager` | Bitcoin/Ordinals inscription and transfer |
| `logger` | `Logger` | SDK logging instance |
| `metrics` | `MetricsCollector` | Performance metrics collector |

### Static Methods

#### `OriginalsSDK.create(options?)`

Factory method to create an SDK instance with sensible defaults.

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  enableLogging: true,
});
```

#### `OriginalsSDK.prepareDIDDataForSigning(document, proof)`

Prepare DID data for signing using canonical serialization.

```typescript
const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(
  didDocument,
  proofOptions
);
```

#### `OriginalsSDK.verifyDIDSignature(signature, message, publicKey)`

Verify an Ed25519 signature on DID data.

```typescript
const isValid = await OriginalsSDK.verifyDIDSignature(
  signatureBytes,
  messageBytes,
  publicKeyBytes
);
```

### Instance Methods

#### `validateBitcoinConfig()`

Validates that the SDK is properly configured for Bitcoin operations. Throws `StructuredError` if `ordinalsProvider` is not configured.

```typescript
try {
  sdk.validateBitcoinConfig();
  // Safe to perform Bitcoin operations
} catch (error) {
  console.error('Bitcoin operations not available:', error.message);
}
```

---

## DIDManager

Manages Decentralized Identifier operations across all three protocol layers.

### Methods

#### `createDIDPeer(options)`

Create a `did:peer` identifier for private, offline use.

```typescript
const result = await sdk.did.createDIDPeer({
  keyType: 'Ed25519',
  // Additional options...
});

console.log(result.did);  // "did:peer:2.Ez6LSm..."
```

**Returns:** `{ did: string, document: DIDDocument, keyPair: KeyPair }`

#### `createDIDWebVH(options)`

Create a `did:webvh` identifier for public web discovery.

```typescript
const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['users', 'alice'],
  externalSigner: signer,
  verificationMethods: [{
    type: 'Multikey',
    publicKeyMultibase: 'z6Mk...'
  }],
  updateKeys: ['did:key:z6Mk...'],
  outputDir: './public/.well-known',
});

console.log(result.did);  // "did:webvh:example.com:users:alice"
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | `string` | Yes | Domain for the DID |
| `paths` | `string[]` | No | Path segments for the DID |
| `externalSigner` | `ExternalSigner` | Yes* | External key management signer |
| `verificationMethods` | `VerificationMethod[]` | Yes | Public keys for the DID |
| `updateKeys` | `string[]` | Yes | Keys authorized to update the DID |
| `outputDir` | `string` | No | Directory to write DID log files |

*Either `externalSigner` or `keyPair` must be provided, not both.

#### `updateDIDWebVH(options)`

Update an existing `did:webvh` identifier.

```typescript
const result = await sdk.did.updateDIDWebVH({
  did: 'did:webvh:example.com:alice',
  currentLog: existingLog,
  updates: {
    service: [{
      id: '#my-service',
      type: 'LinkedDomains',
      serviceEndpoint: 'https://example.com'
    }]
  },
  signer: keyPair,
});
```

#### `migrateToDIDBtco(didDoc, satoshi)`

Migrate a DID document to Bitcoin via Ordinals inscription.

```typescript
const result = await sdk.did.migrateToDIDBtco(
  didDocument,
  12345  // Satoshi number
);

console.log(result.did);  // "did:btco:main:12345"
```

#### `resolveDID(did)`

Universal DID resolution for all supported methods.

```typescript
const { document, metadata } = await sdk.did.resolveDID('did:webvh:example.com:alice');
```

**Supported Methods:** `did:peer`, `did:webvh`, `did:btco`, `did:key`

#### `loadDIDLog(path)`

Load an existing DID log from a JSONL file.

```typescript
const log = await sdk.did.loadDIDLog('./public/.well-known/did.jsonl');
```

---

## CredentialManager

Handles W3C Verifiable Credential creation, signing, and verification.

### Methods

#### `createCredential(options)`

Create a new Verifiable Credential.

```typescript
const credential = await sdk.credentials.createCredential({
  type: ['VerifiableCredential', 'ResourceCreated'],
  issuer: 'did:webvh:example.com:issuer',
  subject: {
    id: 'did:peer:2.Ez6LSm...',
    resource: {
      id: 'resource-123',
      type: 'image',
      contentType: 'image/png',
      hash: 'sha256-abc123...'
    }
  },
  issuanceDate: new Date().toISOString(),
});
```

#### `signCredential(credential, options)`

Sign a credential with Data Integrity proof.

```typescript
const signedCredential = await sdk.credentials.signCredential(credential, {
  signer: keyPair,
  cryptosuite: 'eddsa-rdfc-2022',
  verificationMethod: 'did:webvh:example.com:issuer#key-1'
});
```

**Supported Cryptosuites:**
- `eddsa-rdfc-2022` - EdDSA signatures (recommended)
- `bbs-2023` - BBS+ signatures for selective disclosure

#### `verifyCredential(credential)`

Verify a signed credential.

```typescript
const result = await sdk.credentials.verifyCredential(signedCredential);

if (result.verified) {
  console.log('Credential is valid');
} else {
  console.log('Verification failed:', result.errors);
}
```

**Returns:**

```typescript
interface VerificationResult {
  verified: boolean;
  errors?: string[];
  issuer?: string;
  issuanceDate?: string;
}
```

---

## LifecycleManager

Orchestrates asset migration through the three protocol layers.

### Methods

#### `createAsset(resources)`

Create a new digital asset with associated resources.

```typescript
const asset = await sdk.lifecycle.createAsset([
  {
    id: 'artwork-1',
    type: 'image',
    contentType: 'image/png',
    hash: 'sha256-...',
    url: 'https://example.com/artwork.png'
  }
]);
```

#### `publishToWeb(asset, domain)`

Migrate an asset from `did:peer` to `did:webvh`.

```typescript
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
console.log(published.did);  // "did:webvh:example.com:..."
```

#### `inscribeOnBitcoin(asset)`

Migrate an asset to Bitcoin via Ordinals inscription.

```typescript
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset);
console.log(inscribed.did);  // "did:btco:main:..."
```

### Events

The LifecycleManager emits events during operations:

```typescript
sdk.lifecycle.on('asset.created', (event) => {
  console.log('Asset created:', event.did);
});

sdk.lifecycle.on('asset.migrated', (event) => {
  console.log(`Migrated from ${event.fromLayer} to ${event.toLayer}`);
});

sdk.lifecycle.on('resource.published', (event) => {
  console.log('Resource published:', event.resourceId);
});
```

---

## BitcoinManager

Handles Bitcoin/Ordinals operations for `did:btco` layer.

### Methods

#### `inscribeData(data, contentType)`

Inscribe arbitrary data on Bitcoin.

```typescript
const inscription = await sdk.bitcoin.inscribeData(
  JSON.stringify(didDocument),
  'application/json'
);

console.log(inscription.inscriptionId);
console.log(inscription.satoshi);
```

**Note:** Requires `ordinalsProvider` to be configured.

#### `transferInscription(inscriptionId, address)`

Transfer an inscription to a new owner.

```typescript
const result = await sdk.bitcoin.transferInscription(
  'abc123...i0',
  'bc1q...'
);
```

#### `inscribeDID(didDocument)`

Inscribe a DID document as an Ordinal.

```typescript
const result = await sdk.bitcoin.inscribeDID(didDocument);
console.log(result.did);  // "did:btco:main:..."
```

#### `transferDID(did, newOwnerAddress)`

Transfer DID ownership to a new Bitcoin address.

```typescript
const result = await sdk.bitcoin.transferDID(
  'did:btco:main:12345',
  'bc1qnewowner...'
);
```

---

## Types

### OriginalsConfig

```typescript
interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  webvhNetwork?: 'pichu' | 'cleffa' | 'magby';
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  ordinalsProvider?: OrdinalsProvider;
  feeOracle?: FeeOracleAdapter;
  storageAdapter?: StorageAdapter;
  enableLogging?: boolean;
  logging?: LoggingConfig;
  telemetry?: TelemetryHooks;
}
```

### ExternalSigner

Interface for external key management systems.

```typescript
interface ExternalSigner {
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;
  
  getVerificationMethodId(): Promise<string> | string;
}
```

### DIDDocument

W3C DID Document structure.

```typescript
interface DIDDocument {
  '@context': string | string[];
  id: string;
  controller?: string | string[];
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
}
```

---

## Error Handling

The SDK uses `StructuredError` for consistent error handling.

```typescript
import { StructuredError } from '@originals/sdk';

try {
  await sdk.bitcoin.inscribeData(data, 'application/json');
} catch (error) {
  if (error instanceof StructuredError) {
    console.log('Error code:', error.code);
    console.log('Message:', error.message);
    
    switch (error.code) {
      case 'ORD_PROVIDER_REQUIRED':
        // Handle missing provider
        break;
      case 'INVALID_SATOSHI':
        // Handle invalid satoshi number
        break;
      case 'INSUFFICIENT_FUNDS':
        // Handle funding issue
        break;
    }
  }
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `ORD_PROVIDER_REQUIRED` | Bitcoin operations require ordinalsProvider |
| `INVALID_SATOSHI` | Invalid satoshi number provided |
| `INVALID_ADDRESS` | Invalid Bitcoin address |
| `INSUFFICIENT_FUNDS` | Not enough funds for operation |
| `DID_NOT_FOUND` | DID could not be resolved |
| `INVALID_SIGNATURE` | Credential signature verification failed |
| `MIGRATION_FAILED` | Asset migration failed |

---

## Network Configuration

### WebVH Networks

| Network | Bitcoin | Stability | Use Case |
|---------|---------|-----------|----------|
| `pichu` | mainnet | Major releases only | Production |
| `cleffa` | signet | Minor releases | Staging |
| `magby` | regtest | All versions | Development |

### Cost Estimates

| Layer | Cost | Frequency |
|-------|------|-----------|
| `did:peer` | $0 | N/A |
| `did:webvh` | ~$25/year | Domain renewal |
| `did:btco` | $75-200 | One-time inscription |

---

## See Also

- [README.md](../README.md) - Quick start guide
- [CLAUDE.md](../CLAUDE.md) - Development guide
- [LLM_AGENT_GUIDE.md](./LLM_AGENT_GUIDE.md) - Comprehensive LLM reference
- [ORIGINALS_SPECIFICATION_v1.0.md](../ORIGINALS_SPECIFICATION_v1.0.md) - Protocol specification
