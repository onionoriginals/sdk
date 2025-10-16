# PRD: Originals SDK Documentation Portal

**Status:** 🔴 P0 - Critical
**Timeline:** Phase 1 (MVP) Tonight, Phase 2-3 (Complete) 2 weeks
**Team:** 2 engineers
**Created:** October 16, 2025
**Platform:** GitBook hosted at docs.originals.build (Railway)

---

## Executive Summary

The Originals SDK enables blockchain developers to manage digital asset lifecycles with Bitcoin anchoring, but currently lacks comprehensive documentation. This creates a critical barrier to adoption: developers familiar with Bitcoin/Ordinals cannot quickly integrate the SDK because there's no clear getting-started path or API reference.

This PRD defines a complete documentation portal hosted on GitBook that will reduce time-to-first-integration from hours/days to under 30 minutes for experienced Ordinals developers.

**Why This Matters:**
- **Adoption blocker:** SDK has powerful capabilities but developers can't discover or use them
- **Support burden:** Lack of docs creates repetitive support questions
- **Market timing:** Ordinals ecosystem is growing - we need docs to capture mindshare
- **Developer experience:** Great docs = faster integrations = more users = network effects

---

## Goals

1. **Goal 1:** Reduce time-to-first-integration to <30 minutes for Ordinals developers
2. **Goal 2:** Achieve 100% API coverage with executable code examples
3. **Goal 3:** Eliminate common support questions through comprehensive troubleshooting guide
4. **Goal 4:** Establish docs.originals.build as the authoritative resource for SDK integration

---

## User Stories

**Story 1: The Ordinals Developer (Primary)**
```
As an Ordinals developer building a marketplace,
I want to quickly understand how to inscribe digital assets with provenance,
So that I can integrate Originals SDK into my platform within hours, not days.
```

**Story 2: The Migrating Developer**
```
As a developer migrating from another Ordinals SDK,
I want clear examples showing equivalent functionality,
So that I can port my existing codebase without trial-and-error.
```

**Story 3: The Enterprise Architect**
```
As an architect evaluating SDKs for our platform,
I want to understand the full SDK architecture and capabilities at a glance,
So that I can make informed technology decisions.
```

**Story 4: The Debugging Developer**
```
As a developer encountering an error,
I want troubleshooting docs with common errors and solutions,
So that I can resolve issues without opening support tickets.
```

**Story 5: The Advanced User**
```
As an experienced SDK user,
I want detailed API references and advanced patterns,
So that I can build complex workflows beyond basic examples.
```

---

## Functional Requirements

### FR-1: Documentation Platform (GitBook)

**FR-1.1:** The documentation MUST be hosted on GitBook at docs.originals.build
- Deployed on Railway infrastructure
- Custom domain configured with SSL
- GitBook sync configured to auto-deploy from main branch

**FR-1.2:** The documentation MUST support full-text search
- Search all content including code examples
- Keyboard shortcut (⌘K / Ctrl+K) for quick access

**FR-1.3:** The documentation MUST have clear navigation structure
- Left sidebar with hierarchical sections
- Right sidebar with page table of contents (TOC)
- Breadcrumbs showing current location

**FR-1.4:** The documentation MUST be mobile-responsive
- Readable on tablets and smartphones
- Touch-friendly navigation

**FR-1.5:** The documentation SHOULD support dark mode
- Respect system theme preference
- Toggle available in UI

---

### FR-2: Getting Started Section (Priority 1)

**FR-2.1:** The documentation MUST include a Quick Start guide completable in <10 minutes
- Installation instructions (npm, yarn, bun, pnpm)
- Minimal working example (create asset, inscribe)
- Success criteria ("You just created your first Ordinals asset!")
- Next steps links

**FR-2.2:** The documentation MUST include Installation & Setup guide
- Prerequisites (Node.js 18+, Bitcoin wallet setup)
- Package installation
- Configuration options explained
- Network selection (mainnet, testnet, signet, regtest)
- Environment variable setup

**FR-2.3:** The documentation MUST include Core Concepts page
- Three-layer architecture (did:peer → did:webvh → did:btco)
- Economic gravity model explanation
- When to use each layer (with decision tree)
- Terminology glossary (DID, VC, inscription, provenance, etc.)

