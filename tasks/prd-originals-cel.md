# PRD: Originals CEL Reference Implementation

## Introduction

This document specifies a reference implementation combining the **Originals Protocol** (decentralized digital asset lifecycle) with the **W3C CCG Cryptographic Event Log (CEL) specification** (tamper-evident event logging). The result is "Originals CEL"—a standards-compliant implementation where every asset's provenance is represented as a cryptographic event log.

### Why CEL for Originals?

The Originals protocol already uses Verifiable Credentials (VCs) to represent events like `ResourceCreated`, `ResourceUpdated`, and `ResourceMigrated`. CEL provides a **standardized log structure** for these events with:

- **Hash-chained events** — Each event references the previous, creating tamper-evident history
- **Witness support** — Third parties can attest to event existence at specific times
- **Minimal invention** — Both specs are W3C-aligned; we implement, not invent

**Key Mapping:**
| Originals Concept | CEL Equivalent |
|-------------------|----------------|
| ResourceCreated VC | `create` event |
| ResourceUpdated VC | `update` event |
| ResourceMigrated VC | `update` event with migration data |
| Asset deactivation | `deactivate` event |
| Layer witnesses | Event witnesses (Bitcoin for did:btco) |

## Goals

- Implement the **Originals CEL Application Specification** as defined by the CEL spec
- Provide a TypeScript library supporting all three Originals layers: `did:peer`, `did:webvh`, `did:btco`
- Use **Ed25519 / eddsa-jcs-2022** as the default cryptosuite
- Witness model: No witnesses for `did:peer`, optional HTTP witnesses for `did:webvh`, Bitcoin timestamp witnesses for `did:btco`
- Full integration with the existing Explorer application
- Ship CLI tools for creating, verifying, and migrating CEL-based assets
- Deliver React hooks for Explorer integration
- **Zero protocol invention** — 100% derived from Originals whitepaper + CEL spec

## User Stories

### US-001: Define Originals CEL Application Specification
**Description:** As a protocol implementer, I need a formal application specification document so that any implementation can interoperate.

**Acceptance Criteria:**
- [ ] Create `docs/ORIGINALS_CEL_SPEC.md` defining the Originals CEL Application Specification
- [ ] Document how cryptographic control is established (DID-based key authorization)
- [ ] Document how current asset state is derived from the event log
- [ ] Document witness validation rules per layer (none/HTTP/Bitcoin)
- [ ] Include JSON examples for each event type
- [ ] Typecheck passes

---

### US-002: Implement CEL Event Log Data Model
**Description:** As a developer, I need TypeScript types and classes representing the CEL data model so I can work with event logs programmatically.

**Acceptance Criteria:**
- [ ] Create `src/cel/types.ts` with interfaces: `EventLog`, `LogEntry`, `ExternalReference`, `EventWitness`
- [ ] `EventLog` contains `events: LogEntry[]` and optional `previousLog` reference
- [ ] `LogEntry` contains `type` ('create' | 'update' | 'deactivate'), `data`, `previousEvent`, `proof[]`
- [ ] `ExternalReference` contains `url[]`, `mediaType`, `digestMultibase` (required)
- [ ] Types align exactly with CEL spec Section 2 (Data Model)
- [ ] Typecheck passes

---

### US-003: Implement Create Event Algorithm
**Description:** As a developer, I need to create new event logs for assets so that I can establish cryptographic provenance from the first moment.

**Acceptance Criteria:**
- [ ] Create `src/cel/algorithms/createEvent.ts` implementing CEL Section 3.2 "Create Event"
- [ ] Function signature: `createEventLog(data: AssetData, options: CreateOptions): Promise<EventLog>`
- [ ] First event has `type: 'create'` and no `previousEvent`
- [ ] Proof is generated using eddsa-jcs-2022 by default
- [ ] Returns a valid `EventLog` with one entry
- [ ] Unit tests verify algorithm matches CEL spec
- [ ] Typecheck passes

---

### US-004: Implement Update Event Algorithm
**Description:** As a developer, I need to append update events to an existing log so that asset changes are recorded with full history.

