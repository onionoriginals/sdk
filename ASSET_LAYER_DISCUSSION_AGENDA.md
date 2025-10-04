# Asset Layer Discussion Agenda

## Overview
This document outlines key discussion topics, potential improvements, and open questions related to the asset layer of the Originals SDK.

---

## 1. Core Architecture Review

### Current Implementation Strengths
- ✅ Clean separation of concerns (Asset, Lifecycle, Managers)
- ✅ Unidirectional layer migration model
- ✅ Comprehensive provenance tracking
- ✅ Content integrity via SHA-256 hashing
- ✅ Multi-level verification system
- ✅ Pluggable adapter architecture
- ✅ W3C DID and VC compliance

### Discussion Points

#### 1.1 Layer Model Design
**Question:** Is the three-layer model (peer → webvh → btco) optimal, or should we consider additional layers?

**Considerations:**
- Could there be a "draft" layer before `did:peer` for unfinished work?
- Should there be a "testnet" variant for each layer?
- Would a "did:ipfs" layer fit between webvh and btco?
- Is the direct peer → btco migration path valuable or confusing?

**Impact:** High - affects fundamental SDK architecture

#### 1.2 Migration Path Constraints
**Question:** Should migration paths have additional constraints (time locks, approvals, etc.)?

**Current behavior:**
- Migrations are immediate and irreversible
- No minimum duration at any layer
- No approval process

**Potential additions:**
- Minimum time at each layer (e.g., 24 hours at webvh before btco)
- Multi-sig approval for btco migrations
- Cooldown periods between migrations
- Migration cost estimation before execution

**Impact:** Medium - affects developer experience and use cases

---

## 2. Resource Management

### Current Implementation
- Resources are immutable once added to an asset
- Content identified by SHA-256 hash
- Optional inline content or URL references
- All resources migrated together as a bundle

### Discussion Points

#### 2.1 Resource Updates
**Question:** How should resource updates be handled at different layers?

**Current limitation:** No update mechanism - resources are immutable

**Possible approaches:**
1. **Version Chain:** New asset version with updated resources, linked to previous
2. **Resource Versioning:** Individual resource versions within asset
3. **Credential-based Updates:** Update credentials that reference new resource hashes
4. **Layer-specific Rules:** Updates allowed in peer, locked in webvh/btco

**Trade-offs:**
- Simplicity vs flexibility
- Immutability guarantees vs practical needs
- Storage overhead vs historical tracking

**Impact:** High - affects many use cases (software, documents, evolving art)

#### 2.2 Lazy Resource Loading
**Question:** Should resources support lazy loading for large collections?

**Current behavior:** All resources loaded when asset is created

**Potential scenarios:**
- Asset with 1000+ resources (e.g., dataset, photo album)
- Resources with large file sizes (videos, high-res images)
- Bandwidth-constrained environments

**Possible solutions:**
- Pagination in resource list
- Resource loading on-demand
- Resource manifests with content-addressed references
- Separate "asset bundle" and "asset metadata" concepts

**Impact:** Medium - affects scalability and performance

#### 2.3 Resource Type System
**Question:** Should there be a formal type system for resources?

**Current state:** `type` is free-form string ('image', 'text', 'data', etc.)

**Possible enhancements:**
- Enum of standard types with validation
- Hierarchical type system (e.g., 'image/raster', 'image/vector')
- Schema validation per type
- Type-specific metadata fields
- Content-type consistency validation

**Impact:** Low-Medium - improves developer experience but not strictly necessary

---

## 3. Provenance and Verification

### Current Implementation
- Append-only provenance chain
- Migration and transfer tracking
- Multi-level verification (structural, content, cryptographic)

### Discussion Points

#### 3.1 Provenance Queries
**Question:** Should there be query APIs for provenance history?

**Current limitation:** Full provenance returned, no filtering

**Potential queries:**
- Get migrations only
- Get transfers only
- Filter by date range
- Search by transaction ID
- Find migration to specific layer
- Get transfer to/from specific address

