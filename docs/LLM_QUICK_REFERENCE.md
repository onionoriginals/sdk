# Originals SDK Quick Reference

## Initialization

```typescript
import { OriginalsSDK } from '@originals/sdk';
import { OrdMockProvider } from '@originals/sdk/testing';

const sdk = OriginalsSDK.create({
  network: 'regtest',           // 'mainnet' | 'regtest' | 'signet'
  defaultKeyType: 'Ed25519',    // 'ES256K' | 'Ed25519' | 'ES256'
  webvhNetwork: 'magby',        // 'magby' | 'cleffa' | 'pichu'
  ordinalsProvider: new OrdMockProvider(),  // Required for Bitcoin ops
});
```

## Asset Lifecycle (Clean API)

```typescript
// Layer 1: Create draft — asset.id is did:cel:…, currentLayer 'did:cel'
const draft = await sdk.lifecycle.createDraft(resources, {
  onProgress: (p) => console.log(`${p.percentage}%: ${p.message}`)
});

// Layer 2: Publish (did:webvh)
const published = await sdk.lifecycle.publish(draft, publisherDid);

// Layer 3: Inscribe (did:btco)
const inscribed = await sdk.lifecycle.inscribe(published, { feeRate: 10 });

// Transfer ownership
const tx = await sdk.lifecycle.transfer(inscribed, 'bc1q...');

// Cost estimation
const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco');

// Migration validation
const validation = await sdk.lifecycle.validateMigration(draft, 'did:webvh');
```

## Interchange, Ownership & Author-enablement

```typescript
// Creator: serialize provenance into a self-describing envelope.
const envelope = asset.serialize();                 // AssetEnvelope
const wire = JSON.stringify(envelope);

// Buyer: reconstruct + VERIFY BY DEFAULT — no keys needed (verification is
// public-key-only). With an ordinalsProvider, sets checkHeadFreshness and
// rejects a truncated pre-rotation hand-off as STALE_LOG.
const { asset, verification, warnings } = await sdk.lifecycle.loadAsset(wire);
//   throws ASSET_LOAD_VERIFICATION_FAILED / ENVELOPE_INVALID / ENVELOPE_VERSION_UNSUPPORTED

// OWNERSHIP = sat control. transferOwnership is a pure sat move — it writes
// NOTHING to the CEL. Receiving an asset = receiving the sat (no inscription).
await sdk.lifecycle.transferOwnership(asset, 'bcrt1q...');
const owner = await sdk.lifecycle.getCurrentOwner(asset); // { address, outpoint } | null (read live)

// AUTHORING is sat-gated after the anchor: the holder appends with their OWN
// key — the entry commits data.author and is reinscribed on the anchoring sat.
await asset.appendStatement({ statement: 'in my collection' }, { signer: holderSigner });
// Holder entries carry ONLY statement/occurredAt/links/ext — authenticity
// fields (name/resources/…) are creator-lineage only and refuse locally
// (CEL_HOLDER_FIELD_NOT_PERMITTED). There is NO rotation on did:btco:
// rotateBtcoKeys always throws KEY_ROTATION_NOT_PERMITTED (the lineage is
// frozen at inscription; authorizeSigner is removed).
```

## Typed Originals (Kinds System)

```typescript
import { OriginalKind, KindRegistry } from '@originals/sdk';

// Create typed Module Original
const moduleAsset = await sdk.lifecycle.createTypedOriginal(
  OriginalKind.Module,
  {
    kind: OriginalKind.Module,
    name: 'my-utility',
    version: '1.0.0',
    resources: [{ id: 'index.js', type: 'code', hash: '...', contentType: 'application/javascript' }],
    metadata: { format: 'esm', main: 'index.js' }
  }
);

// Available kinds: App, Agent, Module, Dataset, Media, Document
const kinds = [
  OriginalKind.App,      // Executable application
  OriginalKind.Agent,    // AI agent
  OriginalKind.Module,   // Reusable code module
  OriginalKind.Dataset,  // Structured data
  OriginalKind.Media,    // Image, audio, video
  OriginalKind.Document, // Text document
];

// Validate manifest
const registry = KindRegistry.getInstance();
const result = registry.validate(manifest);

// Parse kind string
const kind = KindRegistry.parseKind('module');  // OriginalKind.Module
```

## Resource Management

```typescript
import { ResourceManager } from '@originals/sdk';

const manager = new ResourceManager();

// Create resource
const resource = manager.createResource('content', {
  type: 'text',
  contentType: 'text/plain'
});

// Update (creates new version)
const v2 = manager.updateResource(resource, 'updated content', {
  changes: 'Fixed typo'
});

// Version history
const history = manager.getResourceHistory(resource.id);
const specific = manager.getResourceVersion(resource.id, 1);

// Validation
const valid = manager.validateResource(resource);
const chainValid = manager.verifyVersionChain(resource.id);
```

## DID Operations