**FR-2.4:** The documentation MUST include Configuration Guide
- Ordinals provider setup (OrdMockProvider vs OrdinalsClient)
- Network configuration (mainnet/testnet/signet/regtest)
- Fee oracle configuration
- External signer integration (Privy, AWS KMS, HSM)
- Logging and telemetry options

**FR-2.5:** The documentation SHOULD include "Choose Your Path" guide
- Path A: "I want to test locally" → Regtest + OrdMockProvider
- Path B: "I want to deploy on testnet" → Testnet + OrdinalsClient
- Path C: "I'm going to production" → Mainnet checklist

---

### FR-3: API Reference (Priority 1)

**FR-3.1:** The documentation MUST include complete API reference for `OriginalsSDK` class
- Constructor options with type definitions
- All public methods with signatures
- Return types and error conditions
- Minimum one code example per method

**FR-3.2:** The documentation MUST include API reference for `LifecycleManager`
- createAsset() with all resource types
- publishToWeb() with hosting requirements
- inscribeOnBitcoin() with fee estimation
- migrateAsset() for layer transitions
- Error handling examples

**FR-3.3:** The documentation MUST include API reference for `DIDManager`
- createDIDPeer() for local DIDs
- createDIDWebVH() with external signer support
- updateDIDWebVH() for DID rotation
- resolveDID() for all DID methods
- Key management patterns

**FR-3.4:** The documentation MUST include API reference for `BitcoinManager`
- inscribeData() for raw inscription
- transferInscription() for ownership changes
- estimateFees() for cost planning
- UTXO selection strategies
- PSBT building examples

**FR-3.5:** The documentation MUST include API reference for `CredentialManager`
- issueCredential() with templates
- verifyCredential() with trust chains
- createPresentation() for selective disclosure
- JSON-LD context handling

**FR-3.6:** The documentation MUST include Type Definitions reference
- OriginalsConfig interface
- AssetResource types
- Bitcoin network types
- Error types (StructuredError)
- Provider interfaces

**FR-3.7:** Each API method MUST document:
- Method signature with TypeScript types
- Parameter descriptions with constraints
- Return value type and structure
- Possible error codes and messages
- Minimum one executable code example
- Related methods (see also links)

**FR-3.8:** API reference SHOULD be auto-generated from TSDoc comments
- Use TypeDoc or similar tool
- Integrate into GitBook
- Keep in sync with code releases

---

### FR-4: Usage Guides (Priority 2)

**FR-4.1:** The documentation MUST include "Creating Your First Asset" guide
- Step-by-step walkthrough
- Resource preparation (hashing, metadata)
- Asset creation with LifecycleManager
- Verification steps
- Common mistakes and fixes

**FR-4.2:** The documentation MUST include "Publishing to Web (did:webvh)" guide
- When to publish (use cases)
- Domain setup requirements
- SSL certificate requirements
- DID document hosting
- Verification and testing

**FR-4.3:** The documentation MUST include "Inscribing on Bitcoin" guide
- When to inscribe (cost vs benefit)
- Fee estimation strategies
- Confirmation waiting
- Transaction monitoring
- Front-running protection

**FR-4.4:** The documentation MUST include "Complete Lifecycle Example"
- Real-world scenario (e.g., digital art sale)
- Start-to-finish workflow
- did:peer → did:webvh → did:btco migration
- Error handling at each stage
- Cost breakdown

**FR-4.5:** The documentation MUST include "Key Management" guide
- SDK-managed keys vs external signers
- Key rotation procedures
- Backup and recovery
- HSM/KMS integration
- Security best practices

**FR-4.6:** The documentation MUST include "Working with Verifiable Credentials" guide
- Creating credentials for assets
- Verification workflows
- Trust chains and issuers
- Revocation patterns
- Common VC use cases

**FR-4.7:** The documentation SHOULD include "Testing Strategies" guide
- Unit testing SDK integrations
- Mocking Bitcoin operations
- Testnet testing checklist
- Integration test examples

**FR-4.8:** The documentation SHOULD include "Performance Optimization" guide
- Batch operations
- Caching strategies
- Rate limiting
- Circuit breaker patterns
- Telemetry and monitoring

---

### FR-5: Integration Examples (Priority 2)