**Considerations:**
- In-memory filtering vs dedicated query methods
- Performance with large provenance chains
- Query language/pattern (builder pattern, filter objects, etc.)

**Impact:** Low - nice to have but not critical

#### 3.2 Provenance Attestations
**Question:** Should third parties be able to add attestations to provenance?

**Current limitation:** Only asset creator/owner can update provenance

**Use cases:**
- Museum/gallery exhibition records
- Ownership disputes and resolutions
- Authentication certificates
- Historical significance markers
- Conservation/restoration records

**Possible approach:**
- Add `attestations` array to provenance
- Each attestation signed by third party
- Includes: attestor DID, timestamp, type, claim, proof

**Impact:** Medium - valuable for art/collectibles but adds complexity

#### 3.3 Provenance Privacy
**Question:** Should provenance support private/confidential entries?

**Current state:** All provenance is transparent

**Scenarios requiring privacy:**
- Private sales (hide buyer/seller addresses)
- Confidential ownership transfers
- Trade secrets in supply chain
- Personal data in healthcare records

**Approaches:**
- Encrypted provenance entries (with selective disclosure)
- Private vs public provenance chains
- Zero-knowledge proofs for ownership
- Credential-based access control

**Impact:** High - significant architectural change, but valuable for enterprise

---

## 4. Lifecycle Operations

### Current Implementation
- Create asset (did:peer)
- Publish to web (did:webvh)
- Inscribe on Bitcoin (did:btco)
- Transfer ownership (btco only)

### Discussion Points

#### 4.1 Batch Operations
**Question:** Should there be batch operation support?

**Current limitation:** One asset at a time

**Potential batch operations:**
- Batch create (multiple assets from resources list)
- Batch publish (multiple assets to same domain)
- Batch inscribe (multiple assets in single transaction)
- Batch transfer (multiple assets to same recipient)

**Benefits:**
- Cost savings (single Bitcoin transaction for multiple inscriptions)
- Efficiency (reduced API calls)
- Atomic operations (all succeed or all fail)

**Challenges:**
- Error handling (partial failures)
- Provenance tracking (batch ID?)
- Fee calculation (splitting costs)

**Impact:** Medium-High - significant value for power users

#### 4.2 Conditional Operations
**Question:** Should operations support conditions or pre-flight checks?

**Examples:**
- "Publish only if storage cost < $X"
- "Inscribe only if fee rate < Y sat/vB"
- "Transfer only if buyer signs acceptance"
- "Migrate only if all resources verified"

**Current state:** No conditional logic, operations execute immediately

**Possible implementation:**
- Pre-flight validation methods
- Dry-run mode for cost estimation
- Conditional execution guards
- Transaction proposal system

**Impact:** Medium - improves reliability and user control

#### 4.3 Rollback/Undo
**Question:** Can/should any operations be reversible?

**Current state:** All operations are irreversible

**Analysis by layer:**
- `did:peer`: Could be "deleted" (no public record)
- `did:webvh`: Could be "unpublished" (remove from hosting)
- `did:btco`: Immutable on blockchain, cannot be undone

**Considerations:**
- Architectural principle: provenance is append-only
- Practical need: mistakes happen (wrong domain, wrong fee rate)
- Solution options:
  - "Revocation" credentials (mark as superseded)
  - State flags (active/revoked)
  - New asset versions with link to previous

**Impact:** High - philosophical and architectural decision

---

## 5. Integration and Extensibility

### Current Implementation
- Pluggable adapters (storage, fee oracle, ordinals provider)
- External signer support
- KeyStore interface for key management

### Discussion Points

#### 5.1 Event System
**Question:** Should asset layer emit events for monitoring and integration?

**Current limitation:** No event system, no lifecycle hooks

**Potential events:**
- `asset.created`
- `asset.migrated` (with layer details)
- `asset.transferred`
- `resource.published`
- `credential.issued`
- `verification.completed`

**Use cases:**
- Analytics and monitoring
- Integration with external systems
- Automated workflows
- Audit logging
- User notifications

