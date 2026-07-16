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
  network: 'mainnet',              // 'mainnet' | 'regtest' | 'signet'
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

> **Genesis is not created here.** Assets are minted offline via
> `sdk.lifecycle.createAsset(...)`, which appends a `create` event to the asset's
> CEL and derives a `did:cel` genesis identifier (`asset.id`). There is no
> `createDIDPeer` — `did:peer` is deprecated as a creation method (the verifier
> keeps a read-only path for pre-existing `did:peer:4` logs). `DIDManager` covers
> the public/on-chain layers (`did:webvh`, `did:btco`) and resolution.

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

#### `migrateToDIDBTCO(didDoc, satoshi)`

Derive the `did:btco` DID document for a satoshi. The DID **is** the satoshi
(`did:btco:<sat>` on mainnet; `did:btco:sig:<sat>` / `did:btco:reg:<sat>` on
signet/regtest). For the full asset flow use `sdk.lifecycle.inscribeOnBitcoin(asset)`.

```typescript
const result = await sdk.did.migrateToDIDBTCO(
  didDocument,
  '1234567890'  // Satoshi number (string)
);

console.log(result.id);  // "did:btco:1234567890"
```

#### `resolveDID(did)`

Universal DID resolution for all supported methods. Returns the DID document,
or `null` if it cannot be resolved.

```typescript
const document = await sdk.did.resolveDID('did:webvh:example.com:alice');
```

**Supported Methods:** `did:cel` (genesis), `did:webvh`, `did:btco`, `did:key`
(`did:peer` resolves for legacy read only).

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
    id: 'did:cel:uEiD...',
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

Orchestrates asset migration through the three protocol layers. **An Original asset
IS a Cryptographic Event Log (CEL):** every *authorship* op (`create`, `migrate`,
`update`, `rotateKey`) appends a signed, hash-chained event to `asset.celLog`, which
is the source of provenance truth. Ownership is the exception — it IS live Bitcoin sat
control, not a log event (see `transferOwnership` / `getCurrentOwner`).

### Methods

#### `createAsset(resources)`

Mint a new asset. Appends a `create` event and derives a `did:cel` genesis
identifier (`asset.id`); the asset starts on the `did:cel` layer (offline, free).

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
console.log(asset.id);  // "did:cel:uEiD..."
```

#### `publishToWeb(asset, domain)`

Migrate an asset to `did:webvh` for public discovery (appends a `migrate` event).

```typescript
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
console.log(published.id);  // asset.id stays did:cel; adds a did:webvh binding
```

#### `inscribeOnBitcoin(asset, options?)`

Migrate an asset to Bitcoin via Ordinals inscription (appends a `migrate` event). This
is the FINAL layer — there is no `did:webvh` fallback afterward. The btco anchoring
inscription's *content* is the asset's current media; its CBOR *metadata* carries the
did:btco DID doc (with a `#cel` anchor) plus the full CEL log, so provenance is
recoverable from a bare sat.

`options` is either a bare fee-rate number (legacy; provider picks the sat) or an
`InscribeOnBitcoinOptions` object. Providing `fundingUtxo` selects the genesis sat: the
`did:btco:<sat>` lands on that UTXO's first sat (derived from the provider's sat index,
never caller-asserted).

```typescript
// Legacy / dev: provider picks the sat
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset);

// Caller-selected genesis sat
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset, {
  fundingUtxo,          // Utxo whose first sat becomes the did:btco identity
  satSigner,            // BitcoinSigner that signs the commit PSBT
  changeAddress: 'bc1q...',
  feeRate: 5,
});
```

#### `transferOwnership(asset, newOwner)`

Transfer ownership — a pure Bitcoin **sat move** that writes **NOTHING** to the CEL
(the CEL is authorship-only; ownership IS sat control). Returns the Bitcoin transaction.
There is no `transfer` CEL event: the legacy `transfer` type is read-only and the SDK
no longer emits it.

```typescript
const tx = await sdk.lifecycle.transferOwnership(asset, 'bc1qnewowner...');
```

#### `getCurrentOwner(asset)`

Read ownership **live** from Bitcoin (never from a log event). Returns
`{ address, outpoint }` or `null`.

```typescript
const owner = await sdk.lifecycle.getCurrentOwner(asset);
```

#### `rotateBtcoKeys(asset, newVerificationMethod, feeRate?)`

Cooperative key rotation: reinscribe the same-id did:btco doc with a new key, signed by
the outgoing controller (appends a `rotateKey` event). `privateKey` is optional here.

#### `authorizeSigner(asset, newVerificationMethod, feeRate?)`

Author-enablement (renamed from `claimOwnership`, #366). Does **not** grant or claim
ownership — the sat is ownership. It lets a sat holder who cannot obtain the seller's
signature establish a signing key so they can author new provenance: they reinscribe the
did:btco doc with THEIR key and **self-sign** the `rotateKey`. `privateKey` is REQUIRED.

```typescript
await sdk.lifecycle.authorizeSigner(asset, {
  publicKeyMultibase: 'z6Mk...',
  privateKey: 'z...'  // required — self-signs the rotation
});
```

#### `resolveAssetFromSat(sat)`

Reconstruct an asset (CEL log + current media) from a bare satoshi, from Bitcoin alone —
no envelope or host required (content-as-ordinal).

#### `asset.serialize()` / `loadAsset(envelope, opts?)`

Interchange format (#377). `asset.serialize()` emits a self-describing `AssetEnvelope`
(CEL log + captured DID docs + content-addressed resource blobs + an `unverified`
honesty section). `sdk.lifecycle.loadAsset(envelope)` is the inverse and **verifies by
default** (the `verifyEventLog` gate + resource↔genesis binding + DID-doc↔fold
cross-checks, all fail-closed; with an `ordinalsProvider` it also checks head freshness,
rejecting a truncated pre-rotation hand-off as `STALE_LOG`).

```typescript
const envelope = asset.serialize();
const { asset: restored, verification, warnings } = await sdk.lifecycle.loadAsset(
  envelope,
  { ordinalsProvider }
);
```

### Events

The LifecycleManager emits events during operations (names are colon-namespaced):

```typescript
sdk.lifecycle.on('asset:created', (event) => {
  console.log('Asset created:', event.asset.id);
});

sdk.lifecycle.on('asset:migrated', (event) => {
  console.log(`Migrated from ${event.fromLayer} to ${event.toLayer}`);
});

sdk.lifecycle.on('resource:published', (event) => {
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

Transfer an inscription to a new owner. Ownership IS sat control — this is a pure sat
move on Bitcoin; it does not edit any DID document. For the asset-level flow use
`sdk.lifecycle.transferOwnership(asset, newOwner)`.

```typescript
const result = await sdk.bitcoin.transferInscription(
  'abc123...i0',
  'bc1q...'
);
```

---

## Types

### OriginalsConfig

```typescript
interface OriginalsConfig {
  network: 'mainnet' | 'regtest' | 'signet';
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
| `did:cel` (genesis) | $0 | N/A |
| `did:webvh` | ~$25/year | Domain renewal |
| `did:btco` | $75-200 | One-time inscription |

---

## See Also

- [README.md](../README.md) - Quick start guide
- [CLAUDE.md](../CLAUDE.md) - Development guide
- [LLM_AGENT_GUIDE.md](./LLM_AGENT_GUIDE.md) - Comprehensive LLM reference
- [ORIGINALS_SPECIFICATION_v1.0.md](../ORIGINALS_SPECIFICATION_v1.0.md) - Protocol specification
