# Asset Layer Quick Reference

## Key Concepts at a Glance

| Concept | Description | Location |
|---------|-------------|----------|
| **OriginalsAsset** | Main asset class representing digital assets through lifecycle | `src/lifecycle/OriginalsAsset.ts` |
| **AssetResource** | Individual digital resources (images, text, data) with hashes | `src/types/common.ts` |
| **ProvenanceChain** | Complete audit trail of migrations and transfers | `src/lifecycle/OriginalsAsset.ts` |
| **LifecycleManager** | Orchestrates asset creation and layer transitions | `src/lifecycle/LifecycleManager.ts` |
| **LayerType** | Three layers: 'did:peer', 'did:webvh', 'did:btco' | `src/types/common.ts` |

## Three Layers Comparison

| Feature | did:peer | did:webvh | did:btco |
|---------|----------|-----------|----------|
| **Cost** | Free | ~$25/year | $75-200 one-time |
| **Location** | Offline | HTTPS | Bitcoin blockchain |
| **Discoverability** | Private | Public (web-based) | Public (blockchain) |
| **Mutability** | Mutable | Verifiable | Immutable |
| **Transferability** | No | No | Yes |
| **Cryptographic Security** | DID + VC | DID + VC + HTTPS | DID + VC + Bitcoin |
| **Primary Use Case** | Development/testing | Public portfolio | Ownership transfer |
| **Migration Targets** | webvh, btco | btco | None (terminal) |

## Common Operations

### Create Asset
```typescript
const resources: AssetResource[] = [{
  id: 'my-resource',
  type: 'image',
  contentType: 'image/png',
  hash: 'abc123...def', // 64 hex chars
  content: '<optional-inline-content>'
}];

const asset = await sdk.lifecycle.createAsset(resources);
// Returns: OriginalsAsset in 'did:peer' layer
```

**Requirements:**
- ✅ At least one resource
- ✅ Valid hash (64 hex characters)
- ✅ Valid MIME type
- ✅ Non-empty strings for id, type

### Publish to Web
```typescript
const webAsset = await sdk.lifecycle.publishToWeb(asset, 'example.com');
// Returns: OriginalsAsset in 'did:webvh' layer
```

**What happens:**
1. Resources uploaded to storage adapter
2. URLs added to resources
3. did:webvh binding created
4. ResourceMigrated credential issued
5. Provenance updated

**Requirements:**
- ✅ Asset in 'did:peer' layer
- ✅ Valid domain format
- ✅ Storage adapter configured
- ✅ KeyStore configured (for credential signing)

### Inscribe on Bitcoin
```typescript
const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, 10); // 10 sat/vB
// Returns: OriginalsAsset in 'did:btco' layer
```

**What happens:**
1. Manifest created (JSON with asset metadata)
2. Fee rate determined (oracle or provided)
3. Inscription created (commit + reveal txs)
4. Unique satoshi assigned
5. did:btco binding created
6. Provenance updated

**Requirements:**
- ✅ Asset in 'did:peer' or 'did:webvh' layer
- ✅ OrdinalsProvider configured
- ✅ Fee rate 1-1,000,000 sat/vB (if provided)
- ✅ Sufficient Bitcoin funds

### Transfer Ownership
```typescript
const tx = await sdk.lifecycle.transferOwnership(
  asset,
  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
);
// Returns: BitcoinTransaction
```

**Requirements:**
- ✅ Asset in 'did:btco' layer only
- ✅ Valid Bitcoin address for network
- ✅ Network-aware validation

## Asset Verification

### Basic Verification
```typescript
const isValid = await asset.verify();
// Returns: boolean
```

**Validates:**
- DID document structure
- Resource structure and hash format
- Credential structure

### Advanced Verification
```typescript
const isValid = await asset.verify({
  credentialManager: sdk.credentials,
  didManager: sdk.did,
  fetch: fetch // for URL resource verification
});
```

**Additionally validates:**
- Content hash integrity (inline or fetched)
- Cryptographic credential signatures
- DID resolution and key verification

## Common Patterns

### 1. Standard Lifecycle (all three layers)
```typescript
// Create
const asset = await sdk.lifecycle.createAsset(resources);

// Publish
const webAsset = await sdk.lifecycle.publishToWeb(asset, 'example.com');

// Inscribe
const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 10);

// Transfer
const tx = await sdk.lifecycle.transferOwnership(btcoAsset, buyerAddress);
```