**Implementation options:**
- Observer pattern
- Event emitter (Node.js style)
- Webhook support
- Message queue integration

**Impact:** Medium - valuable for production deployments

#### 5.2 Plugin System
**Question:** Should there be a formal plugin system for asset layer?

**Potential plugins:**
- Custom verification rules
- Additional credential types
- Resource transformers (resize images, compress, etc.)
- Metadata extractors
- Custom layer implementations
- Royalty/licensing enforcement

**Current state:** Some extensibility via adapters, but not formalized

**Considerations:**
- Plugin discovery and registration
- Lifecycle hooks for plugins
- Plugin isolation and security
- Plugin versioning and compatibility

**Impact:** Medium - enables ecosystem growth but adds complexity

#### 5.3 Multi-chain Support
**Question:** Should asset layer support blockchains beyond Bitcoin?

**Current state:** Bitcoin-only via OrdinalsProvider

**Potential additions:**
- Ethereum (ERC-721, ERC-1155)
- Polygon, Arbitrum, etc.
- Solana
- Stacks (built on Bitcoin)
- Other EVM chains

**Considerations:**
- New layer types or adapt did:btco?
- Cross-chain provenance tracking
- Chain-specific migration paths
- Fee estimation differences
- Smart contract integration

**Impact:** High - significant architectural changes, but valuable for wider adoption

---

## 6. Security and Trust

### Current Implementation
- SHA-256 content hashing
- Ed25519/ES256K signatures
- W3C VC standard compliance
- DID-based identity

### Discussion Points

#### 6.1 Front-running Protection
**Question:** Are current front-running protections sufficient?

**Current mechanism:** Unique satoshi assignment in btco layer

**Potential threats:**
- MEV-style attacks (miner/validator manipulation)
- Transaction mempool monitoring
- Inscription racing conditions
- Price manipulation during minting

**Additional protections:**
- Commit-reveal schemes (already used for inscriptions)
- Time-locked inscriptions
- Randomized inscription ordering
- Pre-registration system

**Impact:** High - critical for valuable assets

#### 6.2 Fake Asset Detection
**Question:** How can users verify asset authenticity?

**Current tools:**
- DID resolution
- Credential verification
- Content hash validation
- Provenance inspection

**Challenges:**
- Impersonation (fake DIDs, domains)
- Copied content with valid hashes
- Stolen private keys
- Social engineering

**Potential solutions:**
- Web of trust / reputation system
- Creator verification service
- Domain ownership proofs
- Historical provenance analysis
- Community reporting

**Impact:** High - affects trust in the system

#### 6.3 Key Compromise
**Question:** What happens if private key is compromised?

**Current state:** No key rotation or revocation mechanism

**Scenarios:**
- Private key stolen
- KeyStore breach
- Lost access to signing key

**Possible mitigations:**
- Key rotation via DID updates (did:webvh supports this)
- Emergency revocation credentials
- Multi-sig requirements for sensitive operations
- Time-limited credentials
- Recovery mechanisms (social recovery, guardians)

**Impact:** High - critical for long-term asset security

---

## 7. Developer Experience

### Current Implementation
- TypeScript SDK with strong typing
- Clear error messages
- Comprehensive tests
- Documentation

### Discussion Points

#### 7.1 Validation and Feedback
**Question:** Can validation and error messages be improved?

**Current state:** Validation on input, errors thrown

**Potential improvements:**
- Dry-run/validation mode (check without executing)
- Detailed validation reports (all errors, not just first)
- Warning system (non-blocking issues)
- Cost estimation before operations
- Time estimation for long operations

**Impact:** Low-Medium - quality of life improvement

#### 7.2 Convenience Methods
**Question:** Should there be higher-level convenience methods?

**Examples:**
- `createAndPublishAsset(resources, domain)` - combines create + publish
- `publishAndInscribe(asset, domain, feeRate)` - combines publish + inscribe
- `createFromDirectory(path)` - auto-discover resources
- `createFromMetadata(json)` - parse standard metadata format
- `exportAsset(asset, format)` - export to various formats