```typescript
// Genesis is did:cel — mint via the lifecycle API (no createDIDPeer):
const asset = await sdk.lifecycle.createAsset(resources);  // asset.id === 'did:cel:…'
// Public discovery:
const result = await sdk.did.createDIDWebVH({ domain: 'example.com' });

// Migrate (returns { did, didDocument, log, keyPair, logPath?, previousDid } —
// host `log` as did.jsonl and persist `keyPair` for future updates)
const { didDocument: webvhDoc } = await sdk.did.migrateToDIDWebVH(didDoc, 'example.com');
await sdk.did.migrateToDIDBTCO(didDoc, '1234567890');  // satoshi

// Resolve
const doc = await sdk.did.resolveDID('did:webvh:...');
```

## Credentials

```typescript
// Basic operations
const cred = await sdk.credentials.createResourceCredential('ResourceCreated', subject, issuer);
const signed = await sdk.credentials.signCredential(cred, privateKey, vmId);
const valid = await sdk.credentials.verifyCredential(signed);

// Factory methods
const resourceCred = await sdk.credentials.issueResourceCredential(resource, assetDid, creatorDid);
const updateCred = await sdk.credentials.issueResourceUpdateCredential(...);
const migrationCred = await sdk.credentials.issueMigrationCredential(...);
const ownershipCred = await sdk.credentials.issueOwnershipCredential(...);

// Credential chaining
const chainedCred = await sdk.credentials.issueResourceCredential(resource, assetDid, creatorDid, {
  previousCredentialId: prevCred.id,
  previousCredentialHash: await sdk.credentials.computeCredentialHash(prevCred)
});
```

## Bitcoin Operations

```typescript
// Inscribe
const inscription = await sdk.bitcoin.inscribeData(data, 'application/json', 10);

// Transfer
await sdk.bitcoin.transferInscription(inscription, 'bc1q...');

// Validate
await sdk.bitcoin.validateBTCODID('did:btco:1234567890');
```

## Events

```typescript
sdk.lifecycle.on('asset:created', (e) => console.log(e.asset.id));
sdk.lifecycle.on('asset:migrated', (e) => console.log(e.asset.toLayer));
asset.on('asset:transferred', (e) => console.log(e.to));
```

## Batch Operations

```typescript
await sdk.lifecycle.batchCreateAssets(resourceArrays);
await sdk.lifecycle.batchPublishToWeb(assets, 'example.com');
await sdk.lifecycle.batchInscribeOnBitcoin(assets, { singleTransaction: true });  // 30%+ savings
await sdk.lifecycle.batchTransferOwnership(transfers);
```

## Key Utilities

```typescript
import { multikey, validateBitcoinAddress, validateSatoshiNumber } from '@originals/sdk';

// Encode/decode keys
const pubMultibase = multikey.encodePublicKey(keyBytes, 'Ed25519');
const { key, type } = multikey.decodePublicKey(pubMultibase);

// Validation
validateBitcoinAddress('bc1q...', 'mainnet');  // throws if invalid
const { valid, error } = validateSatoshiNumber('123');
```

## Network Mapping

| WebVH | Domain | Bitcoin |
|-------|--------|---------|
| magby | magby.originals.build | regtest |
| cleffa | cleffa.originals.build | signet |
| pichu | pichu.originals.build | mainnet |

## External Signer Interface

```typescript
interface ExternalSigner {
  sign(input: { document: object; proof: object }): Promise<{ proofValue: string }>;
  getVerificationMethodId(): string;
}

await sdk.did.createDIDWebVH({
  externalSigner: mySigner,
  verificationMethods: [{ type: 'Multikey', publicKeyMultibase: 'z6Mk...' }],
  updateKeys: ['did:key:z6Mk...']
});
```

## Common Errors

| Code | Meaning |
|------|---------|
| `ORD_PROVIDER_REQUIRED` | Need `ordinalsProvider` in config |
| `INVALID_INPUT` | Bad parameter value |
| `INVALID_ADDRESS` | Invalid Bitcoin address |
| `INVALID_SATOSHI` | Bad satoshi identifier |

## Critical Rules

1. **Bitcoin ops need `ordinalsProvider`** - Always configure for inscribe/transfer; also pass it to `asset.verify({ ordinalsProvider })` to verify inscribed (did:btco) assets
2. **Keys are Multikey, not JWK** - Use `multikey.encode*()` functions
3. **Migration is one-way** - did:cel → webvh → btco only (no fallback once on btco)
4. **Max fee rate: 10,000 sat/vB** - Prevents accidental fund loss
5. **Use `OrdMockProvider` for tests** - Never real Bitcoin in tests
6. **Use typed Originals** - Prefer `createTypedOriginal` for validation
7. **Validate before migrate** - Use `validateMigration()` pre-flight
8. **Estimate costs first** - Use `estimateCost()` before Bitcoin ops

## Kind Metadata Requirements

| Kind | Required Metadata |
|------|-------------------|
| App | `runtime`, `entrypoint` |
| Agent | `capabilities` |
| Module | `format`, `main` |
| Dataset | `schema`, `format` |
| Media | `mediaType`, `mimeType` |
| Document | `format`, `content` |