### 2. Direct to Bitcoin (skip webvh)
```typescript
// Create
const asset = await sdk.lifecycle.createAsset(resources);

// Inscribe directly
const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, 10);

// Transfer
const tx = await sdk.lifecycle.transferOwnership(btcoAsset, buyerAddress);
```

### 3. Web-only (no Bitcoin)
```typescript
// Create
const asset = await sdk.lifecycle.createAsset(resources);

// Publish
const webAsset = await sdk.lifecycle.publishToWeb(asset, 'example.com');

// Verification
const isValid = await webAsset.verify();
```

### 4. Multiple Transfers
```typescript
const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, 10);

// First transfer
await sdk.lifecycle.transferOwnership(btcoAsset, buyer1);

// Second transfer (to new owner)
await sdk.lifecycle.transferOwnership(btcoAsset, buyer2);

// Provenance shows complete chain
const provenance = btcoAsset.getProvenance();
console.log(provenance.transfers); // Array of 2 transfers
```

## Error Scenarios and Solutions

### Error: "Invalid migration from X to Y"
**Cause:** Attempting invalid layer transition
**Solution:** Check migration path rules:
- peer → webvh ✅
- peer → btco ✅
- webvh → btco ✅
- All others ❌

### Error: "Asset must be inscribed on Bitcoin before transfer"
**Cause:** Attempting to transfer non-btco asset
**Solution:** Inscribe asset first:
```typescript
const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset);
await sdk.lifecycle.transferOwnership(btcoAsset, address);
```

### Error: "At least one resource is required"
**Cause:** Empty resources array
**Solution:** Provide at least one resource:
```typescript
const resources = [{ id: 'res1', type: 'data', contentType: 'text/plain', hash: '...' }];
```

### Error: "Invalid resource: invalid hash (must be hex string)"
**Cause:** Hash contains non-hex characters or wrong length
**Solution:** Use valid SHA-256 hash (64 hex chars):
```typescript
import { createHash } from 'crypto';
const hash = createHash('sha256').update(content).digest('hex');
```

### Error: "Invalid domain format"
**Cause:** Domain doesn't match RFC format
**Solution:** Use valid domain:
```typescript
// Valid: example.com, art.example.com, my-site.org
// Invalid: http://example.com, example, .com
```

### Error: "Private key not available for signing"
**Cause:** KeyStore not configured or key not registered
**Solution:** Provide KeyStore and register key:
```typescript
const keyStore = new MockKeyStore();
const sdk = new OriginalsSDK(config, keyStore);

// Key is auto-registered during createAsset if KeyStore provided
const asset = await sdk.lifecycle.createAsset(resources);
```

### Error: "ORD_PROVIDER_REQUIRED"
**Cause:** Bitcoin operations without OrdinalsProvider
**Solution:** Configure provider:
```typescript
import { OrdMockProvider } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdMockProvider()
});
```

### Error: "Invalid Bitcoin address for ownership transfer"
**Cause:** Address invalid or wrong network
**Solution:** Use network-appropriate address:
```typescript
// Mainnet: bc1...
// Testnet: tb1...
// Regtest: bcrt1...
```

## Provenance Inspection

### Get Complete History
```typescript
const provenance = asset.getProvenance();

console.log('Created:', provenance.createdAt);
console.log('Creator:', provenance.creator);
console.log('Migrations:', provenance.migrations.length);
console.log('Transfers:', provenance.transfers.length);
```

### Check Current Layer
```typescript
console.log('Current layer:', asset.currentLayer);
// Output: 'did:peer' | 'did:webvh' | 'did:btco'
```

### Get Layer Bindings
```typescript
const bindings = (asset as any).bindings;
if (bindings) {
  console.log('WebVH DID:', bindings['did:webvh']);
  console.log('Bitcoin DID:', bindings['did:btco']);
}
```

### Migration History
```typescript
provenance.migrations.forEach((migration, index) => {
  console.log(`Migration ${index + 1}:`);
  console.log(`  ${migration.from} → ${migration.to}`);
  console.log(`  Timestamp: ${migration.timestamp}`);
  if (migration.transactionId) {
    console.log(`  Transaction: ${migration.transactionId}`);
  }
  if (migration.inscriptionId) {
    console.log(`  Inscription: ${migration.inscriptionId}`);
  }
});
```

