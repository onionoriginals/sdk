# Resource Versioning System

## Overview

The Originals SDK implements an **immutable resource versioning system** with verifiable provenance. Resources are content-addressed by their hash, and versioning is achieved by creating new immutable resource instances that link back to their predecessors via `previousVersionHash`. Old versions remain fully accessible.

## Core Principles

### 1. Immutability
- **Resources are never modified in place**. Creating a new version means creating a new `AssetResource` object with a unique hash.
- Every version is preserved indefinitely and can be retrieved independently.
- This ensures complete historical transparency and auditability.

### 2. Content Addressing
- Each resource version is uniquely identified by its **content hash** (SHA-256).
- Identical content always produces the same hash.
- Different content always produces different hashes.
- Attempting to create a "new version" with identical content is rejected.

### 3. Verifiable Provenance Chain
- Each version (except the first) includes a `previousVersionHash` field linking to its immediate predecessor.
- The version chain can be cryptographically verified to ensure integrity.
- Version numbers are sequential starting at 1.
- The complete history of changes is recorded in the asset's provenance.

### 4. Layer-Agnostic Operation
- Versioning works identically across all layers: **did:peer**, **did:webvh**, and **did:btco**.
- Resource versions are independent of the DID layer.
- Migration between layers preserves all version history.

## API Reference

### Creating a New Resource Version

```typescript
const newResource = asset.addResourceVersion(
  resourceId: string,      // Logical resource ID (stable across versions)
  newContent: string | Buffer,  // New content
  contentType: string,     // MIME type
  changes?: string         // Optional description of changes
): AssetResource;
```

**Behavior:**
- Finds the current version of the specified resource
- Computes the hash of `newContent` using SHA-256
- Validates that the new hash differs from the current version's hash
- Creates a new `AssetResource` with:
  - Incremented `version` number
  - `previousVersionHash` set to the current version's hash
  - `createdAt` timestamp
  - New `hash` based on content
- Appends the new resource to the asset's `resources` array (preserving old versions)
- Updates the provenance chain with the version transition
- Emits a `resource:version:created` event
- Returns the newly created `AssetResource`

**Throws:**
- `Error` if the resource ID is not found
- `Error` if the new content hash matches the current version (content unchanged)

### Querying Resource Versions

#### Get a Specific Version

```typescript
const resource = asset.getResourceVersion(
  resourceId: string,
  version: number
): AssetResource | null;
```

Returns the `AssetResource` for the specified version number (1-indexed), or `null` if not found.

#### Get All Versions

```typescript
const versions = asset.getAllVersions(
  resourceId: string
): AssetResource[];
```

Returns an array of all `AssetResource` versions for the given resource ID, sorted by version number in ascending order.

#### Get Version History

```typescript
const history = asset.getResourceHistory(
  resourceId: string
): ResourceHistory | null;
```

Returns a `ResourceHistory` object containing:
- `resourceId`: The logical resource ID
- `versions`: Array of all `ResourceVersion` metadata
- `currentVersion`: The latest `ResourceVersion`

Returns `null` if the resource doesn't exist.

### ResourceVersion Interface

```typescript
interface ResourceVersion {
  version: number;
  hash: string;               // Unique content hash
  timestamp: string;          // ISO 8601 timestamp
  contentType: string;
  changes?: string;           // Optional change description
  previousVersionHash?: string;
}
```

### ResourceHistory Interface

```typescript
interface ResourceHistory {
  resourceId: string;         // Logical ID (same across versions)
  versions: ResourceVersion[];
  currentVersion: ResourceVersion;
}
```

## Events

### `resource:version:created`

Emitted when a new resource version is created.

```typescript
interface ResourceVersionCreatedEvent {
  type: 'resource:version:created';
  timestamp: string;
  asset: {
    id: string;
  };
  resource: {
    id: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
  };
  changes?: string;
}
```

**Usage:**

```typescript
asset.on('resource:version:created', (event) => {
  console.log(`Resource ${event.resource.id} updated: v${event.resource.fromVersion} → v${event.resource.toVersion}`);
  console.log(`Hash changed: ${event.resource.fromHash} → ${event.resource.toHash}`);
  if (event.changes) {
    console.log(`Changes: ${event.changes}`);
  }
});
```

## Provenance Integration

Every resource version creation is recorded in the asset's provenance chain:

```typescript
interface ProvenanceChain {
  // ... existing fields ...
  resourceUpdates: Array<{
    resourceId: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
    timestamp: string;
    changes?: string;
  }>;
}
```

Access the provenance:

```typescript
const provenance = asset.getProvenance();
console.log('Resource updates:', provenance.resourceUpdates);
```

## Verifiable Credentials

Resource version changes can be documented with verifiable credentials:

```typescript
const credential = await credentialManager.createResourceCredential(
  'ResourceUpdated',
  {
    id: resourceId,
    fromVersion: 1,
    toVersion: 2,
    fromHash: 'abc123...',
    toHash: 'def456...',
    timestamp: new Date().toISOString()
  },
  asset.id
);

const signedCredential = await credentialManager.signCredential(
  credential,
  privateKey,
  verificationMethod
);
```

## Example Usage

### Basic Versioning

