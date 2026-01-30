# Originals Protocol — CEL Event Format Specification v2.0

**Status:** Draft - Revised Architecture  
**Version:** 2.0  
**Author:** Brian + Krusty  
**Date:** 2026-01-29
**Replaces:** All previous did:cel-only exploration documents

---

## Executive Summary

Originals is a protocol for creating digital assets that progress through three infrastructure layers, all validated by a **standardized Cryptographic Event Log (CEL)** format. Each layer uses **different DID methods for resolvability** while maintaining **consistent event formatting** across all stages.

**Key Insight:** `did:cel` is content-addressed and thus unresolvable without the log itself. Therefore, we retain the original three-layer DID progression while standardizing on CEL as the universal event format.

---

## Architecture

### Three-Layer Migration Model

```
Stage 1: Private Creation → Stage 2: Public Discovery → Stage 3: Bitcoin Permanence
      ↓                        ↓                          ↓
    did:peer                   did:webvh                 did:btco
       │                           │                          │
    ┌──┴────┐                  ┌────┴─────┐                ┌─┴───┐
    │ CEL   │                  │   CEL    │                │ CEL │
    │ logs  │                  │  logs    │                │logs │
    └───────┘                  └──────────┘                └─────┘
   (offline)                   (web)                      (Bitcoin)
```

### DID Layer Explanation

| Layer | DID Method | Purpose | DID Resolution | Cost |
|-------|------------|---------|----------------|------|
| **1** | `did:peer` | Private creation, offline validation | Self-contained | Free |
| **2** | `did:webvh` | Public discovery, web hosting | HTTPS endpoints | Hosting cost |
| **3** | `did:btco` | Bitcoin anchoring, tradeability | Bitcoin inscription lookup | Miner fees |

---

## CEL as Universal Format

### Event Structure (All Layers)

```json
{
  "events": [
    {
      "type": "create|update|deactivate|migrate",
      "data": {
        // Layer-specific content
        "resources": [...],
        "metadata": {...},
        // Migration data when changing layers
        "migration": {
          "fromLayer": "peer|webvh|btco",
          "toLayer": "webvh|btco",
          "previousDid": "did:..."
        }
      },
      "previousEvent": "<multihash>",
      "proof": [
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:..."
        },
        {
          "type": "WitnessProof",
          // Optional witness from each layer
          "witnessedAt": "2026-01-29T00:00:00Z",
          "witnessedBy": "layer-witness"
        }
      ]
    }
  ]
}
```

### Core Event Types (Universal)

#### 1. Create Event
Creates a new Original asset:
```json
{
  "type": "create",
  "data": {
    "content": {
      "urls": ["ipfs://", "https://"],
      "mediaType": "image/png",
      "digestMultibase": "uEI..."
    },
    "metadata": {
      "name": "My Digital Creation",
      "description": "...",
      "creator": "did:..."
    }
  },
  "proof": [{
    "verificationMethod": "did:peer:abc123#key-1"
  }]
}
```

#### 2. Update Event
Appends new content or changes state:
```json
{
  "type": "update",
  "previousEvent": "uEI...",
  "data": {
    "content": {"url": "https://new-location.com", "hash": "new-hash"},
    "metadata": {"version": "v2"}
  }
}
```

#### 3. Migrate Event
Records transition between layers:
```json
{
  "type": "migrate",
  "previousEvent": "uEI...",
  "data": {
    "migration": {
      "fromLayer": "peer",
      "toLayer": "webvh",
      "previousDid": "did:peer:abc123",
      "newDid": "did:webvh:example.com:asset-001",
      "migrationReason": "publish-to-web",
      "metadata": {"publishedAt": "https://example.com/asset-001.json"}
    }
  }
}
```

#### 4. Deactivate Event
Permanently marks log as final:
```json
{
  "type": "deactivate",
  "previousEvent": "uEI...",
  "data": {"reason": "burned"}
}
```

---

## Layer-Specific DID Documents

### Layer 1: did:peer
```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:peer:4z...",
  "verificationMethod": [...],
  "authentication": [...],
  "service": [
    {
      "id": "did:peer:4z...#cel-log",
      "type": "CelLog",
      "serviceEndpoint": "file://local/path/or/embedded"
    }
  ]
}
```

### Layer 2: did:webvh
```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://identity.foundation/didwebvh/v2"],
  "id": "did:webvh:example.com:user:asset-001",
  "domain": "example.com",
  "path": "user/asset-001",
  "service": [
    {
      "id": "did:webvh:...#cel-log",
      "type": "CelLog", 
      "serviceEndpoint": "https://example.com/.well-known/cel/user/asset-001.json"
    }
  ]
}
```

### Layer 3: did:btco
```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://originals.example.com/didbtco/v1"],
  "id": "did:btco:00000123456789abcdef...",
  "inscription": {
    "txid": "bitcoin-transaction-id",
    "ordinal": 123456789,
    "satpoint": "bitcoin-block-height:tx-index"
  },
  "service": [
    {
      "id": "did:btco:...#cel-log",
      "type": "CelLog",
      "serviceEndpoint": "https://bitcoin-anchored.example.com/cel/0000012345...json"
    }
  ]
}
```

---

## Implementation Phases

### Phase 1: Foundation (Immediate)
- [ ] Create `CEL_EVENT_SPEC.md` with detailed schema
- [ ] Implement CEL event types in TypeScript
- [ ] Build CEL serialization (JSON/CBOR)
- [ ] Create CEL verification algorithms

### Phase 2: Layer Integration
- [ ] Adopt CEL as primary format for existing layers
- [ ] Update migration events to use CEL format
- [ ] Build cross-layer validation
- [ ] Create comprehensive test suite

### Phase 3: Migration
- [ ] Archive previous exploration documents
- [ ] Update SDK to use CEL across all layers
- [ ] Create migration guide for existing assets
- [ ] Update documentation and examples

---

## Archive Plan

### Files to Deprecate/Archive
- `ORIGINALS_MINIMAL_SPEC.md` (did:cel-only approach)
- Any previous did:cel-specific proposals
- Exploration documents in `tasks/` related to did:cel identity layer

### Files to Create/Update
- `ORIGINALS_CEL_SPECIFICATION.md` (this document)
- `packages/sdk/src/cel/` module structure
- Layer-specific CEL implementations
- Migration tooling

---

## File Cleanup Strategy

1. **Archive** all did:cel-only exploration to `docs/archive/`
2. **Move** `ORIGINALS_MINIMAL_SPEC.md` → `docs/archive/CEL-only-exploration-v0.md`
3. **Create** new canonical spec at root: `ORIGINALS_CEL_SPECIFICATION.md`
4. **Update** README and CHANGELOG to reference new spec

---

## Next Steps

1. **Immediate**: Review this spec, identify gaps
2. **Week 1**: Implement CEL event types and serialization
3. **Week 2**: Update existing SDK to use CEL format
4. **Week 3**: Create comprehensive test suite and migration tools
5. **Final**: Clean up exploration artifacts, ship final spec

---

*This architecture resolves the fundamental did:cel resolution problem while maintaining the three-layer migration pattern that provides clear DID resolvability at each stage.*