### Transfer History
```typescript
provenance.transfers.forEach((transfer, index) => {
  console.log(`Transfer ${index + 1}:`);
  console.log(`  From: ${transfer.from}`);
  console.log(`  To: ${transfer.to}`);
  console.log(`  Transaction: ${transfer.transactionId}`);
  console.log(`  Time: ${transfer.timestamp}`);
});
```

## Resource Hash Generation

### For String Content
```typescript
import { createHash } from 'crypto';

const content = 'Hello, Originals!';
const hash = createHash('sha256')
  .update(content, 'utf8')
  .digest('hex');

const resource: AssetResource = {
  id: 'greeting',
  type: 'text',
  contentType: 'text/plain',
  hash,
  content
};
```

### For Binary Content
```typescript
const imageBuffer = fs.readFileSync('image.png');
const hash = createHash('sha256')
  .update(imageBuffer)
  .digest('hex');

const resource: AssetResource = {
  id: 'artwork',
  type: 'image',
  contentType: 'image/png',
  hash,
  size: imageBuffer.length
  // content omitted for large files
};
```

### For Base64 Content
```typescript
const base64Content = '...'; // Base64-encoded data
const buffer = Buffer.from(base64Content, 'base64');
const hash = createHash('sha256')
  .update(buffer)
  .digest('hex');
```

## Testing Patterns

### Mock Setup
```typescript
import { OriginalsSDK, OrdMockProvider, FeeOracleMock } from '@originals/sdk';
import { MemoryStorageAdapter } from '@originals/sdk/storage';

const config = {
  network: 'regtest',
  defaultKeyType: 'ES256K',
  enableLogging: false,
  storageAdapter: new StorageAdapterBridge(new MemoryStorageAdapter()),
  feeOracle: new FeeOracleMock(7),
  ordinalsProvider: new OrdMockProvider()
};

const keyStore = new MockKeyStore();
const sdk = new OriginalsSDK(config, keyStore);
```

### Verification Testing
```typescript
// Create asset with known content
const content = 'test content';
const hash = createHash('sha256').update(content).digest('hex');

const asset = await sdk.lifecycle.createAsset([{
  id: 'test',
  type: 'text',
  contentType: 'text/plain',
  hash,
  content
}]);

// Should verify successfully
expect(await asset.verify()).toBe(true);

// Tamper with content
(asset.resources[0] as any).content = 'tampered';

// Should fail verification
expect(await asset.verify()).toBe(false);
```

### Migration Testing
```typescript
const asset = await sdk.lifecycle.createAsset(resources);
expect(asset.currentLayer).toBe('did:peer');

const webAsset = await sdk.lifecycle.publishToWeb(asset, 'test.com');
expect(webAsset.currentLayer).toBe('did:webvh');

const provenance = webAsset.getProvenance();
expect(provenance.migrations).toHaveLength(1);
expect(provenance.migrations[0].from).toBe('did:peer');
expect(provenance.migrations[0].to).toBe('did:webvh');
```

## Performance Considerations

### Resource Count
- ✅ Tested with up to 50 resources
- ✅ Each resource uploaded separately during publishToWeb
- ⚠️ Large resource counts increase publication time
- 💡 Consider batching or parallel uploads for many resources

### Resource Size
- ✅ Tested with up to 100KB resources
- ✅ Inline content works well for small resources
- ⚠️ Large inline content increases memory usage
- 💡 Use URL references for large files (>1MB)

### Provenance Chain
- ✅ Append-only, minimal overhead
- ✅ Timestamps use ISO-8601 strings
- ✅ All provenance operations are synchronous
- 💡 No performance concerns for typical usage

### Verification
- ✅ Fast for structural validation only
- ⚠️ URL fetching can be slow (network dependent)
- ⚠️ Cryptographic verification requires key resolution
- 💡 Provide optional deps only when needed

## Security Best Practices

### Private Key Management
```typescript
// ✅ DO: Use secure KeyStore implementation
class SecureKeyStore implements KeyStore {
  async getPrivateKey(id: string) {
    // Retrieve from secure storage (e.g., HSM, KMS)
  }
  async setPrivateKey(id: string, key: string) {
    // Store in secure storage with encryption
  }
}

// ❌ DON'T: Store keys in plain text
const insecureKeyStore = {
  keys: {},
  async getPrivateKey(id) { return this.keys[id]; }
};
```