**Acceptance Criteria:**
- [ ] Create `src/cel/algorithms/updateEvent.ts` implementing CEL Section 3.4 "Update Event Log"
- [ ] Function signature: `updateEventLog(log: EventLog, update: UpdateData, options: UpdateOptions): Promise<EventLog>`
- [ ] New event has `type: 'update'` and `previousEvent` referencing prior event's digest
- [ ] Proof is generated and appended
- [ ] Original log is not mutated (returns new log)
- [ ] Unit tests verify hash chain integrity
- [ ] Typecheck passes

---

### US-005: Implement Deactivate Event Algorithm
**Description:** As a developer, I need to deactivate event logs when assets are burned or permanently transferred so the log is properly closed.

**Acceptance Criteria:**
- [ ] Create `src/cel/algorithms/deactivateEvent.ts` implementing CEL Section 3.5 "Deactivate Event Log"
- [ ] Function signature: `deactivateEventLog(log: EventLog, reason: string, options: DeactivateOptions): Promise<EventLog>`
- [ ] Final event has `type: 'deactivate'`
- [ ] No further updates are valid after deactivation
- [ ] Unit tests verify deactivation seals the log
- [ ] Typecheck passes

---

### US-006: Implement Verify Event Log Algorithm
**Description:** As a verifier, I need to cryptographically verify an entire event log so I can trust its integrity.

**Acceptance Criteria:**
- [ ] Create `src/cel/algorithms/verifyEventLog.ts` implementing CEL Section 3.6 "Verify Event Log"
- [ ] Function signature: `verifyEventLog(log: EventLog, options: VerifyOptions): Promise<VerificationResult>`
- [ ] Verifies each event's proof using the specified cryptosuite
- [ ] Verifies hash chain (`previousEvent` references are correct)
- [ ] Verifies witness proofs if present
- [ ] Returns `{ verified: boolean, errors: string[], events: EventVerification[] }`
- [ ] Unit tests cover valid logs, tampered logs, and broken chains
- [ ] Typecheck passes

---

### US-007: Implement Witness Event Algorithm
**Description:** As a developer, I need to add witness proofs to events so third parties can attest to event timing.

**Acceptance Criteria:**
- [ ] Create `src/cel/algorithms/witnessEvent.ts` implementing CEL Section 3.3 "Witness Event"
- [ ] Function signature: `witnessEvent(event: LogEntry, witness: WitnessService): Promise<LogEntry>`
- [ ] Witness proof is appended to the event's `proof` array (not replacing controller proof)
- [ ] Supports pluggable witness services via interface
- [ ] Unit tests verify multi-proof structure
- [ ] Typecheck passes

---

### US-008: Implement HTTP Witness Service (did:webvh layer)
**Description:** As a developer using did:webvh, I need an HTTP witness service integration so events can be timestamped by trusted servers.

**Acceptance Criteria:**
- [ ] Create `src/cel/witnesses/HttpWitness.ts` implementing `WitnessService` interface
- [ ] Sends `digestMultibase` to configured witness endpoint
- [ ] Receives and validates witness proof response
- [ ] Configurable witness URLs (e.g., `["https://witness1.example.com", "https://witness2.example.com"]`)
- [ ] Graceful handling of witness unavailability
- [ ] Integration test with mock witness server
- [ ] Typecheck passes

---

### US-009: Implement Bitcoin Witness Service (did:btco layer)
**Description:** As a developer using did:btco, I need Bitcoin-based witnessing so events are anchored to Bitcoin's blockchain.

**Acceptance Criteria:**
- [ ] Create `src/cel/witnesses/BitcoinWitness.ts` implementing `WitnessService` interface
- [ ] Integrates with existing `BitcoinManager` for inscription
- [ ] Witness proof includes Bitcoin transaction ID and block height
- [ ] Proof format compatible with OpenTimestamps-style verification
- [ ] Uses the satoshi ordinal as the witness anchor
- [ ] Integration test with mock Bitcoin provider
- [ ] Typecheck passes

---