**Trade-offs:**
- Convenience vs API surface complexity
- Flexibility vs simplicity
- Learning curve

**Impact:** Low - nice to have but not essential

#### 7.3 CLI Tool
**Question:** Should there be an official CLI for asset operations?

**Current state:** SDK only, no CLI

**Potential commands:**
```bash
originals create ./resources --output asset.json
originals publish asset.json --domain example.com
originals inscribe asset.json --fee-rate 10
originals transfer asset.json --to bc1q...
originals verify asset.json
originals inspect asset.json
```

**Benefits:**
- Easier testing and experimentation
- Scripting and automation
- CI/CD integration
- Quick verification

**Impact:** Medium - valuable for adoption but requires maintenance

---

## 8. Scalability and Performance

### Current Implementation
- Synchronous operations
- In-memory provenance
- Single asset operations

### Discussion Points

#### 8.1 Streaming and Large Assets
**Question:** How should the SDK handle very large assets?

**Current limitations:**
- Resources loaded entirely into memory
- No streaming support
- Synchronous verification

**Scenarios:**
- 4K/8K video files
- Large datasets (GBs)
- Collections with thousands of items
- High-resolution 3D models

**Possible solutions:**
- Streaming APIs for resources
- Chunked uploads to storage
- Progressive verification
- Resource manifests (metadata without content)

**Impact:** Medium - important for specific use cases

#### 8.2 Concurrent Operations
**Question:** Should asset operations support concurrency?

**Current state:** One operation at a time per asset

**Potential needs:**
- Parallel resource uploads during publish
- Concurrent verification of multiple assets
- Batch processing
- Background operations

**Considerations:**
- Thread safety
- Transaction isolation
- Error handling in concurrent context

**Impact:** Low-Medium - optimization, not critical

#### 8.3 Caching Strategy
**Question:** Should there be caching for expensive operations?

**Potentially cacheable:**
- DID resolution results
- Credential verification results
- Resource hash calculations
- Fee rate estimations
- Provenance queries

**Considerations:**
- Cache invalidation
- Time-to-live policies
- Memory usage
- Consistency vs performance

**Impact:** Low - optimization for production deployments

---

## 9. Standards and Interoperability

### Current Implementation
- W3C DID standard
- W3C Verifiable Credentials
- Bitcoin Ordinals
- SHA-256 hashing

### Discussion Points

#### 9.1 Metadata Standards
**Question:** Should there be a standard metadata format for assets?

**Current state:** No enforced metadata structure beyond AssetResource

**Potential standards:**
- Dublin Core (bibliographic metadata)
- IIIF (image interoperability)
- Schema.org (web metadata)
- EXIF (image metadata)
- ID3 (audio metadata)

**Benefits:**
- Interoperability with other systems
- Rich search and discovery
- Consistent tooling
- SEO benefits (for webvh)

**Impact:** Medium - improves discoverability and integration

#### 9.2 Import/Export Formats
**Question:** What formats should be supported for asset import/export?

**Possible formats:**
- JSON (current provenance format)
- JSON-LD (semantic web)
- RDF (linked data)
- NFT metadata standards (OpenSea, etc.)
- IPFS CID references
- Arweave transaction IDs

**Use cases:**
- Migration from other platforms
- Integration with NFT marketplaces
- Archival and backup
- Data portability

**Impact:** Medium - enables ecosystem integration

#### 9.3 Cross-SDK Compatibility
**Question:** Can assets created by one SDK be used by another?

**Current state:** SDK-specific, but DID/VC standards enable interop

**Considerations:**
- Reference implementation status
- Test vectors for validation
- Specification documentation
- Versioning and compatibility guarantees

**Impact:** High - critical for decentralization and avoiding lock-in

---

## 10. Business and Compliance

### Discussion Points

#### 10.1 Regulatory Compliance
**Question:** How does asset layer support compliance requirements?

**Potential requirements:**
- KYC/AML for transfers
- Export controls for certain content
- Copyright/IP verification
- GDPR right to be forgotten
- Tax reporting