**FR-5.1:** The documentation MUST include "Marketplace Integration" example
- Complete marketplace flow
- Listing creation
- Sale and transfer
- Ownership verification
- Code repository link

**FR-5.2:** The documentation MUST include "Digital Collectibles Platform" example
- Minting flow
- Collection management
- Metadata standards
- Royalty tracking

**FR-5.3:** The documentation MUST include "Supply Chain Tracking" example
- Product provenance
- Multi-party credentials
- Verification at checkpoints
- Public registry

**FR-5.4:** The documentation SHOULD include "DAO Governance" example
- Member credentials
- Proposal anchoring
- Voting records
- Immutable history

**FR-5.5:** Each integration example MUST include:
- Problem statement
- Architecture diagram
- Complete working code
- Deployment instructions
- GitHub repository link
- Live demo link (if applicable)

---

### FR-6: Code Examples Catalog (Priority 1)

**FR-6.1:** The documentation MUST include executable code examples for:

**Basic Operations:**
- SDK initialization (all network types)
- Creating a simple asset
- Publishing to web
- Inscribing on Bitcoin
- Transferring ownership

**DID Operations:**
- Creating did:peer DIDs
- Creating did:webvh DIDs (SDK-managed keys)
- Creating did:webvh DIDs (external signer)
- Updating DID documents
- Resolving DIDs (all methods)
- Key rotation

**Bitcoin Operations:**
- UTXO selection strategies
- Fee estimation (custom oracle)
- PSBT building and signing
- Transaction broadcasting
- Confirmation monitoring

**Credential Operations:**
- Issuing verifiable credentials
- Verifying credentials
- Creating presentations
- Selective disclosure
- Revocation checks

**Error Handling:**
- Try-catch patterns
- Error code handling
- Retry logic
- Circuit breaker usage
- Graceful degradation

**Testing:**
- Unit test setup
- Mock provider usage
- Integration test patterns
- E2E testing on testnet

**FR-6.2:** Each code example MUST:
- Be copy-paste executable
- Include all necessary imports
- Show expected output
- Explain key lines with comments
- Link to relevant API docs

**FR-6.3:** Code examples SHOULD be tested in CI
- Automated validation on each release
- Ensure examples work with current SDK version

---

### FR-7: Diagrams and Visual Aids (Priority 2)

**FR-7.1:** The documentation MUST include architecture diagrams:
- Overall SDK architecture (component relationships)
- Three-layer lifecycle flow (did:peer → did:webvh → did:btco)
- DID document structure
- Credential issuance/verification flow
- Bitcoin inscription process

**FR-7.2:** The documentation MUST include sequence diagrams:
- Asset creation and migration
- Inscription and transfer workflow
- DID resolution process
- Credential verification chain

**FR-7.3:** The documentation SHOULD include decision trees:
- "Which network should I use?"
- "Which DID method for my use case?"
- "Should I inscribe or just publish?"

**FR-7.4:** Diagrams MUST be:
- Created in Mermaid.js (GitBook native support)
- Or SVG for complex graphics
- Accessible (alt text provided)
- High contrast for visibility

---

### FR-8: Best Practices Guide (Priority 2)

**FR-8.1:** The documentation MUST include Security Best Practices
- Private key management
- Input validation
- Rate limiting
- Error message sanitization
- Dependency management

**FR-8.2:** The documentation MUST include Cost Optimization
- When to use each layer
- Batch operations
- Fee timing strategies
- UTXO management

**FR-8.3:** The documentation MUST include Development Workflow
- Local development setup
- Testing progression (regtest → testnet → mainnet)
- CI/CD integration
- Version pinning

**FR-8.4:** The documentation SHOULD include Production Checklist
- Pre-launch security audit
- Monitoring setup
- Error tracking
- Backup strategies
- Incident response plan

---

### FR-9: Troubleshooting Documentation (Priority 2)

**FR-9.1:** The documentation MUST include Common Errors section
- List of StructuredError codes
- Explanation of each error
- Diagnostic steps
- Solution for each error
- When to seek support

**FR-9.2:** The documentation MUST include FAQ section
- Minimum 20 common questions
- Organized by topic
- Links to detailed docs