### US-010: Implement External Reference Handler
**Description:** As a developer, I need to handle external resource references so large assets aren't embedded in the log.

**Acceptance Criteria:**
- [ ] Create `src/cel/ExternalReferenceManager.ts`
- [ ] Function `createExternalReference(content: Buffer, options: RefOptions): ExternalReference`
- [ ] Computes `digestMultibase` as Multibase-encoded (base64url-nopad) Multihash (sha2-256)
- [ ] Stores content at provided URLs or returns upload instructions
- [ ] Function `resolveExternalReference(ref: ExternalReference): Promise<Buffer>`
- [ ] Verifies content hash matches `digestMultibase` on retrieval
- [ ] Unit tests verify hash computation matches CEL spec
- [ ] Typecheck passes

---

### US-011: Implement did:peer CEL Integration
**Description:** As a creator, I need to create CEL-based assets in did:peer layer so I can experiment offline at zero cost.

**Acceptance Criteria:**
- [ ] Create `src/cel/layers/PeerCelManager.ts`
- [ ] Creates self-contained event logs with did:peer DIDs
- [ ] No witness requirement (witnesses array empty)
- [ ] Exports log as JSON or CBOR
- [ ] Verification is fully offline
- [ ] Integration test: create → update → verify cycle
- [ ] Typecheck passes

---

### US-012: Implement did:webvh CEL Integration
**Description:** As a creator, I need to publish CEL-based assets to did:webvh so they become discoverable on the web.

**Acceptance Criteria:**
- [ ] Create `src/cel/layers/WebVHCelManager.ts`
- [ ] Migrates did:peer log to did:webvh with migration event
- [ ] Supports optional HTTP witnesses
- [ ] Publishes log to `/{userSlug}/cel/{assetId}.jsonl` endpoint
- [ ] DID document references the CEL log URL
- [ ] Integration test: peer → webvh migration with witness
- [ ] Typecheck passes

---

### US-013: Implement did:btco CEL Integration
**Description:** As a creator, I need to inscribe CEL-based assets on Bitcoin so ownership becomes transferable.

**Acceptance Criteria:**
- [ ] Create `src/cel/layers/BtcoCelManager.ts`
- [ ] Migrates did:webvh log to did:btco with migration event
- [ ] Bitcoin witness is required (inscription provides timestamp)
- [ ] Current state hash inscribed on unique satoshi
- [ ] Log remains resolvable from web; Bitcoin provides ownership anchor
- [ ] Integration test: webvh → btco migration
- [ ] Typecheck passes

---

### US-014: Create Originals CEL SDK Entry Point
**Description:** As a developer, I need a unified SDK entry point so I can easily work with CEL-based Originals.

**Acceptance Criteria:**
- [ ] Create `src/cel/OriginalsCel.ts` as main entry class
- [ ] Constructor accepts config: `{ layer: 'peer' | 'webvh' | 'btco', signer, witnesses? }`
- [ ] Methods: `create()`, `update()`, `deactivate()`, `verify()`, `migrate()`, `getLog()`, `getCurrentState()`
- [ ] Delegates to appropriate layer manager based on config
- [ ] Full JSDoc documentation
- [ ] Typecheck passes

---

### US-015: Implement CEL Serialization (JSON and CBOR)
**Description:** As a developer, I need to serialize event logs in both JSON and CBOR formats as specified by CEL.

**Acceptance Criteria:**
- [ ] Create `src/cel/serialization/json.ts` for JSON serialization
- [ ] Create `src/cel/serialization/cbor.ts` for CBOR serialization (using existing cbor-js dependency)
- [ ] JSON is default; CBOR provides ~50% size reduction as noted in CEL spec
- [ ] Round-trip tests: serialize → deserialize → verify equality
- [ ] Typecheck passes

---

### US-016: Implement CLI Tool - Create Asset
**Description:** As a user, I want a CLI command to create a new CEL-based Original so I can work without a GUI.