**Current capabilities:**
- Provenance tracking (audit trail)
- DID-based identity
- Credential system (for attestations)

**Gaps:**
- No built-in KYC/AML
- No content filtering
- No privacy controls

**Impact:** High - required for regulated industries

#### 10.2 Royalties and Licensing
**Question:** Should asset layer support built-in royalty enforcement?

**Use cases:**
- Artist royalties on secondary sales
- Software licensing
- Content licensing
- Patent tracking

**Possible approaches:**
- Credentials with licensing terms
- Smart contract integration (for chains that support it)
- Off-chain enforcement with credentials
- Transfer hooks for royalty payments

**Challenges:**
- Enforcement across platforms
- Fair pricing mechanisms
- Dispute resolution
- Technical vs legal enforcement

**Impact:** High - important for creator economy

#### 10.3 Cost Analysis
**Question:** Can cost visibility and prediction be improved?

**Current state:** Costs are known post-operation

**Needed:**
- Pre-operation cost estimates
- Historical cost tracking
- Cost optimization suggestions
- Budget alerts

**Impact:** Medium - helps users make informed decisions

---

## Priority Matrix

| Topic | Priority | Effort | Value |
|-------|----------|--------|-------|
| Resource Updates | High | High | High |
| Batch Operations | High | Medium | High |
| Event System | Medium | Medium | High |
| Provenance Attestations | Medium | High | Medium |
| Multi-chain Support | High | Very High | Very High |
| Key Compromise Recovery | High | High | High |
| Fake Asset Detection | High | Medium | High |
| CLI Tool | Medium | Medium | Medium |
| Metadata Standards | Medium | Low | Medium |
| Regulatory Compliance | High | High | High |
| Resource Type System | Low | Low | Low |
| Lazy Resource Loading | Medium | Medium | Medium |
| Caching Strategy | Low | Low | Medium |

---

## Recommended Discussion Flow

### Session 1: Architecture (60 min)
1. Layer model review (15 min)
2. Resource management strategy (20 min)
3. Provenance and verification (15 min)
4. Q&A (10 min)

### Session 2: Features and Roadmap (60 min)
1. Batch operations (15 min)
2. Event system (10 min)
3. Multi-chain support (20 min)
4. Priority setting (15 min)

### Session 3: Security and Trust (45 min)
1. Front-running protection (10 min)
2. Key compromise scenarios (15 min)
3. Fake asset detection (10 min)
4. Compliance requirements (10 min)

### Session 4: Developer Experience (45 min)
1. API improvements (15 min)
2. CLI tool (10 min)
3. Documentation and examples (10 min)
4. Community feedback (10 min)

---

## Open Questions Summary

1. **Architecture**: Should we expand or constrain the layer model?
2. **Resources**: How to handle updates, versions, and large collections?
3. **Provenance**: What level of privacy and query capability is needed?
4. **Lifecycle**: Batch operations? Conditional execution? Rollback?
5. **Integration**: Event system? Plugin architecture? Multi-chain?
6. **Security**: Additional protections beyond current implementation?
7. **DX**: What conveniences would most improve developer experience?
8. **Standards**: Which standards should we adopt or define?
9. **Business**: How to support compliance and monetization?
10. **Roadmap**: What are the highest priority improvements?

---

## Next Steps

1. Review this document before discussion
2. Prioritize topics based on stakeholder needs
3. Schedule focused sessions for high-priority areas
4. Document decisions and create tracking issues
5. Build consensus on roadmap
6. Update architecture docs with decisions

---

## Additional Resources

- Main discussion document: `ASSET_LAYER_DISCUSSION.md`
- Architecture diagrams: `ASSET_LAYER_ARCHITECTURE.md`
- Quick reference: `ASSET_LAYER_QUICK_REFERENCE.md`
- Implementation: `src/lifecycle/OriginalsAsset.ts`, `src/lifecycle/LifecycleManager.ts`
- Tests: `tests/integration/CompleteLifecycle.e2e.test.ts`