**FR-9.3:** The documentation SHOULD include Debug Guide
- Enabling debug logging
- Telemetry interpretation
- Network troubleshooting
- Provider issues

**FR-9.4:** Common errors MUST include:
- ORD_PROVIDER_REQUIRED
- INSUFFICIENT_FUNDS
- NETWORK_ERROR
- INVALID_DID
- VERIFICATION_FAILED
- FEE_ESTIMATION_FAILED
- INSCRIPTION_FAILED
- TRANSFER_FAILED

---

### FR-10: Developer Onboarding (Priority 3)

**FR-10.1:** The documentation SHOULD include "Your First Hour" tutorial
- 60-minute guided experience
- Builds a complete mini-project
- Covers all major SDK features
- Checkpoints with validation

**FR-10.2:** The documentation SHOULD include Video Walkthroughs
- 5-minute Quick Start video
- 15-minute Complete Tutorial video
- Architecture overview video (optional)

**FR-10.3:** The documentation SHOULD include Interactive Elements
- Code playground (RunKit or similar)
- Live API explorer (if feasible)
- Interactive diagrams (clickable)

---

### FR-11: Documentation Maintenance (Priority 2)

**FR-11.1:** The documentation MUST have version selectors
- Docs for each major version
- Clear indication of current version
- Link to changelog

**FR-11.2:** The documentation MUST include changelog
- User-facing changes
- Breaking changes highlighted
- Migration guides for major versions

**FR-11.3:** The documentation MUST be auto-deployed
- GitBook syncs from GitHub main branch
- Deploy on merge to main
- Preview builds for PRs (if supported)

**FR-11.4:** The documentation SHOULD have contribution guide
- How to report doc issues
- How to submit doc PRs
- Style guide for contributors

---

### FR-12: Search and Navigation (Priority 1)

**FR-12.1:** The documentation MUST have effective search
- Full-text search across all pages
- Search code examples
- Keyboard shortcut (⌘K / Ctrl+K)
- Search suggestions/autocomplete

**FR-12.2:** The documentation MUST have clear navigation hierarchy
```
- Home
- Getting Started
  - Quick Start (10 min)
  - Installation & Setup
  - Core Concepts
  - Configuration Guide
  - Choose Your Path
- API Reference
  - OriginalsSDK
  - LifecycleManager
  - DIDManager
  - BitcoinManager
  - CredentialManager
  - Type Definitions
  - Error Codes
- Usage Guides
  - Creating Your First Asset
  - Publishing to Web (did:webvh)
  - Inscribing on Bitcoin
  - Complete Lifecycle Example
  - Key Management
  - Working with Verifiable Credentials
  - Testing Strategies
  - Performance Optimization
- Integration Examples
  - Marketplace Integration
  - Digital Collectibles Platform
  - Supply Chain Tracking
  - DAO Governance
- Code Examples
  - Basic Operations
  - DID Operations
  - Bitcoin Operations
  - Credential Operations
  - Error Handling
  - Testing Examples
- Best Practices
  - Security
  - Cost Optimization
  - Development Workflow
  - Production Checklist
- Troubleshooting
  - Common Errors
  - FAQ
  - Debug Guide
- Advanced Topics
  - Architecture Deep Dive
  - Custom Providers
  - Extending the SDK
  - Protocol Specifications
- Resources
  - Changelog
  - Migration Guides
  - GitHub Repository
  - Support Channels
  - Contributing
```

**FR-12.3:** Each page MUST have:
- Clear title and description
- Table of contents (right sidebar)
- "Was this helpful?" feedback widget
- "Edit on GitHub" link
- Last updated timestamp

---

### FR-13: Accessibility (Priority 2)

**FR-13.1:** The documentation MUST meet WCAG 2.1 AA standards
- Sufficient color contrast
- Keyboard navigation
- Screen reader support
- Alt text for images

**FR-13.2:** The documentation MUST support font scaling
- Readable at 200% zoom
- No horizontal scrolling (except code blocks)

**FR-13.3:** Code examples MUST be accessible
- Syntax highlighting with adequate contrast
- Copy button for code blocks
- Line numbers optional/toggleable

---

## Non-Goals (Out of Scope)

❌ **Explicitly NOT included:**

