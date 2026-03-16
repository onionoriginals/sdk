# IPFS Integration Specification

**Version:** 0.1.0 (Draft)
**Status:** Proposal
**Last Updated:** 2026-03-12
**Parent Issue:** ORI-34

## 1. Overview

This specification defines an optional IPFS storage adapter for the Originals SDK. The adapter implements the existing `StorageAdapter` interface, allowing asset resources to be stored on IPFS and retrieved via configurable gateways — without changing any SDK core interfaces.

### 1.1 Goals

- **Drop-in replacement.** `IPFSStorageAdapter` implements `StorageAdapter` and works anywhere the SDK accepts one.
- **Disabled by default.** IPFS is opt-in. The SDK's default behavior (memory or local storage) is unchanged.
- **Content-addressable by nature.** IPFS CIDs and the SDK's existing SHA-256 resource hashes serve complementary roles — the spec defines how they relate.
- **Hybrid retrieval.** Resources MAY be reachable via both HTTPS gateway URLs and native IPFS paths (`ipfs://`).

### 1.2 Non-Goals

- Replacing the SDK's existing hash-based content addressing with IPFS CIDs.
- Requiring IPFS for any existing workflow.
- Running a full IPFS node inside the SDK (the adapter talks to external nodes/services).

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────┐
│                   OriginalsSDK                       │
│                                                      │
│  ┌──────────────┐    ┌───────────────────────────┐   │
│  │ Lifecycle     │───▶│ StorageAdapter (interface) │   │
│  │ Manager       │    └───────────┬───────────────┘   │
│  └──────────────┘                │                   │
│                     ┌────────────┼────────────┐      │
│                     ▼            ▼            ▼      │
│              ┌──────────┐ ┌───────────┐ ┌─────────┐ │
│              │ Memory   │ │ Local     │ │  IPFS   │ │
│              │ Adapter  │ │ Adapter   │ │ Adapter │ │
│              └──────────┘ └───────────┘ └────┬────┘ │
│                                              │      │
└──────────────────────────────────────────────┼──────┘
                                               │
                        ┌──────────────────────┼──────────────┐
                        ▼                      ▼              ▼
                  ┌───────────┐        ┌────────────┐  ┌────────────┐
                  │ IPFS HTTP │        │ Pinata     │  │ NFT.storage│
                  │ API (local│        │ API        │  │ API        │
                  │ or remote)│        │            │  │            │
                  └───────────┘        └────────────┘  └────────────┘
```

The `IPFSStorageAdapter` delegates to one of three backends:

| Backend | Use Case |
|---------|----------|
| **IPFS HTTP API** | Local or remote IPFS node (Kubo, etc.) |
| **Pinata** | Managed pinning service |
| **NFT.storage** | Free, long-term storage for NFT data |

---

## 3. Interface

The adapter MUST implement the SDK's `StorageAdapter` interface defined in `src/storage/StorageAdapter.ts`:

```typescript
interface StorageAdapter {
  putObject(domain: string, path: string, content: Uint8Array | string, options?: PutOptions): Promise<string>;
  getObject(domain: string, path: string): Promise<GetObjectResult | null>;
  exists(domain: string, path: string): Promise<boolean>;
}
```

### 3.1 `IPFSStorageAdapter`

```typescript
import type { StorageAdapter, PutOptions, GetObjectResult } from '../storage/StorageAdapter';

interface IPFSStorageAdapterConfig {
  /** Backend to use for IPFS operations. */
  backend: IPFSBackendConfig;

  /**
   * Gateway URLs for constructing retrieval URLs.
   * The first gateway is used as the primary URL returned by putObject().
   * Additional gateways are available via getGatewayUrls().
   *
   * Defaults to ['https://ipfs.io'].
   */
  gatewayUrls?: string[];

  /**
   * If true, putObject() returns an ipfs:// URI instead of an HTTPS gateway URL.
   * Default: false.
   */
  preferNativeUri?: boolean;

  /**
   * Optional local cache to avoid redundant gateway fetches.
   * When set, getObject() checks the cache before hitting IPFS.
   */
  cache?: IPFSCache;
}

type IPFSBackendConfig =
  | { type: 'http-api'; url: string; headers?: Record<string, string> }
  | { type: 'pinata'; apiKey: string; secretApiKey: string; region?: string }
  | { type: 'nft-storage'; apiKey: string };
