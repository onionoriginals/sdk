## Originals SDK — Inputs and Outputs

This reference documents the public surface of the Originals SDK with precise inputs, outputs, defaults, and error behavior.

- Version: matches this repository branch
- Language: TypeScript (runtime shape applies to JS)

### Notation
- Types are referenced from `src/types/*` (e.g., `OriginalsConfig`, `AssetResource`).
- Errors: unless noted as `StructuredError`, functions throw standard `Error` with message.

---

## Configuration

### OriginalsConfig
```ts
interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  enableLogging?: boolean;
  storageAdapter?: StorageAdapter;      // optional; used by publishToWeb
  feeOracle?: FeeOracleAdapter;         // optional; used by Bitcoin fee estimation
  ordinalsProvider?: OrdinalsProvider;  // required for Bitcoin operations
  telemetry?: TelemetryHooks;           // optional
}
```

Defaults when created via `OriginalsSDK.create`:
- `network`: `mainnet`
- `defaultKeyType`: `ES256K`
- `enableLogging`: `false`

### OriginalsSDKOptions
```ts
interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore; // used by lifecycle for key registration and signing
}
```

### Common Data Types
- `AssetResource`: `{ id: string; type: string; url?: string; content?: string; contentType: string; hash: string; size?: number }`
- `LayerType`: `'did:peer' | 'did:webvh' | 'did:btco'`
- `OrdinalsInscription`, `BitcoinTransaction`: see `src/types/bitcoin.ts`
- `DIDDocument`, `VerificationMethod`: see `src/types/did.ts`
- `VerifiableCredential`, `VerifiablePresentation`, `Proof`: see `src/types/credentials.ts`

Validation highlights used across the SDK:
- `contentType` must be a valid MIME type (regex enforced).
- `hash` must be a hex string.
- Domains must pass strict label rules for `publishToWeb` and DID WebVH migration.
- Bitcoin addresses are pattern-checked (bech32/legacy prefixes) with relaxed rules for test/mock.

---

## OriginalsSDK

### `OriginalsSDK.create(options?: OriginalsSDKOptions): OriginalsSDK`
- **Input**: Partial config plus optional `keyStore`.
- **Output**: `OriginalsSDK` instance with `did`, `credentials`, `lifecycle`, `bitcoin` managers.
- **Throws**: `Error` if provided `network` or `defaultKeyType` is invalid.
- **Behavior**: merges provided options over defaults.

### `constructor(config: OriginalsConfig, keyStore?: KeyStore)`
- Prefer using `create`. Direct use follows same validation and side-effects.

### `validateBitcoinConfig(): void`
- **Input**: none
- **Output**: none
- **Throws**: `StructuredError('ORD_PROVIDER_REQUIRED', ...)` if `ordinalsProvider` missing.

---

## LifecycleManager
Accessible via `sdk.lifecycle`.

### `registerKey(verificationMethodId: string, privateKey: string): Promise<void>`
- **Input**: Absolute verification method id, multibase-encoded private key.
- **Output**: `void`
- **Throws**: `Error` if no `keyStore` provided, invalid id/key, or key not multibase.

### `createAsset(resources: AssetResource[]): Promise<OriginalsAsset>`
- **Input**: Non-empty array of `AssetResource` with valid `contentType` and hex `hash`.
- **Output**: `OriginalsAsset` in layer `did:peer` with a freshly created `DIDDocument`.
- **Side effects**: If `keyStore` supplied to SDK, the DID’s first verification method private key is stored under its absolute VM id.
- **Throws**: `Error` on invalid array or resource fields.

### `publishToWeb(asset: OriginalsAsset, domain: string): Promise<OriginalsAsset>`
- **Input**: `OriginalsAsset` currently in `did:peer`, `domain` (strict validation).
- **Output**: Same `OriginalsAsset`, migrated to `did:webvh` with `bindings['did:webvh'] = did:webvh:<domain>:<slug>` and resource `url` fields populated.
- **Behavior**:
  - Stores resource blobs via configured `storageAdapter.put` or in-memory fallback.
  - Issues and appends a `ResourceMigrated` credential when possible (best-effort).
- **Throws**: `Error` for invalid inputs; migration preconditions enforced.

### `inscribeOnBitcoin(asset: OriginalsAsset, feeRate?: number): Promise<OriginalsAsset>`
- **Input**: `OriginalsAsset` in `did:peer` or `did:webvh`; optional positive `feeRate`.
- **Output**: Same `OriginalsAsset`, migrated to `did:btco`; provenance migration includes `transactionId`, `inscriptionId`, `satoshi`, and fee info; `bindings['did:btco']` set to `did:btco:<satoshi>` or `did:btco:<inscriptionId>`.
- **Throws**:
  - `Error` on invalid `feeRate` or migration preconditions.
  - `StructuredError('ORD_PROVIDER_REQUIRED' | 'ORD_PROVIDER_UNSUPPORTED' | 'ORD_PROVIDER_INVALID_RESPONSE' | 'INVALID_SATOSHI')` depending on provider state/response.

### `transferOwnership(asset: OriginalsAsset, newOwner: string): Promise<BitcoinTransaction>`
- **Input**: `OriginalsAsset` in `did:btco`; destination address string.
- **Output**: `BitcoinTransaction` returned by provider (normalized); asset provenance updated and latest `txid` recorded.
- **Throws**: `Error` for preconditions/format; `StructuredError` variants for provider/response issues.