- **Multilingual support** - English only for Phase 1 (can add i18n later)
- **Video hosting** - Link to YouTube/external, don't host videos in docs
- **Interactive SDK playground** - Nice-to-have for future, not MVP
- **Real-time support chat** - Use GitHub Discussions for now
- **Detailed protocol specifications** - Focus on SDK usage, not protocol design docs
- **Marketing content** - Docs are technical, not promotional
- **Mobile app documentation** - SDK is Node.js/browser, not native mobile
- **Historical version archives** - Only maintain docs for last 2 major versions
- **Custom illustrations** - Use Mermaid.js diagrams, simple screenshots only
- **Community-contributed examples** - Accept PRs but not required for launch

---

## Success Metrics

### Primary Metrics

**M-1: Time to First Integration** (Target: <30 minutes)
- Measure: Time from "npm install" to first successful asset creation + inscription
- How: Instrumentation in SDK + user surveys
- Success: 80% of Ordinals developers complete in <30 min

**M-2: Documentation Completeness** (Target: 100% API coverage)
- Measure: % of public API methods with documentation + examples
- How: Automated coverage report in CI
- Success: 100% of public APIs documented with examples

**M-3: Support Ticket Reduction** (Target: 50% reduction)
- Measure: Number of "how do I" questions in GitHub Issues/Discord
- Baseline: Current average (estimate ~10-15/week)
- Success: Reduce to <5/week within 2 weeks of doc launch

### Secondary Metrics

**M-4: Developer Satisfaction** (Target: 4.5+/5)
- Measure: "Was this helpful?" ratings on doc pages
- Success: Average 4.5+ rating across all pages

**M-5: Documentation Usage** (Target: 80% of new users)
- Measure: % of first-time SDK users who visit docs before/during integration
- How: Analytics on docs.originals.build
- Success: 80%+ of new users visit docs

**M-6: Search Effectiveness** (Target: 90% findability)
- Measure: % of searches that result in page visit
- Success: 90%+ of searches lead to clicked result

**M-7: Example Code Quality** (Target: 100% executable)
- Measure: % of code examples that pass automated tests
- How: CI pipeline testing examples
- Success: 100% of examples are copy-paste executable

---

## Technical Considerations

### Source Files to Document

**SDK Core:**
- `src/core/OriginalsSDK.ts` - Main SDK class
- `src/lifecycle/LifecycleManager.ts` - Asset lifecycle
- `src/lifecycle/OriginalsAsset.ts` - Asset representation
- `src/did/DIDManager.ts` - DID operations
- `src/did/WebVHManager.ts` - did:webvh specifics
- `src/bitcoin/BitcoinManager.ts` - Bitcoin operations
- `src/bitcoin/PSBTBuilder.ts` - Transaction building
- `src/vc/CredentialManager.ts` - VC operations
- `src/types/*.ts` - All type definitions

**Utilities to Document:**
- `src/utils/telemetry.ts` - Error handling patterns
- `src/crypto/Multikey.ts` - Cryptographic operations
- Provider interfaces in `src/adapters/`

### Documentation Build Pipeline

**Phase 1: Content Creation** (Tonight - MVP)
1. Create GitBook space at docs.originals.build
2. Set up GitHub integration for auto-sync
3. Write high-priority content:
   - Quick Start guide
   - Installation & Setup
   - Core Concepts
   - Basic API reference (OriginalsSDK, LifecycleManager, BitcoinManager)
   - Top 5 code examples
   - Common errors list
4. Deploy to Railway

**Phase 2: Complete API Reference** (Week 1)
1. Set up TypeDoc for API extraction
2. Document all managers (DIDManager, CredentialManager, etc.)
3. Document all type definitions
4. Create all code examples
5. Add sequence diagrams

**Phase 3: Advanced Content** (Week 2)
1. Write all usage guides
2. Complete integration examples (with repos)
3. Create best practices guide
4. Expand troubleshooting section
5. Add accessibility improvements

### Dependencies

**Required:**
- GitBook account (docs.originals.build)
- Railway hosting account
- GitHub repository access
- Custom domain DNS configuration

**Optional:**
- TypeDoc for API extraction
- Mermaid.js for diagrams (built into GitBook)
- Analytics tool (GitBook built-in or Google Analytics)
- Video hosting (YouTube)

### Testing Strategy