**Acceptance Criteria:**
- [ ] Create `src/cel/cli/create.ts` command
- [ ] Usage: `originals-cel create --name "My Asset" --file ./content.png --layer peer`
- [ ] Outputs event log to stdout or specified file
- [ ] Supports `--output json|cbor` format flag
- [ ] Generates new key pair if none provided
- [ ] Clear error messages for invalid input
- [ ] Typecheck passes

---

### US-017: Implement CLI Tool - Verify Log
**Description:** As a user, I want a CLI command to verify a CEL event log so I can audit any asset's provenance.

**Acceptance Criteria:**
- [ ] Create `src/cel/cli/verify.ts` command
- [ ] Usage: `originals-cel verify --log ./asset.cel.json`
- [ ] Outputs verification result with event-by-event breakdown
- [ ] Shows witness attestations if present
- [ ] Exit code 0 on success, 1 on failure
- [ ] Clear error messages showing which event/proof failed
- [ ] Typecheck passes

---

### US-018: Implement CLI Tool - Migrate Asset
**Description:** As a user, I want a CLI command to migrate assets between layers so I can upgrade provenance as needed.

**Acceptance Criteria:**
- [ ] Create `src/cel/cli/migrate.ts` command
- [ ] Usage: `originals-cel migrate --log ./asset.cel.json --to webvh --domain example.com`
- [ ] Adds migration event to log
- [ ] For webvh: publishes to web endpoint
- [ ] For btco: creates Bitcoin transaction (requires wallet)
- [ ] Outputs updated log
- [ ] Typecheck passes

---

### US-019: Implement CLI Tool - Inspect Log
**Description:** As a user, I want a CLI command to inspect a CEL event log in human-readable format.

**Acceptance Criteria:**
- [ ] Create `src/cel/cli/inspect.ts` command
- [ ] Usage: `originals-cel inspect --log ./asset.cel.json`
- [ ] Pretty-prints event timeline with timestamps
- [ ] Shows current state derived from events
- [ ] Lists all witnesses and their attestation times
- [ ] Shows layer history (peer → webvh → btco)
- [ ] Typecheck passes

---

### US-020: Create CLI Entry Point and Help
**Description:** As a user, I need a unified CLI entry point with help documentation.

**Acceptance Criteria:**
- [ ] Create `src/cel/cli/index.ts` as CLI entry
- [ ] Add bin entry to package.json: `"originals-cel": "./dist/cel/cli/index.js"`
- [ ] Subcommands: `create`, `verify`, `migrate`, `inspect`, `witness`
- [ ] `--help` shows usage for all commands
- [ ] `--version` shows package version
- [ ] Typecheck passes

---

### US-021: React Hook - useOriginalsCel
**Description:** As a frontend developer, I need React hooks to work with CEL-based Originals in the Explorer.

**Acceptance Criteria:**
- [ ] Create `src/cel/react/useOriginalsCel.ts`
- [ ] Hook returns: `{ create, update, verify, migrate, isLoading, error }`
- [ ] Integrates with TurnkeySessionContext for signing
- [ ] Handles async operations with proper loading states
- [ ] Uses React Query for caching
- [ ] Typecheck passes

---

### US-022: React Hook - useCelEventLog
**Description:** As a frontend developer, I need to fetch and display CEL event logs for assets.

**Acceptance Criteria:**
- [ ] Create `src/cel/react/useCelEventLog.ts`
- [ ] Hook signature: `useCelEventLog(assetId: string)`
- [ ] Returns: `{ log, events, currentState, isLoading, error, refetch }`
- [ ] Fetches log from appropriate endpoint based on layer
- [ ] Automatically verifies log on fetch
- [ ] Typecheck passes

---

### US-023: Explorer Integration - CEL Event Timeline Component
**Description:** As an Explorer user, I want to see the CEL event timeline for any asset so I can understand its full history.

**Acceptance Criteria:**
- [ ] Create `explorer/src/components/cel/CelEventTimeline.tsx`
- [ ] Displays chronological list of events (create, updates, migrations, deactivation)
- [ ] Each event shows: type, timestamp, data summary, proof status, witnesses
- [ ] Expandable event details showing full data
- [ ] Visual indicators for verified vs unverified events
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### US-024: Explorer Integration - CEL Verification Badge
**Description:** As an Explorer user, I want to see a verification badge on assets so I know their CEL log is valid.