```

### 3.2 Behavior

#### `putObject(domain, path, content, options?)`

1. Convert `content` to `Uint8Array` if it is a `string` (UTF-8).
2. Add the content to IPFS via the configured backend. The backend returns a CID (v1, raw codec for single files).
3. Store a mapping of `${domain}/${path}` → CID in an internal index (see [Section 5](#5-domain-path-mapping)).
4. If pinning is supported by the backend, pin the CID.
5. Return a URL:
   - If `preferNativeUri` is true: `ipfs://${cid}`
   - Otherwise: `${gatewayUrls[0]}/ipfs/${cid}`

The `options.contentType` SHOULD be passed to the backend as metadata when supported (Pinata, NFT.storage).

#### `getObject(domain, path)`

1. Look up the CID for `${domain}/${path}` in the internal index.
2. If not found, return `null`.
3. If a `cache` is configured, check it first. On cache hit, return cached content.
4. Fetch content from the first reachable gateway in `gatewayUrls`.
5. On success, populate cache (if configured) and return `{ content, contentType }`.
6. If all gateways fail, throw a `StructuredError` with code `IPFS_GATEWAY_UNREACHABLE`.

#### `exists(domain, path)`

1. Return `true` if the internal index contains a CID for `${domain}/${path}`.

> **Note:** This checks the local index, not IPFS availability. To verify on-network availability, use `verifyPinned()` (see [Section 3.3](#33-extended-api)).

### 3.3 Extended API

Beyond the `StorageAdapter` interface, the adapter SHOULD expose additional IPFS-specific methods:

```typescript
interface IPFSStorageAdapterExtended extends StorageAdapter {
  /**
   * Returns the CID for a previously stored domain/path.
   * Returns null if the path has not been stored via this adapter.
   */
  getCid(domain: string, path: string): string | null;

  /**
   * Returns retrieval URLs for a CID across all configured gateways.
   */
  getGatewayUrls(cid: string): string[];

  /**
   * Checks whether a CID is pinned on the configured backend.
   * Returns false if the backend doesn't support pin status checks.
   */
  verifyPinned(cid: string): Promise<boolean>;

  /**
   * Stores content by CID directly (skip domain/path indexing).
   * Useful for importing externally-computed CIDs.
   */
  putByCid(cid: string, content: Uint8Array, options?: PutOptions): Promise<void>;
}
```

---

## 4. CID and Hash Relationship

The SDK uses SHA-256 hex hashes for content addressing (`AssetResource.hash`). IPFS uses CIDs (Content Identifiers) that encode a hash algorithm, codec, and version.

These are **complementary**, not competing:

| Property | SDK Hash (`AssetResource.hash`) | IPFS CID |
|----------|--------------------------------|----------|
| Algorithm | SHA-256 | SHA-256 (default for CIDv1) |
| Encoding | Hex string | Multibase (base32/base58btc) |
| Purpose | Content integrity verification | Content-addressed retrieval |
| Scope | Internal SDK identity | IPFS network addressing |

### 4.1 Verification

When content is retrieved from IPFS, the SDK's existing hash verification pipeline applies unchanged. The flow:

1. `getObject()` fetches content bytes from an IPFS gateway.
2. The SDK computes `SHA-256(content)` and compares it to `AssetResource.hash`.
3. If hashes match, the content is authentic. IPFS CID verification is an additional (redundant) integrity check.

The adapter MUST NOT modify or replace the SDK's `AssetResource.hash` field. The CID is a transport-layer address; the SDK hash is the source-of-truth identity.

### 4.2 CID-to-Hash Cross-Reference

Implementers MAY provide a utility to verify that an IPFS CID's embedded hash matches the SDK resource hash:

```typescript
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * Verifies that a CIDv1 (raw, sha2-256) matches an SDK hex hash.
 */
function cidMatchesHash(cidString: string, sdkHexHash: string): boolean {
  const cid = CID.parse(cidString);
  // CIDv1 with sha2-256 has digest bytes that should match
  const cidHashHex = Buffer.from(cid.multihash.digest).toString('hex');
  return cidHashHex === sdkHexHash;
}
```

---

## 5. Domain-Path Mapping

The `StorageAdapter` interface uses a `(domain, path)` tuple to address content. IPFS is content-addressed by CID, not by path. The adapter bridges this gap with an internal index.

### 5.1 Index Structure

```typescript
interface IPFSIndex {
  /** Map of "domain/path" → CID string */
  entries: Map<string, string>;

  /** Reverse map of CID → set of "domain/path" keys (for deduplication) */
  cidToKeys: Map<string, Set<string>>;
}
```

### 5.2 Deduplication

If two different `(domain, path)` pairs store identical content, IPFS naturally deduplicates at the CID level. The index MUST track both paths pointing to the same CID. This is a feature, not a bug — content-addressable storage means identical content is stored once.

### 5.3 Persistence

The index MUST be serializable to JSON for persistence across sessions. Implementers SHOULD store it alongside other SDK state (e.g., in the configured `storageAdapter`'s domain, or a local file).

```typescript
interface SerializedIPFSIndex {
  version: 1;
  entries: Array<{ key: string; cid: string }>;
}
```

---

## 6. Configuration

### 6.1 SDK Integration

```typescript
import { OriginalsSDK } from '@originals/sdk';
import { IPFSStorageAdapter } from '@originals/sdk/storage/ipfs';

const sdk = OriginalsSDK.create({
  storageAdapter: new IPFSStorageAdapter({
    backend: { type: 'pinata', apiKey: '...', secretApiKey: '...' },
    gatewayUrls: [
      'https://gateway.pinata.cloud',
      'https://ipfs.io',
      'https://cloudflare-ipfs.com',
    ],
  }),
});
```

### 6.2 Hybrid Storage (HTTPS + IPFS)

For use cases where resources should be available on both HTTPS and IPFS, implementers MAY compose adapters:

```typescript
import { HybridStorageAdapter } from '@originals/sdk/storage/hybrid';

const sdk = OriginalsSDK.create({
  storageAdapter: new HybridStorageAdapter({
    primary: new LocalStorageAdapter({ baseDir: './assets', baseUrl: 'https://cdn.example.com' }),
    secondary: new IPFSStorageAdapter({
      backend: { type: 'nft-storage', apiKey: '...' },
    }),
  }),
});
```

The `HybridStorageAdapter`:
- `putObject()` writes to **both** adapters. Returns the primary adapter's URL.
- `getObject()` reads from primary first, falls back to secondary.
- `exists()` returns `true` if either adapter has the content.

This pattern supports progressive enhancement: existing HTTPS-hosted resources gain IPFS redundancy without changing retrieval URLs.

### 6.3 CEL External References

When IPFS is enabled, the SDK SHOULD populate `ExternalReference.url[]` with both HTTPS and IPFS URLs:

```json
{
  "digestMultibase": "uLCA...",
  "mediaType": "image/png",
  "url": [
    "https://gateway.pinata.cloud/ipfs/bafk...",
    "ipfs://bafk..."
  ]
}
```

This is compatible with the existing `ExternalReference` type — no schema changes required.

---

## 7. Error Handling

The adapter MUST use `StructuredError` from `src/utils/telemetry.ts` for all error conditions.

| Error Code | Condition | Recovery Guidance |
|---|---|---|
| `IPFS_BACKEND_UNREACHABLE` | Cannot connect to the configured IPFS backend | Check backend URL/credentials. Verify the IPFS node or pinning service is running. |
| `IPFS_GATEWAY_UNREACHABLE` | All configured gateways failed to serve content | Add more gateways to `gatewayUrls`. Check network connectivity. Content may not yet be propagated — retry after a delay. |
| `IPFS_PIN_FAILED` | Backend accepted content but pinning failed | Content was added but may be garbage-collected. Retry pin operation or switch to a pinning service. |
| `IPFS_CONTENT_TOO_LARGE` | Content exceeds backend size limits | Split content or use a backend with higher limits. Pinata free tier: 100MB per file. |
| `IPFS_INVALID_CID` | A CID string failed to parse | Verify the CID format. SDK expects CIDv1 with SHA-256. |
| `IPFS_INDEX_CORRUPT` | The domain-path index failed to load or is inconsistent | Delete and rebuild the index from IPFS pin list. |

---

## 8. Security Considerations

### 8.1 Gateway Trust

IPFS gateways are untrusted intermediaries. Content fetched via a gateway MUST be verified against the SDK's `AssetResource.hash` before use. The SDK already performs this verification — no additional work is needed at the adapter layer.

### 8.2 API Key Management

Pinning service API keys (`pinata.apiKey`, `nft-storage.apiKey`) are secrets. They MUST NOT be:
- Logged (even at debug level)
- Included in error messages
- Stored in credentials or asset metadata

The SDK's existing `sanitizeLogs: true` configuration SHOULD redact these values.

### 8.3 Content Availability

IPFS does not guarantee content availability. Unpinned content may be garbage-collected by nodes. For assets requiring long-term availability:
- Use a pinning service (Pinata, NFT.storage) rather than a single IPFS node.
- Consider `HybridStorageAdapter` with an HTTPS fallback.
- For did:btco assets, the Bitcoin inscription is the permanent record; IPFS serves as a convenience layer for large payloads.

### 8.4 Privacy

Content added to IPFS is public and content-addressed. Anyone with the CID can retrieve it. Do NOT store private or sensitive content on IPFS unless it is encrypted before storage. The adapter does not provide encryption — this is the caller's responsibility.

---

## 9. Testing Strategy

### 9.1 Unit Tests

- `IPFSStorageAdapter` implements `StorageAdapter` correctly (put/get/exists contract).
- Domain-path index: insertion, lookup, deduplication, serialization/deserialization.
- CID-to-hash cross-reference verification.
- Error handling for each error code.
- `preferNativeUri` flag produces `ipfs://` URIs.
- Gateway URL construction with multiple gateways.

### 9.2 Integration Tests

- Mock IPFS HTTP API backend: add, pin, cat operations.
- Mock Pinata API: upload, pin, retrieve.
- Gateway fallback: first gateway fails, second succeeds.
- `HybridStorageAdapter` writes to both adapters and reads with fallback.

### 9.3 End-to-End Tests

- Full asset lifecycle with IPFS storage: `createAsset()` → `publishToWeb()` → verify content retrievable via gateway.
- CEL external reference includes IPFS URLs.
- Content hash verification after IPFS round-trip.

---

## 10. Implementation Phases

### Phase 1: Core Adapter
- `IPFSStorageAdapter` with IPFS HTTP API backend only.
- Domain-path index (in-memory + JSON serialization).
- Gateway URL construction and content retrieval.
- Unit and integration tests with mock IPFS API.

### Phase 2: Pinning Services
- Pinata backend.
- NFT.storage backend.
- `verifyPinned()` implementation per backend.
- Backend-specific integration tests.

### Phase 3: Hybrid and CEL Integration
- `HybridStorageAdapter` for HTTPS + IPFS.
- CEL `ExternalReference` population with IPFS URLs.
- Optional local cache (`IPFSCache`).
- End-to-end lifecycle tests.

---

## 11. Dependencies

| Package | Purpose | Size Impact |
|---------|---------|-------------|
| `multiformats` | CID creation/parsing, multihash | ~15KB |
| `ipfs-http-client` (or `kubo-rpc-client`) | IPFS HTTP API communication | ~50KB (optional, only for http-api backend) |

Pinning service backends use standard HTTP (`fetch`) — no additional dependencies.

The adapter SHOULD be tree-shakeable: importing `IPFSStorageAdapter` without a pinning backend should not pull in pinning-specific code.

---

## 12. Open Questions

1. **Should the adapter support IPFS directories (DAGs)?** Current design is single-file CIDs. Bundling an asset's resources into an IPFS directory would give a single root CID per asset, but adds complexity.

2. **Should CIDs be stored in `AssetResource` metadata?** Adding an optional `ipfsCid` field to `AssetResource` would make the CID discoverable without the adapter's index, but requires a type change.

3. **CAR file export?** For backup/portability, exporting an asset's IPFS data as a CAR (Content Archive) file could be valuable. Out of scope for v0.1 but worth considering.

---

## Appendix A: Example Flows

### A.1 Publish Asset with IPFS Storage

```typescript
import { OriginalsSDK } from '@originals/sdk';
import { IPFSStorageAdapter } from '@originals/sdk/storage/ipfs';

// Configure SDK with IPFS
const sdk = OriginalsSDK.create({
  storageAdapter: new IPFSStorageAdapter({
    backend: { type: 'pinata', apiKey: PINATA_KEY, secretApiKey: PINATA_SECRET },
    gatewayUrls: ['https://gateway.pinata.cloud', 'https://ipfs.io'],
  }),
  webvhNetwork: 'magby',
});

// Create an asset with a resource
const asset = await sdk.lifecycle.createAsset({
  name: 'My Artwork',
  resources: [{
    id: 'artwork',
    type: 'image',
    contentType: 'image/png',
    content: imageBytes, // Uint8Array
  }],
});

// Publish to web — resource is stored on IPFS via the adapter
const published = await sdk.lifecycle.publishToWeb(asset, {
  domain: 'magby.originals.build',
  paths: ['art', 'my-artwork'],
});

// Resource URL is now an IPFS gateway URL:
// "https://gateway.pinata.cloud/ipfs/bafkreig..."
console.log(published.resources[0].url);
```

### A.2 Verify IPFS Content Integrity

```typescript
const adapter = sdk.config.storageAdapter as IPFSStorageAdapter;

// Get the CID for a stored resource
const cid = adapter.getCid('magby.originals.build', 'resources/uLCA...');

// Verify CID matches the SDK resource hash
const resource = asset.resources[0];
const matches = cidMatchesHash(cid, resource.hash);
console.log(`CID matches SDK hash: ${matches}`); // true
```