**Documentation Testing:**
1. All code examples MUST be executable and tested in CI
2. Create `docs-examples/` folder with test suite
3. Run on every SDK release
4. Fail CI if examples break

**Manual Review:**
1. Fresh developer walkthrough (someone unfamiliar with SDK)
2. Accessibility audit (WAVE tool, screen reader test)
3. Cross-browser testing (Chrome, Firefox, Safari, Edge)
4. Mobile device testing

**Feedback Loop:**
1. "Was this helpful?" widget on every page
2. Monitor search queries for gaps
3. Track GitHub Issues tagged "documentation"
4. Monthly review of support tickets

### Risks & Mitigation

**Risk 1: Aggressive Timeline**
- Mitigation: Phase MVP tonight (Quick Start + basic API), iterate to complete

**Risk 2: SDK Changes During Documentation**
- Mitigation: Use TypeDoc for auto-generated API docs, keep examples in sync with tests

**Risk 3: Documentation Drift**
- Mitigation: CI tests for code examples, changelog review process, quarterly audits

**Risk 4: Poor Search/Navigation**
- Mitigation: Test with real developers early, iterate based on feedback

**Risk 5: GitBook Limitations**
- Mitigation: Research GitBook features upfront, have backup plan (VitePress migration if needed)

---

## Acceptance Criteria

This feature is DONE when:

### Phase 1 (MVP - Tonight)
- ✅ GitBook space live at docs.originals.build
- ✅ Railway deployment configured and working
- ✅ Quick Start guide (10 min completable)
- ✅ Installation & Setup guide complete
- ✅ Core Concepts page complete
- ✅ Basic API reference for OriginalsSDK, LifecycleManager, BitcoinManager
- ✅ At least 5 executable code examples
- ✅ Common errors section started
- ✅ Search working
- ✅ Navigation structure defined
- ✅ Mobile-responsive
- ✅ Dark mode working
- ✅ At least 1 Ordinals developer completes integration in <30 min using only docs

### Phase 2 (Complete API - Week 1)
- ✅ 100% API coverage (all public methods documented)
- ✅ All type definitions documented
- ✅ All code examples (20+) executable and tested
- ✅ Sequence diagrams added
- ✅ Architecture diagrams added
- ✅ Error code reference complete
- ✅ FAQ section (20+ questions)

### Phase 3 (Full Documentation - Week 2)
- ✅ All usage guides complete
- ✅ All integration examples with working repos
- ✅ Best practices guide complete
- ✅ Troubleshooting guide comprehensive
- ✅ WCAG 2.1 AA compliance validated
- ✅ CI pipeline testing all code examples
- ✅ Changelog and migration guides added
- ✅ "Was this helpful?" widget functional
- ✅ Analytics configured and tracking
- ✅ Support ticket volume reduced by 50%
- ✅ Average page rating >4.5/5
- ✅ Time to first integration <30 min for 80% of developers

---

## Implementation Plan

### Tonight (Phase 1 - MVP)

**Step 1: GitBook Setup** (30 min)
1. Create GitBook organization
2. Create new space "Originals SDK"
3. Configure custom domain docs.originals.build
4. Set up GitHub integration (sync from main)
5. Configure Railway deployment

**Step 2: Core Content** (3 hours)
1. Write Quick Start guide (10-min tutorial)
2. Write Installation & Setup
3. Write Core Concepts (3-layer architecture)
4. Write Configuration Guide

**Step 3: API Reference** (2 hours)
1. Document OriginalsSDK class
2. Document LifecycleManager
3. Document BitcoinManager
4. Add at least 5 code examples

**Step 4: Essential Sections** (1 hour)
1. Create Common Errors list
2. Start FAQ (top 10 questions)
3. Add navigation structure
4. Test mobile responsiveness

**Step 5: Launch** (30 min)
1. Deploy to Railway
2. Test end-to-end
3. Verify search working
4. Get feedback from 1 Ordinals developer

### Week 1 (Phase 2 - Complete API)

**Day 1-2: API Reference**
- Document DIDManager, WebVHManager
- Document CredentialManager
- Document all type definitions
- Set up TypeDoc extraction

**Day 3-4: Code Examples**
- Create all 20+ code examples
- Set up CI testing for examples
- Add examples to relevant docs