**Acceptance Criteria:**
- [ ] Create `explorer/src/components/cel/CelVerificationBadge.tsx`
- [ ] Shows green checkmark when fully verified
- [ ] Shows warning icon if any verification issues
- [ ] Tooltip shows verification details (events verified, witness count)
- [ ] Click opens full verification report modal
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### US-025: Explorer Integration - Asset Detail CEL Tab
**Description:** As an Explorer user, I want a dedicated CEL tab on asset detail pages showing provenance data.

**Acceptance Criteria:**
- [ ] Add "Provenance" tab to `explorer/src/pages/original-detail.tsx`
- [ ] Tab contains: CelEventTimeline, current state viewer, witness list
- [ ] Shows raw CEL log with copy/download buttons
- [ ] Links to witnesses (HTTP URLs or Bitcoin explorer for btco)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### US-026: Explorer Integration - Create Original with CEL
**Description:** As an Explorer user, I want to create new Originals using the CEL format through the existing UI.

**Acceptance Criteria:**
- [ ] Modify `explorer/src/pages/create-original-simple.tsx` to use CEL backend
- [ ] Creation flow: upload content → sign → generate CEL log → store
- [ ] Event log is persisted with asset record
- [ ] Shows CEL verification badge on success
- [ ] Backwards compatible with existing non-CEL assets
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### US-027: Explorer Integration - Migrate with CEL
**Description:** As an Explorer user, I want to migrate assets between layers and see the migration recorded in the CEL log.

**Acceptance Criteria:**
- [ ] Modify `explorer/src/pages/migrate-original-simple.tsx` to use CEL backend
- [ ] Migration adds proper `update` event with migration metadata
- [ ] For webvh: shows witness options
- [ ] For btco: integrates with existing Bitcoin flow
- [ ] CEL log updated and re-published at new layer
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### US-028: Server API - CEL Log Endpoints
**Description:** As a developer, I need server endpoints to store and retrieve CEL logs.

**Acceptance Criteria:**
- [ ] Add `POST /api/originals/:id/cel` to create/update CEL log
- [ ] Add `GET /api/originals/:id/cel` to retrieve CEL log (JSON)
- [ ] Add `GET /api/originals/:id/cel.cbor` for CBOR format
- [ ] Add `POST /api/originals/:id/cel/verify` to verify and return result
- [ ] Authentication required for write operations
- [ ] Typecheck passes

---

### US-029: Server API - Witness Endpoint
**Description:** As a witness service operator, I need an endpoint that can witness CEL events.

**Acceptance Criteria:**
- [ ] Add `POST /api/witness` endpoint
- [ ] Accepts `digestMultibase` in request body
- [ ] Returns signed witness proof
- [ ] Uses server's Ed25519 key for signing
- [ ] Rate limiting to prevent abuse
- [ ] Optional: require authentication
- [ ] Typecheck passes

---

### US-030: Database Schema - CEL Storage
**Description:** As a developer, I need database columns to store CEL logs alongside existing Original records.

**Acceptance Criteria:**
- [ ] Add `cel_log` JSONB column to originals table (nullable for backwards compat)
- [ ] Add `cel_version` integer column for format versioning
- [ ] Add `cel_verified_at` timestamp column for caching verification
- [ ] Create migration file
- [ ] Update storage layer types
- [ ] Typecheck passes

---

### US-031: Integration Tests - Full Lifecycle
**Description:** As a developer, I need comprehensive integration tests covering the full CEL lifecycle.

**Acceptance Criteria:**
- [ ] Test: Create peer asset → update → verify
- [ ] Test: Migrate peer → webvh with HTTP witness
- [ ] Test: Migrate webvh → btco with Bitcoin witness
- [ ] Test: Verify full chain from btco back to peer origin
- [ ] Test: Deactivate and verify sealed log
- [ ] Test: Tampered log detection
- [ ] All tests pass

---

