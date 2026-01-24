# Originals CEL Developer Guide

**Version:** 1.0.0  
**Date:** January 2026

A practical guide to using the Originals CEL (Cryptographic Event Log) SDK for building verifiable digital asset provenance.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Core Concepts](#2-core-concepts)
3. [SDK API Reference](#3-sdk-api-reference)
4. [CLI Usage](#4-cli-usage)
5. [Convex Integration](#5-convex-integration)
6. [Further Reading](#6-further-reading)

---

## 1. Quick Start

Get up and running with Originals CEL in 5 minutes.

### Installation

```bash
npm install @originals/sdk
# or
bun add @originals/sdk
```

### Create Your First Asset

```typescript
import { OriginalsCel, createExternalReference, computeDigestMultibase } from '@originals/sdk';
import * as ed from '@noble/ed25519';

// 1. Generate a signing key pair
const privateKey = ed.utils.randomPrivateKey();
const publicKey = await ed.getPublicKeyAsync(privateKey);

// 2. Create a signer function
const signer = async (data: unknown) => {
  const dataBytes = new TextEncoder().encode(JSON.stringify(data));
  const signature = await ed.signAsync(dataBytes, privateKey);
  
  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: `did:key:z${Buffer.from(publicKey).toString('base64url')}#key-0`,
    proofPurpose: 'assertionMethod',
    proofValue: `z${Buffer.from(signature).toString('base64url')}`,
  };
};

// 3. Initialize the SDK
const cel = new OriginalsCel({
  layer: 'peer',
  signer,
});

// 4. Create an asset with a resource
const imageData = await fetch('./artwork.png').then(r => r.arrayBuffer());
const resource = createExternalReference(
  new Uint8Array(imageData),
  'image/png',
  ['ipfs://QmYourHash...']
);

const log = await cel.create('My Digital Artwork', [resource]);
console.log('Asset created:', log);

// 5. Verify the log
const result = await cel.verify(log);
console.log('Verified:', result.verified);
```

### Using the CLI

```bash
# Create an asset
npx originals-cel create --name "My Asset" --file ./image.png

# Verify the log
npx originals-cel verify --log ./asset.cel.json

# Inspect the event timeline
npx originals-cel inspect --log ./asset.cel.json
```

---

## 2. Core Concepts

### 2.1 Event Logs

An **Event Log** is an ordered sequence of cryptographically linked events that records the complete history of a digital asset.

```typescript
interface EventLog {
  events: LogEntry[];       // Ordered array of events
  previousLog?: string;     // Link to previous log chunk (for archival)
}

interface LogEntry {
  type: 'create' | 'update' | 'deactivate';
  data: unknown;           // Event-specific payload
  previousEvent?: string;  // Hash of previous event (hash chain)
  proof: DataIntegrityProof[];  // Cryptographic proofs
}
```

#### Event Types

| Type | Purpose | First Event? | Has previousEvent? |
|------|---------|--------------|-------------------|
| `create` | Initialize new asset | Yes (always) | No |
| `update` | Modify metadata/resources | No | Yes |
| `deactivate` | Seal the log permanently | No (always last) | Yes |

### 2.2 Trust Layers

Assets exist in one of three **trust layers**, each providing different levels of verification:

```
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │  PEER LAYER (did:peer)                                   │
   │  • Local, self-issued DIDs                               │
   │  • No external witnesses                                 │
   │  • Instant, free creation                                │
   │  • Verification: cryptographic proof only                │
   │                                                          │
   └───────────────────────────┬──────────────────────────────┘
                               │ migrate()
                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │  WEBVH LAYER (did:webvh)                                 │
   │  • Domain-bound DIDs with version history                │
   │  • Optional HTTP witness attestations                    │
   │  • Requires domain ownership                             │
   │  • Verification: proof + optional witness                │
   │                                                          │
   └───────────────────────────┬──────────────────────────────┘
                               │ migrate()
                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │  BTCO LAYER (did:btco)                                   │
   │  • Bitcoin ordinals inscription DIDs                     │
   │  • Required Bitcoin witness attestation                  │
   │  • Immutable on-chain anchor                             │
   │  • Verification: proof + Bitcoin witness (txid, block)   │
   │                                                          │
   └──────────────────────────────────────────────────────────┘
```

**Migration is one-way**: `peer → webvh → btco`. You cannot migrate backwards.

### 2.3 Witnesses

**Witnesses** are third-party services that attest to an event's existence at a specific point in time. They add independent verification without requiring trust in the asset controller.

```typescript
// WitnessProof extends DataIntegrityProof with a timestamp
interface WitnessProof extends DataIntegrityProof {
  witnessedAt: string;  // ISO 8601 timestamp from witness
}

// Bitcoin witnesses include additional blockchain data
interface BitcoinWitnessProof extends WitnessProof {
  txid: string;           // Bitcoin transaction ID
  blockHeight: number;    // Block number
  satoshi: number;        // Ordinal satoshi number
  inscriptionId: string;  // Ordinals inscription ID
}
```

#### Witness Types by Layer

| Layer | Witness Type | Requirement |
|-------|-------------|-------------|
| peer | None | No witnesses |
| webvh | HTTP Witness | Optional (0 or more) |
| btco | Bitcoin Witness | Required (exactly 1) |

### 2.4 Hash Chain Integrity

Every event (except the first `create`) includes a `previousEvent` field containing the SHA-256 hash of the prior event:

```
Event 1 (create)        Event 2 (update)        Event 3 (update)
┌─────────────┐        ┌─────────────────┐     ┌─────────────────┐
│ data: {...} │   ──►  │ previousEvent:  │ ──► │ previousEvent:  │
│ proof: [...│]        │   hash(Event 1) │     │   hash(Event 2) │
│             │        │ data: {...}     │     │ data: {...}     │
└─────────────┘        └─────────────────┘     └─────────────────┘
```

This hash chain ensures:
- Events cannot be reordered
- Events cannot be removed
- Events cannot be modified after signing

### 2.5 External References

Large resources (images, videos, documents) are **referenced** rather than embedded:

```typescript
interface ExternalReference {
  digestMultibase: string;  // SHA-256 hash (base64url with 'u' prefix)
  mediaType?: string;       // MIME type (e.g., 'image/png')
  url?: string[];           // Retrieval URLs (IPFS, HTTP, etc.)
}
```

Create references using the helper function:

```typescript
import { createExternalReference, verifyExternalReference } from '@originals/sdk';

// Create a reference from content
const content = new Uint8Array([...]); // Your file data
const ref = createExternalReference(content, 'image/png', ['https://cdn.example.com/image.png']);

// Later, verify content matches the reference
const isValid = verifyExternalReference(ref, downloadedContent);
```

---

## 3. SDK API Reference

### 3.1 OriginalsCel Class

The unified entry point for all CEL operations.

#### Constructor

```typescript
const cel = new OriginalsCel({
  layer: 'peer' | 'webvh' | 'btco',
  signer: CelSigner,
  config?: OriginalsCelConfig
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `layer` | `'peer' \| 'webvh' \| 'btco'` | Target layer for operations |
| `signer` | `CelSigner` | Function that produces DataIntegrityProofs |
| `config` | `OriginalsCelConfig` | Optional layer-specific configuration |

#### CelSigner Type

```typescript
type CelSigner = (data: unknown) => Promise<DataIntegrityProof>;
```

#### Methods

##### `create(name, resources): Promise<EventLog>`

Creates a new asset with an initial `create` event.

```typescript
const log = await cel.create('My Asset', [
  { digestMultibase: 'uXYZ...', mediaType: 'image/png' }
]);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Human-readable asset name |
| `resources` | `ExternalReference[]` | Associated resources |
| **Returns** | `Promise<EventLog>` | Event log with create event |

> **Note**: Assets can only be created at the `peer` layer. Create first, then migrate to other layers.

---

##### `update(log, data): Promise<EventLog>`

Appends an `update` event to an existing log.

```typescript
const updated = await cel.update(log, {
  description: 'Updated description',
  tags: ['art', 'digital']
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `log` | `EventLog` | Existing event log |
| `data` | `unknown` | Update payload (merged with current state) |
| **Returns** | `Promise<EventLog>` | New event log (original not mutated) |

---

##### `verify(log, options?): Promise<VerificationResult>`

Verifies all proofs and hash chain integrity.

```typescript
const result = await cel.verify(log);

if (result.verified) {
  console.log('All proofs and hash chain valid');
} else {
  console.error('Verification failed:', result.errors);
  result.events.forEach(e => {
    console.log(`Event ${e.index}: proof=${e.proofValid}, chain=${e.chainValid}`);
  });
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `log` | `EventLog` | Event log to verify |
| `options` | `VerifyOptions` | Optional custom verifier |
| **Returns** | `Promise<VerificationResult>` | Detailed verification result |

**VerificationResult Structure:**

```typescript
interface VerificationResult {
  verified: boolean;          // Overall result
  errors: string[];           // Top-level errors
  events: EventVerification[];  // Per-event details
}

interface EventVerification {
  index: number;
  type: 'create' | 'update' | 'deactivate';
  proofValid: boolean;
  chainValid: boolean;
  errors: string[];
}
```

---

##### `migrate(log, targetLayer, options?): Promise<EventLog>`

Migrates an asset to a higher trust layer.

```typescript
// Peer to WebVH (requires domain)
const webvhLog = await cel.migrate(peerLog, 'webvh', {
  domain: 'example.com'
});

// WebVH to BTCO (requires BitcoinManager in config)
const btcoLog = await cel.migrate(webvhLog, 'btco');
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `log` | `EventLog` | Event log to migrate |
| `targetLayer` | `CelLayer` | Target layer (`'webvh'` or `'btco'`) |
| `options` | `{ domain?: string }` | Domain for webvh migration |
| **Returns** | `Promise<EventLog>` | Migrated event log |

**Valid Migration Paths:**
- `peer → webvh` (requires `domain` option)
- `webvh → btco` (requires `BitcoinManager` in config)
- ❌ `peer → btco` (not allowed - must go through webvh)
- ❌ `btco → webvh` (not allowed - no reverse migration)

---

##### `getCurrentState(log): AssetState`

Derives the current asset state by replaying all events.

```typescript
const state = cel.getCurrentState(log);

console.log(state.name);        // "My Asset"
console.log(state.layer);       // "peer" | "webvh" | "btco"
console.log(state.did);         // Current DID
console.log(state.deactivated); // false
console.log(state.metadata);    // Custom fields
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `log` | `EventLog` | Event log to derive state from |
| **Returns** | `AssetState` | Current state after all events |

**AssetState Structure:**

```typescript
interface AssetState {
  did: string;
  name?: string;
  layer: 'peer' | 'webvh' | 'btco';
  resources: ExternalReference[];
  creator?: string;
  createdAt?: string;
  updatedAt?: string;
  deactivated: boolean;
  metadata?: Record<string, unknown>;
}
```

---

### 3.2 Layer Managers

For more control, use layer-specific managers directly:

```typescript
import { PeerCelManager, WebVHCelManager, BtcoCelManager } from '@originals/sdk';

// Peer layer
const peer = new PeerCelManager(signer);
const log = await peer.create('Asset', resources);

// WebVH layer (for migration)
const webvh = new WebVHCelManager(signer, 'example.com', [httpWitness]);
const migratedLog = await webvh.migrate(log);

// BTCO layer
const btco = new BtcoCelManager(signer, bitcoinManager);
const btcoLog = await btco.migrate(migratedLog);
```

### 3.3 Helper Functions

```typescript
// Hash computation
import { computeDigestMultibase, verifyDigestMultibase } from '@originals/sdk';

const hash = computeDigestMultibase(contentBytes);  // "uXYZ..."
const isValid = verifyDigestMultibase(contentBytes, hash);

// External references
import { createExternalReference, verifyExternalReference } from '@originals/sdk';

const ref = createExternalReference(content, 'image/png', ['https://...']);
const matches = verifyExternalReference(ref, content);

// Serialization
import { serializeEventLogJson, parseEventLogJson } from '@originals/sdk';
import { serializeEventLogCbor, parseEventLogCbor } from '@originals/sdk';

const json = serializeEventLogJson(log);
const parsed = parseEventLogJson(json);

const cbor = serializeEventLogCbor(log);  // Uint8Array (20-40% smaller)
const parsedCbor = parseEventLogCbor(cbor);
```

### 3.4 Witness Services

```typescript
import { HttpWitness, BitcoinWitness } from '@originals/sdk';

// HTTP Witness
const httpWitness = new HttpWitness('https://witness.example.com/api/witness', {
  timeout: 10000,
  headers: { 'X-API-Key': 'your-key' }
});

// Bitcoin Witness
const bitcoinWitness = new BitcoinWitness(bitcoinManager, {
  feeRate: 5,
  verificationMethod: 'did:btco:...'
});
```

---

## 4. CLI Usage

The `originals-cel` CLI provides command-line access to CEL operations.

### Installation

```bash
# Via npm/bun (global)
npm install -g @originals/sdk

# Or run directly via npx
npx originals-cel --help
```

### Commands Overview

```
originals-cel <command> [options]

Commands:
  create    Create a new CEL asset with an initial event
  verify    Verify an existing CEL event log
  inspect   Inspect a CEL log in human-readable format
  migrate   Migrate a CEL asset between layers
```

---

### 4.1 create

Creates a new CEL asset from a file.

```bash
originals-cel create --name <name> --file <path> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--name <name>` | Asset name (required) |
| `--file <path>` | Path to content file (required) |
| `--key <path>` | Ed25519 private key file (generates new if not provided) |
| `--output <path>` | Output file (stdout if not provided) |
| `--format <type>` | Output format: `json` (default) or `cbor` |

**Examples:**

```bash
# Create an asset (generates new key, outputs JSON to stdout)
originals-cel create --name "My Artwork" --file ./image.png

# Create with specific output file
originals-cel create --name "Document" --file ./doc.pdf --output ./doc.cel.json

# Create with existing key and CBOR output
originals-cel create --name "Asset" --file ./data.bin --key ./my-key.json --format cbor --output ./asset.cel.cbor
```

**Key File Formats:**

```json
// JSON format
{ "privateKey": "z3u2en..." }

// Or raw multibase string
z3u2en...
```

---

### 4.2 verify

Verifies all proofs and hash chain integrity in a CEL log.

```bash
originals-cel verify --log <path>
```

**Options:**

| Flag | Description |
|------|-------------|
| `--log <path>` | Path to CEL log file (required) |

**Output:**
- Shows event-by-event verification breakdown
- Displays witness attestations if present
- Exit code 0 on success, 1 on failure

**Examples:**

```bash
# Verify a CEL log
originals-cel verify --log ./asset.cel.json

# Verify CBOR format
originals-cel verify --log ./asset.cel.cbor
```

**Sample Output:**

```
CEL Verification Report
═══════════════════════

Result: ✓ VERIFIED

Events (3):
  [0] create  ✓ Proof Valid  ✓ Chain Valid
  [1] update  ✓ Proof Valid  ✓ Chain Valid
  [2] update  ✓ Proof Valid  ✓ Chain Valid

Witnesses:
  Event 2: Witnessed at 2026-01-20T12:00:01Z by did:web:witness.example.com
```

---

### 4.3 inspect

Displays a CEL log in human-readable format.

```bash
originals-cel inspect --log <path>
```

**Options:**

| Flag | Description |
|------|-------------|
| `--log <path>` | Path to CEL log file (required) |

**Output:**
- Event timeline with timestamps
- Current derived state
- Witness attestations
- Layer migration history

**Examples:**

```bash
originals-cel inspect --log ./asset.cel.json
```

**Sample Output:**

```
CEL Asset Inspection
════════════════════

Current State:
  Name: My Digital Artwork
  DID: did:webvh:example.com:abc123
  Layer: webvh
  Status: Active
  Created: 2026-01-20T10:00:00Z
  Updated: 2026-01-21T10:00:00Z

Resources (1):
  [0] image/png - uQvPc... (ipfs://QmABC...)

Event Timeline:
  2026-01-20T10:00:00Z  [CREATE]   Initial creation
  2026-01-20T11:00:00Z  [UPDATE]   Added description
  2026-01-21T10:00:00Z  [MIGRATE]  peer → webvh (example.com)

Layer History:
  peer   → webvh (2026-01-21T10:00:00Z)
```

---

### 4.4 migrate

Migrates a CEL asset between trust layers.

```bash
originals-cel migrate --log <path> --to <layer> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--log <path>` | Path to CEL log file (required) |
| `--to <layer>` | Target layer: `webvh` or `btco` (required) |
| `--domain <domain>` | Domain for webvh (required for webvh) |
| `--wallet <path>` | Bitcoin wallet key (required for btco) |
| `--output <path>` | Output file (stdout if not provided) |
| `--format <type>` | Output format: `json` (default) or `cbor` |

**Examples:**

```bash
# Migrate peer to webvh
originals-cel migrate --log ./asset.cel.json --to webvh --domain example.com

# Migrate webvh to btco
originals-cel migrate --log ./asset.cel.json --to btco --wallet ./wallet.key

# With output file
originals-cel migrate --log ./peer.cel.json --to webvh --domain my.com --output ./webvh.cel.json
```

**Valid Migration Paths:**

```
peer → webvh (requires --domain)
webvh → btco (requires --wallet)
```

---

## 5. Convex Integration

The Explorer app uses [Convex](https://convex.dev) for real-time database operations. Here's how to integrate CEL with Convex.

### 5.1 Schema Setup

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  originals: defineTable({
    name: v.string(),
    did: v.string(),
    layer: v.union(v.literal("peer"), v.literal("webvh"), v.literal("btco")),
    creatorDid: v.string(),
    metadata: v.optional(v.any()),
    celLog: v.optional(v.any()),        // EventLog JSON
    celVersion: v.optional(v.string()),
    celVerifiedAt: v.optional(v.number()),
  })
    .index("by_did", ["did"])
    .index("by_creatorDid", ["creatorDid"])
    .index("by_layer", ["layer"]),
});
```

### 5.2 React Hooks

#### useOriginal - Fetch Single Original

```typescript
import { useOriginal } from '@/hooks/useOriginal';

function OriginalDetail({ id }: { id: string }) {
  const { original, isLoading, error } = useOriginal(id);
  
  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!original) return <div>Not found</div>;
  
  return (
    <div>
      <h1>{original.name}</h1>
      <p>Layer: {original.layer}</p>
      {original.celLog && (
        <p>Events: {original.celLog.events.length}</p>
      )}
    </div>
  );
}
```

#### useOriginals - Fetch Paginated List

```typescript
import { useOriginals } from '@/hooks/useOriginals';

function OriginalsList() {
  const { originals, isLoading, continueCursor, isDone } = useOriginals({
    layer: 'webvh',  // Optional filter
  });
  
  return (
    <ul>
      {originals?.map(original => (
        <li key={original._id}>{original.name}</li>
      ))}
      {!isDone && <button>Load More</button>}
    </ul>
  );
}
```

#### useCelVerification - Verify CEL Log

```typescript
import { useCelVerification } from '@/hooks/useCelVerification';

function VerifyButton({ originalId }: { originalId: string }) {
  const { verify, result, isVerifying, error } = useCelVerification(originalId);
  
  const handleVerify = async () => {
    const verification = await verify();
    if (verification?.verified) {
      toast.success('Verification passed!');
    }
  };
  
  return (
    <div>
      <button onClick={handleVerify} disabled={isVerifying}>
        {isVerifying ? 'Verifying...' : 'Verify Provenance'}
      </button>
      
      {error && <p className="text-red-500">{error}</p>}
      
      {result && (
        <div className={result.verified ? 'text-green-500' : 'text-red-500'}>
          {result.verified ? '✓ Verified' : '✗ Failed'}
          <ul>
            {result.events.map((event, i) => (
              <li key={i}>
                Event {i}: {event.type} - 
                Proof: {event.proofValid ? '✓' : '✗'}, 
                Chain: {event.chainValid ? '✓' : '✗'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

#### useCreateOriginal - Create New Original

```typescript
import { useCreateOriginal } from '@/hooks/useCreateOriginal';

function CreateForm() {
  const { createOriginal, isCreating, error } = useCreateOriginal();
  
  const handleSubmit = async (formData: FormData) => {
    const file = formData.get('file') as File;
    const content = new Uint8Array(await file.arrayBuffer());
    
    // Compute content hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const digestMultibase = 'u' + btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    
    await createOriginal({
      name: formData.get('name') as string,
      resources: [{
        digestMultibase,
        mediaType: file.type,
        url: ['https://your-storage.com/...']
      }],
      creatorDid: 'did:peer:...',
    });
  };
  
  return (
    <form onSubmit={handleSubmit}>
      <input name="name" placeholder="Asset name" required />
      <input name="file" type="file" required />
      <button type="submit" disabled={isCreating}>
        {isCreating ? 'Creating...' : 'Create Original'}
      </button>
    </form>
  );
}
```

#### useMigrateOriginal - Migrate Between Layers

```typescript
import { useMigrateOriginal } from '@/hooks/useMigrateOriginal';

function MigrateButton({ originalId, currentLayer }: Props) {
  const { migrate, isMigrating, error } = useMigrateOriginal();
  
  const handleMigrate = async () => {
    if (currentLayer === 'peer') {
      await migrate(originalId, 'webvh', { domain: 'example.com' });
    } else if (currentLayer === 'webvh') {
      await migrate(originalId, 'btco');
    }
  };
  
  const nextLayer = currentLayer === 'peer' ? 'webvh' : 'btco';
  
  return (
    <button onClick={handleMigrate} disabled={isMigrating || currentLayer === 'btco'}>
      {isMigrating ? 'Migrating...' : `Migrate to ${nextLayer}`}
    </button>
  );
}
```

### 5.3 Real-Time Updates

Convex provides real-time reactivity out of the box. When data changes on the server, all subscribed clients automatically update:

```typescript
// This component automatically updates when any original changes
function OriginalsCount() {
  const { originals } = useOriginals();
  return <span>{originals?.length ?? 0} originals</span>;
}
```

### 5.4 Server-Side Verification

Use Convex actions for server-side CEL verification:

```typescript
// convex/cel.ts
"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";

export const verifyCelLog = action({
  args: { originalId: v.id("originals") },
  returns: v.object({
    verified: v.boolean(),
    errors: v.array(v.string()),
    events: v.array(v.object({
      index: v.number(),
      type: v.string(),
      proofValid: v.boolean(),
      chainValid: v.boolean(),
      errors: v.array(v.string()),
    })),
  }),
  handler: async (ctx, { originalId }) => {
    // Fetch original
    const original = await ctx.runQuery(internal.cel.getOriginalInternal, { originalId });
    if (!original?.celLog) {
      return { verified: false, errors: ["No CEL log found"], events: [] };
    }
    
    // Import SDK and verify
    const { verifyEventLog } = await import("@originals/sdk");
    const result = await verifyEventLog(original.celLog);
    
    // Update verification timestamp on success
    if (result.verified) {
      await ctx.runMutation(internal.cel.updateCelVerifiedAt, {
        originalId,
        timestamp: Date.now(),
      });
    }
    
    return result;
  },
});
```

---

## 6. Further Reading

### Specifications

- **[Originals CEL Application Specification](./ORIGINALS_CEL_SPEC.md)** - Formal technical specification for the CEL format, event types, migration rules, and verification algorithms.

- **[Originals Protocol Whitepaper](../originals-whitepaper.md)** - Overview of the Originals Protocol, including the three-layer trust model and DID methods.

### External References

- [W3C CCG Cryptographic Event Log Specification](https://w3c-ccg.github.io/cel-spec/) - The underlying standard this implementation is based on.

- [W3C Data Integrity 1.0](https://w3c.github.io/vc-data-integrity/) - Specification for cryptographic proofs.

- [DID Core Specification](https://www.w3.org/TR/did-core/) - W3C standard for Decentralized Identifiers.

- [Convex Documentation](https://docs.convex.dev) - Real-time database platform used by the Explorer app.

### Support

- GitHub Issues: Report bugs and feature requests
- Discussions: Ask questions and share ideas

---

## Appendix A: Migration Checklist

When migrating assets between layers, ensure:

### Peer → WebVH

- [ ] Have domain ownership or access
- [ ] Domain is configured for did:webvh resolution
- [ ] (Optional) HTTP witness service is available
- [ ] Provide `domain` option to migrate()

### WebVH → BTCO

- [ ] Bitcoin wallet with sufficient balance
- [ ] BitcoinManager configured in SDK
- [ ] Understand inscription fees and timing
- [ ] Provide `wallet` path to CLI or config to SDK

---

## Appendix B: Troubleshooting

### "Cannot create assets at X layer directly"

Assets can only be created at the peer layer. Create at peer first, then use `migrate()` to move to webvh or btco.

### "Invalid migration path"

Migration must follow the path: `peer → webvh → btco`. You cannot:
- Skip layers (peer → btco directly)
- Migrate backwards (btco → webvh)

### "Hash chain broken"

The `previousEvent` hash doesn't match the actual hash of the previous event. This indicates tampering or corruption. The log cannot be verified.

### "Verification failed: Invalid proof structure"

Check that proofs have all required fields:
- `type`: "DataIntegrityProof"
- `cryptosuite`: e.g., "eddsa-jcs-2022"
- `created`: ISO 8601 timestamp
- `verificationMethod`: DID URL
- `proofPurpose`: e.g., "assertionMethod"
- `proofValue`: Multibase-encoded signature

### Convex "Cannot find module '@originals/sdk'"

Ensure the SDK is installed in your project:

```bash
npm install @originals/sdk
```

For Convex actions using Node.js, add `"use node";` at the top of the file.

---

*Document Version: 1.0.0 | Last Updated: January 2026*