```typescript
import { OriginalsAsset } from './src/lifecycle/OriginalsAsset';
import { hashResource } from './src/utils/validation';

// Create an asset with an initial resource
const initialContent = 'Hello, World!';
const resources = [{
  id: 'greeting',
  type: 'text',
  content: initialContent,
  contentType: 'text/plain',
  hash: hashResource(Buffer.from(initialContent, 'utf-8')),
  version: 1,
  createdAt: new Date().toISOString()
}];

const asset = new OriginalsAsset(resources, didDocument, []);

// Create version 2
const v2 = asset.addResourceVersion(
  'greeting',
  'Hello, Originals!',
  'text/plain',
  'Updated greeting message'
);

console.log(v2.version); // 2
console.log(v2.previousVersionHash); // hash of v1

// Access version 1 (still available)
const v1 = asset.getResourceVersion('greeting', 1);
console.log(v1.content); // "Hello, World!"

// Access version 2
const v2again = asset.getResourceVersion('greeting', 2);
console.log(v2again.content); // "Hello, Originals!"
```

### Version History

```typescript
// Add multiple versions
asset.addResourceVersion('greeting', 'Greetings!', 'text/plain');
asset.addResourceVersion('greeting', 'Hi there!', 'text/plain');

// Get complete history
const history = asset.getResourceHistory('greeting');
console.log(`Total versions: ${history.versions.length}`);
console.log(`Current version: ${history.currentVersion.version}`);

// Get all versions as AssetResources
const allVersions = asset.getAllVersions('greeting');
allVersions.forEach((resource, index) => {
  console.log(`Version ${resource.version || 1}: ${resource.content}`);
});
```

### Listening to Version Events

```typescript
asset.on('resource:version:created', (event) => {
  console.log(`New version created!`);
  console.log(`  Resource: ${event.resource.id}`);
  console.log(`  Version: ${event.resource.fromVersion} → ${event.resource.toVersion}`);
  console.log(`  Hash: ${event.resource.fromHash.slice(0, 8)}... → ${event.resource.toHash.slice(0, 8)}...`);
  if (event.changes) {
    console.log(`  Changes: ${event.changes}`);
  }
});

asset.addResourceVersion('greeting', 'Updated content', 'text/plain', 'Fixed typo');
// Event will be emitted asynchronously
```

### Verifying Chain Integrity

```typescript
const history = asset.getResourceHistory('greeting');

// Manual verification
for (let i = 0; i < history.versions.length; i++) {
  const version = history.versions[i];
  
  if (i === 0) {
    // First version should have no previous hash
    console.assert(version.previousVersionHash === undefined);
  } else {
    // Subsequent versions should link to previous
    const prevVersion = history.versions[i - 1];
    console.assert(version.previousVersionHash === prevVersion.hash);
  }
  
  // Version numbers should be sequential
  console.assert(version.version === i + 1);
}
```

### Cross-Layer Versioning

```typescript
// Create asset at did:peer layer
const asset = new OriginalsAsset(resources, peerDid, []);
console.log(asset.currentLayer); // 'did:peer'

// Add version at did:peer
asset.addResourceVersion('res1', 'content v2', 'text/plain');

// Migrate to did:webvh
await asset.migrate('did:webvh');
console.log(asset.currentLayer); // 'did:webvh'

// Add version at did:webvh - all history is preserved
asset.addResourceVersion('res1', 'content v3', 'text/plain');

// All versions remain accessible
const allVersions = asset.getAllVersions('res1');
console.log(allVersions.length); // 3
```

## Implementation Details

### ResourceVersionManager

The `ResourceVersionManager` class manages version metadata internally:

```typescript
class ResourceVersionManager {
  addVersion(resourceId, hash, contentType, previousVersionHash?, changes?): void
  getHistory(resourceId): ResourceHistory | null
  getVersion(resourceId, version): ResourceVersion | null
  getCurrentVersion(resourceId): ResourceVersion | null
  verifyChain(resourceId): boolean
  toJSON(): object
}
```

The version manager:
- Maintains a map of resource IDs to their version arrays
- Assigns sequential version numbers starting at 1
- Records timestamps for each version
- Validates version chain integrity

### AssetResource Extensions

The `AssetResource` interface has been extended with:

```typescript
interface AssetResource {
  // ... existing fields ...
  version?: number;                // Version number (default 1)
  previousVersionHash?: string;    // Link to previous version
  createdAt?: string;              // ISO timestamp
}
```

These fields are optional to maintain backward compatibility with existing resources.

## Best Practices

1. **Always provide change descriptions**: Use the `changes` parameter to document what changed and why.

2. **Query by version when precision matters**: Use `getResourceVersion(id, version)` when you need a specific version, not just the latest.

3. **Store version references, not content**: Store version numbers or hashes as references rather than duplicating content.

4. **Validate chain integrity for auditing**: Use `verifyChain()` when auditing or validating provenance.

5. **Listen to events for reactive updates**: Subscribe to `resource:version:created` events to trigger downstream updates.

6. **Document versions with credentials**: Issue verifiable credentials for important version transitions to provide cryptographic proof.

## Security Considerations

- **Content hashes are cryptographically secure** (SHA-256)
- **Version chains are verifiable** and tampering is detectable
- **Immutability guarantees** prevent retroactive modification
- **All changes are auditable** via provenance chain
- **Works across trust boundaries** (peer → web → bitcoin)

## Limitations

- Creating a version with identical content will fail (by design)
- Version numbers are not globally unique, only unique per resource
- Deleting versions is not supported (immutability)
- Large version histories increase storage requirements

## Future Enhancements

Potential future improvements:
- Compression for version storage
- Delta encoding between versions
- Selective version pruning (with provenance preservation)
- Version tagging and labeling
- Branching and merging support