### US-032: Documentation - Developer Guide
**Description:** As a developer, I need comprehensive documentation to use the Originals CEL SDK.

**Acceptance Criteria:**
- [ ] Create `docs/ORIGINALS_CEL_GUIDE.md`
- [ ] Sections: Quick Start, Core Concepts, API Reference, CLI Usage, Explorer Integration
- [ ] Include code examples for each major use case
- [ ] Explain layer model and migration
- [ ] Document witness configuration
- [ ] Link to CEL spec and Originals whitepaper

---

## Functional Requirements

### Core CEL Implementation
- **FR-1:** The system MUST implement the CEL data model as specified in W3C CCG CEL v0.1
- **FR-2:** Event logs MUST be hash-chained using `previousEvent` references
- **FR-3:** All events MUST include at least one Data Integrity Proof (controller proof)
- **FR-4:** The default cryptosuite MUST be `eddsa-jcs-2022` (Ed25519)
- **FR-5:** External references MUST use Multibase-encoded Multihash (sha2-256) for `digestMultibase`

### Layer Integration
- **FR-6:** `did:peer` assets MUST NOT require witnesses
- **FR-7:** `did:webvh` assets MAY include HTTP witness proofs
- **FR-8:** `did:btco` assets MUST include Bitcoin-based witness proof (inscription transaction)
- **FR-9:** Migration events MUST record source layer, target layer, and migration timestamp
- **FR-10:** Each layer MUST be able to resolve and verify logs from lower layers

### Verification
- **FR-11:** `verifyEventLog` MUST check all controller proofs in the log
- **FR-12:** `verifyEventLog` MUST validate hash chain integrity
- **FR-13:** `verifyEventLog` MUST validate witness proofs when present
- **FR-14:** Verification MUST fail if any event proof is invalid
- **FR-15:** Verification MUST fail if hash chain is broken

### Serialization
- **FR-16:** JSON MUST be the default serialization format
- **FR-17:** CBOR MUST be supported as an alternative compact format
- **FR-18:** Serialization/deserialization MUST be lossless

### CLI
- **FR-19:** CLI MUST support `create`, `verify`, `migrate`, `inspect` commands
- **FR-20:** CLI MUST exit with code 0 on success, 1 on failure
- **FR-21:** CLI MUST provide clear error messages

### Explorer Integration
- **FR-22:** Explorer MUST display CEL event timeline for CEL-enabled assets
- **FR-23:** Explorer MUST show verification status via badge
- **FR-24:** Explorer MUST allow creating new assets with CEL format
- **FR-25:** Explorer MUST support migration with CEL logging

### API
- **FR-26:** Server MUST provide endpoints to store and retrieve CEL logs
- **FR-27:** Server MAY provide a witness endpoint for HTTP witnessing
- **FR-28:** Write operations MUST require authentication

## Non-Goals

- **Not implementing a new specification** — We strictly implement CEL + Originals
- **Not creating a blockchain** — Bitcoin is the only settlement layer
- **Not building a witness network** — Individual witnesses are pluggable
- **Not supporting non-Ed25519 keys in v1** — Other key types may be added later
- **Not migrating existing non-CEL assets automatically** — Opt-in migration only
- **Not implementing CEL Macros** — Standard event types only
- **Not building mobile apps** — Web and CLI only
- **Not implementing real-time sync** — Fetch-based model only

## Technical Considerations

### Existing SDK Integration
- Reuse `@originals/sdk` cryptographic primitives (`@noble/ed25519`, `@noble/hashes`)
- Reuse existing `DIDManager`, `BitcoinManager`, `WebVHManager`
- CEL module lives under `src/cel/` to keep it organized
- Export from main `index.ts` as `export * from './cel'`

### Dependencies
- No new dependencies for core CEL (use existing `@noble/*`, `cbor-js`)
- CLI uses existing patterns (no additional CLI framework needed)
- React hooks use existing `@tanstack/react-query`

### Performance
- Event log verification should complete in <100ms for typical logs (<50 events)
- CBOR serialization for bandwidth-sensitive applications
- Verification results can be cached with `cel_verified_at` timestamp