**Day 5: Visuals & Errors**
- Create all sequence diagrams
- Create architecture diagrams
- Complete error code reference
- Expand FAQ to 20+ questions

### Week 2 (Phase 3 - Full Documentation)

**Day 1-2: Usage Guides**
- Write all 8 usage guides
- Add troubleshooting content
- Expand best practices

**Day 3-4: Integration Examples**
- Create marketplace example + repo
- Create collectibles example + repo
- Create supply chain example + repo

**Day 5: Polish & Launch**
- Accessibility audit
- Fresh developer test
- Analytics setup
- Announce launch

---

## Open Questions

❓ **Q1:** Do we have access to Railway and custom domain DNS already?
- Owner: User
- Due: Tonight
- Blocker: Yes (needed for deployment)

❓ **Q2:** Should we extract API docs using TypeDoc, or write manually?
- Owner: AI Agent
- Due: Tonight
- Decision: Manual for MVP, TypeDoc for Phase 2

❓ **Q3:** Do we want to include video walkthroughs in Phase 1 or Phase 3?
- Owner: User
- Due: Tomorrow
- Blocker: No (optional enhancement)

❓ **Q4:** What analytics tool should we use? (GitBook built-in vs Google Analytics)
- Owner: User
- Due: Week 1
- Blocker: No (can add later)

❓ **Q5:** Should code examples live in docs or separate repo?
- Owner: AI Agent
- Due: Tonight
- Decision: Inline in docs, tested examples in `/docs-examples` folder

---

## GitBook-Specific Implementation Notes

### GitBook Features to Leverage

**Built-in Features:**
- Mermaid.js diagrams (use for all architecture/sequence diagrams)
- Syntax highlighting (automatic for code blocks)
- Search (built-in, no config needed)
- OpenAPI integration (if we create OpenAPI spec later)
- Dark mode (automatic)
- Mobile responsive (automatic)

**GitBook Integrations:**
- GitHub Sync (auto-deploy from main branch)
- Analytics (built-in traffic analytics)
- Custom domain (docs.originals.build)

### Content Structure

**GitBook Spaces:**
- Create single space: "Originals SDK"
- Use Collections for major versions (v1, v2, etc.)
- Current docs in "Main" variant

**Page Organization:**
- Use page groups for sections
- Use page links for external resources
- Use hints/callouts for warnings, tips, info boxes
- Use tabs for multi-language examples (if needed later)

### Styling Guidelines

**Code Blocks:**
```typescript
// Always use TypeScript for SDK examples
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  enableLogging: true,
});
```

**Callouts:**
- 💡 Tip: Use for best practices
- ⚠️ Warning: Use for gotchas
- ❌ Error: Use for common mistakes
- ✅ Success: Use for correct patterns
- 📘 Info: Use for additional context

**Links:**
- Internal: Use relative links for pages in GitBook
- External: Use full URLs for GitHub, external resources
- API: Use anchor links for API reference sections

---

## Maintenance & Sustainability

### Documentation Ownership

**Primary Owner:** SDK maintainers
**Review Process:**
1. All SDK PRs must include doc updates if API changes
2. PR cannot merge without doc review
3. Quarterly doc audit scheduled

### Update Triggers

**When to Update Docs:**
- ✅ New SDK release (any version)
- ✅ Breaking changes (immediate update required)
- ✅ New features (document before release)
- ✅ Bug fixes affecting documented behavior
- ✅ Support tickets revealing doc gaps

### Version Management

**Versioning Strategy:**
- Main docs track latest SDK version
- GitBook Collections for major versions (v1, v2)
- Changelog links to version-specific docs
- Migration guides for breaking changes

### Community Contributions

**How to Contribute:**
- "Edit on GitHub" link on every page
- Documentation PRs welcome
- Style guide for contributors
- Credit contributors in changelog

---

**END OF PRD**

---

## Next Steps

1. **Confirm access:** Verify Railway and DNS setup
2. **Create GitBook space:** Set up docs.originals.build
3. **Start writing:** Begin Phase 1 content (Quick Start guide first)
4. **Test early:** Get 1 Ordinals developer to try MVP
5. **Iterate:** Use feedback to improve

**Ready to start building! 🚀**