### Content Validation
```typescript
// ✅ DO: Verify hashes before creating assets
const computedHash = createHash('sha256').update(content).digest('hex');
if (computedHash !== providedHash) {
  throw new Error('Hash mismatch');
}

// ✅ DO: Validate content types
if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/.test(contentType)) {
  throw new Error('Invalid MIME type');
}
```

### Network Awareness
```typescript
// ✅ DO: Use network-appropriate addresses
const address = config.network === 'mainnet' 
  ? 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
  : 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

// ✅ DO: Validate addresses before transfer
import { validateBitcoinAddress } from '@originals/sdk';
validateBitcoinAddress(address, config.network);
```

## Advanced Topics

### Custom Storage Adapter
```typescript
import { StorageAdapter } from '@originals/sdk';

class S3StorageAdapter implements StorageAdapter {
  async put(objectKey: string, data: Buffer | string, options?: { contentType?: string }): Promise<string> {
    // Upload to S3
    // Return public URL
  }
  
  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    // Fetch from S3
  }
  
  async delete(objectKey: string): Promise<boolean> {
    // Delete from S3
  }
}
```

### External Signer Integration
```typescript
import { ExternalSigner } from '@originals/sdk';

// Example: Privy integration
class PrivySigner implements ExternalSigner {
  async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
    // Use Privy to sign
  }
  
  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }
}

// Use with DID:WebVH
const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  externalSigner: privySigner,
  verificationMethods: [{ type: 'Multikey', publicKeyMultibase: '...' }],
  updateKeys: ['did:key:...']
});
```

### Custom Fee Oracle
```typescript
import { FeeOracleAdapter } from '@originals/sdk';

class MempoolSpaceFeeOracle implements FeeOracleAdapter {
  async estimateFeeRate(targetBlocks: number): Promise<number> {
    const response = await fetch('https://mempool.space/api/v1/fees/recommended');
    const fees = await response.json();
    
    if (targetBlocks <= 1) return fees.fastestFee;
    if (targetBlocks <= 3) return fees.halfHourFee;
    return fees.hourFee;
  }
}
```

## Debugging Tips

### Enable Logging
```typescript
const sdk = OriginalsSDK.create({
  network: 'regtest',
  enableLogging: true // Enable debug output
});
```

### Inspect Provenance
```typescript
console.log(JSON.stringify(asset.getProvenance(), null, 2));
```

### Check Verification Details
```typescript
// Structural only
const structural = await asset.verify();

// With content verification
const withContent = await asset.verify({ fetch });

// With cryptographic verification
const fullVerification = await asset.verify({
  credentialManager: sdk.credentials,
  didManager: sdk.did,
  fetch
});

console.log({ structural, withContent, fullVerification });
```

### Trace Asset State
```typescript
console.log({
  id: asset.id,
  layer: asset.currentLayer,
  resourceCount: asset.resources.length,
  credentialCount: asset.credentials.length,
  migrationCount: asset.getProvenance().migrations.length,
  transferCount: asset.getProvenance().transfers.length,
  bindings: (asset as any).bindings
});
```

## Useful Utilities

### Generate Valid Hash
```typescript
function generateValidHash(content: string | Buffer): string {
  const hash = createHash('sha256');
  if (typeof content === 'string') {
    hash.update(content, 'utf8');
  } else {
    hash.update(content);
  }
  return hash.digest('hex');
}
```

### Create Resource from File
```typescript
async function createResourceFromFile(filePath: string, id: string, type: string): Promise<AssetResource> {
  const content = await fs.promises.readFile(filePath);
  const hash = generateValidHash(content);
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  
  return {
    id,
    type,
    contentType: mimeType,
    hash,
    size: content.length
  };
}
```

### Validate Asset Resource
```typescript
function validateAssetResource(resource: AssetResource): void {
  if (!resource.id || typeof resource.id !== 'string') {
    throw new Error('Invalid resource: missing or invalid id');
  }
  if (!resource.type || typeof resource.type !== 'string') {
    throw new Error('Invalid resource: missing or invalid type');
  }
  if (!resource.contentType || typeof resource.contentType !== 'string') {
    throw new Error('Invalid resource: missing or invalid contentType');
  }
  if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(resource.hash)) {
    throw new Error('Invalid resource: hash must be 64 hex characters');
  }
}
```