---

## OriginalsAsset
Constructed by the lifecycle manager.

### Fields
- `id: string` — equals `did.id`
- `resources: AssetResource[]`
- `did: DIDDocument`
- `credentials: VerifiableCredential[]`
- `currentLayer: LayerType`
- `bindings?: Record<string, string>` — optional DID bindings per layer

### `migrate(toLayer: LayerType, details?): Promise<void>`
- **Valid transitions**: `did:peer → did:webvh | did:btco`, `did:webvh → did:btco`.
- **details**: `{ transactionId?, inscriptionId?, satoshi?, commitTxId?, revealTxId?, feeRate? }`
- **Effects**: Appends to provenance; sets `txid` if provided; updates `currentLayer`.
- **Throws**: `Error` if transition invalid.

### `getProvenance(): ProvenanceChain`
- **Output**: `{ createdAt, creator, txid?, migrations: [...], transfers: [...] }`

### `recordTransfer(from: string, to: string, transactionId: string): void`
- **Effects**: Appends transfer entry; updates `txid`.

### `verify(deps?): Promise<boolean>`
- **deps?**: `{ didManager?, credentialManager?, fetch? }`
- **Behavior**:
  - Validates DID structure.
  - Verifies resource integrity: inline `content` or fetched `url` (if `fetch` provided).
  - Validates credentials structurally and, when supplied, cryptographically via `credentialManager` and `didManager`.
- **Output**: `true` if all checks pass; else `false`.

---

## DIDManager
Accessible via `sdk.did`.

### `createDIDPeer(resources: AssetResource[], returnKeyPair?: false): Promise<DIDDocument>`
### `createDIDPeer(resources: AssetResource[], returnKeyPair: true): Promise<{ didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }>`
- **Input**: Resource list (not embedded); key type derived from `config.defaultKeyType`.
- **Output**: Long-form did:peer DID Document; optionally returns generated multibase key pair.

### `migrateToDIDWebVH(didDoc: DIDDocument, domain: string): Promise<DIDDocument>`
- **Output**: New DID Document with id `did:webvh:<domain>:<slug>`.
- **Throws**: `Error` on invalid domain.

### `migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument>`
- **Output**: `did:btco` DID Document; may carry over first VM if decodable.
- **Throws**: `Error` if `satoshi` invalid/out of range.

### `resolveDID(did: string): Promise<DIDDocument | null>`
- **Behavior**: Resolves `did:peer`, `did:webvh`, and `did:btco` using appropriate resolvers; falls back to minimal docs when resolution fails.

### `validateDIDDocument(didDoc: DIDDocument): boolean`

---

## CredentialManager
Accessible via `sdk.credentials`.

### `createResourceCredential(type, subject, issuer): Promise<VerifiableCredential>`
- `type`: `'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated'`
- `subject`: JSON object (see typed variants in `src/types/credentials.ts`)
- `issuer`: DID or issuer id

### `signCredential(credential, privateKeyMultibase, verificationMethod): Promise<VerifiableCredential>`
- Uses DID document loader when available; falls back to local signer with Data Integrity `proof`.

### `verifyCredential(credential): Promise<boolean>`
- Uses cryptosuite verification when proof includes `cryptosuite`; else verifies local DI proof against resolved VM.

### `createPresentation(credentials, holder): Promise<VerifiablePresentation>`

---

## BitcoinManager
Accessible via `sdk.bitcoin`.

### `inscribeData(data: any, contentType: string, feeRate?: number): Promise<OrdinalsInscription>`
- **Throws**: `StructuredError` on invalid args or missing/unsupported provider.

### `trackInscription(inscriptionId: string): Promise<OrdinalsInscription | null>`

### `transferInscription(inscription: OrdinalsInscription, toAddress: string): Promise<BitcoinTransaction>`
- **Throws**: `StructuredError` on invalid args or missing/unsupported provider.

### `preventFrontRunning(satoshi: string): Promise<boolean>`
- Returns `false` if multiple inscriptions detected for the same satoshi (via provider), else `true`.

### `getSatoshiFromInscription(inscriptionId: string): Promise<string | null>`

### `validateBTCODID(didId: string): Promise<boolean>`
- Validates format and checks Bitcoin for inscriptions on the referenced satoshi.

---

## Error Semantics

### StructuredError (subset)
- `ORD_PROVIDER_REQUIRED`: Ordinals provider not configured.
- `ORD_PROVIDER_UNSUPPORTED`: Provider missing required methods.
- `ORD_PROVIDER_INVALID_RESPONSE`: Provider returned incomplete/invalid data.
- `INVALID_SATOSHI`: Satoshi identifier invalid.
- `INVALID_INPUT`: Generic validation error (Bitcoin operations).

Standard `Error` is used elsewhere for argument validation and migration preconditions.

---

## Minimal Examples

```ts
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdMockProvider()
});

const resources = [{
  id: 'image-1',
  type: 'image',
  content: '...base64...',
  contentType: 'image/png',
  hash: 'abcdef0123'
}];

const asset = await sdk.lifecycle.createAsset(resources);
await sdk.lifecycle.publishToWeb(asset, 'example.com');
await sdk.lifecycle.inscribeOnBitcoin(asset, 50); // sat/vB
const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1q...');
```