### Security
- All signing operations use existing Turnkey integration in Explorer
- Witness proofs are additive (never replace controller proof)
- Deactivated logs cannot accept new events

### Backwards Compatibility
- Existing assets continue to work without CEL
- CEL log is optional (`cel_log` column nullable)
- API endpoints are additive (no breaking changes)

## Design Considerations

### File Structure
```
sdk/packages/sdk/src/cel/
├── types.ts                    # CEL data model types
├── OriginalsCel.ts            # Main SDK entry point
├── ExternalReferenceManager.ts
├── algorithms/
│   ├── createEvent.ts
│   ├── updateEvent.ts
│   ├── deactivateEvent.ts
│   ├── verifyEventLog.ts
│   └── witnessEvent.ts
├── witnesses/
│   ├── WitnessService.ts      # Interface
│   ├── HttpWitness.ts
│   └── BitcoinWitness.ts
├── layers/
│   ├── PeerCelManager.ts
│   ├── WebVHCelManager.ts
│   └── BtcoCelManager.ts
├── serialization/
│   ├── json.ts
│   └── cbor.ts
├── cli/
│   ├── index.ts
│   ├── create.ts
│   ├── verify.ts
│   ├── migrate.ts
│   └── inspect.ts
└── react/
    ├── useOriginalsCel.ts
    └── useCelEventLog.ts

explorer/src/components/cel/
├── CelEventTimeline.tsx
├── CelVerificationBadge.tsx
└── CelLogViewer.tsx
```

### Event Log Example (JSON)
```json
{
  "events": [
    {
      "type": "create",
      "data": {
        "id": "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
        "name": "My Digital Art",
        "resources": [{
          "url": ["https://example.com/art.png"],
          "mediaType": "image/png",
          "digestMultibase": "uEiC..."
        }],
        "creator": "did:webvh:example.com:alice",
        "createdAt": "2025-01-20T00:00:00Z"
      },
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "verificationMethod": "did:peer:2.Ez6LS...#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z..."
      }]
    },
    {
      "type": "update",
      "previousEvent": "uEiC...",
      "data": {
        "layer": "webvh",
        "newDid": "did:webvh:example.com:alice:art-001",
        "migratedAt": "2025-01-21T00:00:00Z"
      },
      "proof": [
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:webvh:example.com:alice#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z..."
        },
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:key:z6Mkw...",
          "proofPurpose": "assertionMethod",
          "proofValue": "z...",
          "witnessedAt": "2025-01-21T00:00:05Z"
        }
      ]
    }
  ]
}
```

## Success Metrics

- **Spec Compliance:** 100% alignment with CEL v0.1 data model and algorithms
- **Test Coverage:** >90% code coverage for CEL module
- **Performance:** Event log verification <100ms for logs with <50 events
- **Integration:** Explorer can create, display, and migrate CEL-based assets
- **Interoperability:** CEL logs exported from SDK can be verified by any CEL-compliant verifier
- **Zero Invention:** No protocol logic invented; 100% derived from existing specs

## Open Questions

1. **Witness Discovery:** Should we implement witness discovery via DID service endpoints, or require explicit configuration?

2. **Log Chunking:** The CEL spec supports `previousLog` for chunking long histories. At what event count should we start a new log file?

3. **Selective Disclosure:** Should we support BBS+ signatures for selective disclosure in future versions?

4. **CBOR Default:** Should CBOR become the default for did:btco to minimize inscription size?

5. **Witness Threshold:** For did:webvh, should we require a minimum number of witnesses, or is one sufficient?

6. **Migration Reversibility:** Can a did:btco asset ever migrate "down" to did:webvh (e.g., for burning)?

## References

- [W3C CCG CEL Specification v0.1](https://w3c-ccg.github.io/cel-spec/)
- [Originals Protocol Whitepaper](../originals-whitepaper.md)
- [Originals SDK](../packages/sdk/)
- [Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/)
- [did:webvh Specification](https://identity.foundation/didwebvh/)
- [Ordinals Protocol](https://docs.ordinals.com/)
