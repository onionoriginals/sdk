# Originals Protocol v1.1 — Spec-to-Code Implementation Plan

**Source spec:** `ORIGINALS_PROTOCOL_SPECIFICATION_v1.1_UNIFIED.md`  
**Repository:** `originals-sdk`  
**Goal:** concrete, code-level mapping from v1.1 normative requirements (Sections 4–11) to required SDK changes.

---

## 1) Executive Summary

Current SDK already has strong lifecycle scaffolding (`did:peer -> did:webvh -> did:btco`), CEL primitives, DID managers/resolvers, and VC/Data Integrity tooling.  
However, v1.1 introduces conformance-critical constraints that are not fully enforced yet:

1. **CEL event contract must be explicit and uniform** (event id/timestamp/actor/op/hash/prev/signature semantics).
2. **Required event semantics must be represented as `ResourceAdded` and `ResourceUpdated`** (or strict semantic equivalents).
3. **Signature suite for v1.1 conformance must be `eddsa-jcs-2022`** (current VC path still primarily uses `eddsa-rdfc-2022`).
4. **Finalization on `did:btco` must produce deterministic artifact + final attestation schema** (current migration/inscription flow lacks standardized final attestation envelope fields from §9.3).
5. **Resolver behavior must provide stable DID URL dereferencing and required machine-readable errors** (`invalidDid`, `notFound`, `representationNotSupported`).

---

## 2) Normative Spec-to-Code Mapping (Sections 4–11)

## §4 Protocol Model (CEL as source of truth)

### Must satisfy
- CEL is authoritative for state/provenance/mutation lineage.

### Existing code
- `packages/sdk/src/cel/*`
- `packages/sdk/src/lifecycle/OriginalsAsset.ts`
- `packages/sdk/src/lifecycle/LifecycleManager.ts`

### Required changes
- Make CEL replay path the single canonical state-derivation path for lifecycle/public APIs (avoid parallel ad hoc state mutation paths).
- Add explicit conformance guard in lifecycle APIs that rejects mutation attempts after finalized btco version marker.

---

## §4.2 Event-Driven Provenance (`ResourceAdded`, `ResourceUpdated`)

### Must satisfy
- Required event types must exist semantically.

### Existing code
- CEL event enum: `create | update | deactivate` in `packages/sdk/src/cel/types.ts`.
- VC credential typing includes `ResourceUpdated` in `packages/sdk/src/types/credentials.ts` / `vc/CredentialManager.ts`.

### Required changes
- Introduce canonical operation taxonomy in CEL payload (e.g., `operation: 'ResourceAdded' | 'ResourceUpdated' | ...`) while retaining backward compatibility with `create/update`.
- Update CEL validation/verification to require semantic mapping for required operations.
- Add migration adapter for old logs (`create -> ResourceAdded`, `update -> ResourceUpdated`).

**Primary modules/functions to change:**
- `packages/sdk/src/cel/types.ts` (event contract/type additions)
- `packages/sdk/src/cel/algorithms/createEventLog.ts`
- `packages/sdk/src/cel/algorithms/updateEventLog.ts`
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
- `packages/sdk/src/cel/OriginalsCel.ts`

---

## §5 DID + DID URL Resource Addressing

### Must satisfy
- Parse/generate base DID, DID+path, DID+path+query, DID+fragment.
- Deterministic dereferencing mappings by method driver.

### Existing code
- DID resolution in `packages/sdk/src/did/DIDManager.ts`, `did/BtcoDidResolver.ts`.
- No unified DID URL parser/dereferencer abstraction with stable behavior contract.

### Required changes
- Add centralized DID URL parser/formatter utility and method-aware dereferencer interface.
- Implement deterministic dereference behavior for btco/webvh/peer drivers.
- Add explicit representation negotiation + `representationNotSupported` error pathway.

**Primary modules/functions to change/add:**
- `packages/sdk/src/did/DIDManager.ts` (`resolveDID`, add `dereferenceDidUrl`)
- `packages/sdk/src/did/BtcoDidResolver.ts` (path/query/fragment support)
- **New:** `packages/sdk/src/did/DidUrl.ts` (parse/format)
- **New:** `packages/sdk/src/did/Dereferencer.ts` (result/error contract)

---

## §6 Lifecycle + Mutability

### Must satisfy
- Unidirectional lifecycle.
- `did:btco` immutable.
- Finalized version non-mutable; webvh can continue as staging for later finalization.

### Existing code
- Path checks already present in `lifecycle/LifecycleManager.ts`, `lifecycle/OriginalsAsset.ts`, `cel/OriginalsCel.ts`.

### Required changes
- Enforce **version-scoped finality**: once version finalized to btco, lock that version’s mutation path.
- Add explicit re-inscription model for later versions from webvh staging line.
- Harden update APIs to reject writes against `final` snapshots.

**Primary modules/functions to change:**
- `packages/sdk/src/lifecycle/OriginalsAsset.ts` (version/finality metadata model)
- `packages/sdk/src/lifecycle/LifecycleManager.ts` (`publish`, `inscribe`, `validateMigration`, mutation guards)
- `packages/sdk/src/cel/OriginalsCel.ts` (`update`, `migrate` guards)

---

## §7 Required CEL Event Contract

### Must satisfy
Each event must include semantic equivalents of:
1) event id, 2) timestamp, 3) actor/controller id, 4) operation type, 5) content/resource hash, 6) previous hash/genesis marker, 7) signature/proof.

### Existing code
- `previousEvent` + `proof` currently present.
- Other fields are inconsistently embedded in `data` (not contractually enforced).

### Required changes
- Define canonical `CelEventEnvelopeV11` schema.
- Require presence of all seven semantics in create/update generation and verification.
- Add deterministic event-id strategy and explicit genesis marker policy.

**Primary modules/functions to change:**
- `packages/sdk/src/cel/types.ts`
- `packages/sdk/src/cel/algorithms/createEventLog.ts`
- `packages/sdk/src/cel/algorithms/updateEventLog.ts`
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
- `packages/sdk/src/cel/hash.ts` (if event-id/hash derivation changes)
- `packages/sdk/src/cel/serialization/json.ts` / `serialization/index.ts` (deterministic shape)

---

## §8 Signature + Verification (`eddsa-jcs-2022` required)

### Must satisfy
- Required events signed.
- Required cryptosuite for v1.1 conformance: `eddsa-jcs-2022`.
- Deterministic verification bound to canonical payload + DID-resolved controller material.

### Existing code
- CEL verifier accepts both `eddsa-jcs-2022` and `eddsa-rdfc-2022`.
- VC cryptosuite implementation defaults to `eddsa-rdfc-2022` in:
  - `packages/sdk/src/vc/cryptosuites/eddsa.ts`
  - `packages/sdk/src/vc/proofs/data-integrity.ts`
  - `packages/sdk/src/vc/Issuer.ts`
  - `packages/sdk/src/vc/CredentialManager.ts`

### Required changes
- Introduce conformance mode where required CEL operations must use/verify `eddsa-jcs-2022`.
- Refactor VC/DataIntegrity signing pipeline to support JCS-first path.
- Keep optional legacy compatibility flag for rdfc verification only (non-conformant mode).

**Primary modules/functions to change:**
- `packages/sdk/src/vc/cryptosuites/eddsa.ts`
- `packages/sdk/src/vc/proofs/data-integrity.ts`
- `packages/sdk/src/vc/Issuer.ts`
- `packages/sdk/src/vc/Verifier.ts`
- `packages/sdk/src/vc/CredentialManager.ts`
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (suite enforcement)

---

## §9 Finalization on Bitcoin (`did:btco`)

### Must satisfy
- Deterministic final artifact at finalization.
- Canonical transferable state anchored on Bitcoin.
- Final attestation fields (§9.3): source DID/controller, finalized CEL head hash, finalized artifact hash, inscription/tx + chain ref, timestamp, finality status=`final`.

### Existing code
- Inscription/migration in `lifecycle/LifecycleManager.ts`, `cel/layers/BtcoCelManager.ts`, `bitcoin/*`.
- No standardized final attestation envelope guaranteed by API contract.

### Required changes
- Add deterministic artifact materialization pipeline (manifest + canonical serialization).
- Add `FinalAttestation` type + generation + persistence + optional co-inscription strategy.
- Ensure transfer logic references finalized attested artifact/hash.

**Primary modules/functions to change/add:**
- `packages/sdk/src/lifecycle/LifecycleManager.ts` (`inscribeOnBitcoin`, `inscribe`, transfer linkage)
- `packages/sdk/src/cel/layers/BtcoCelManager.ts` (btco migration event data schema)
- `packages/sdk/src/bitcoin/BitcoinManager.ts` (attestation inscription metadata)
- `packages/sdk/src/types/credentials.ts` / `types/common.ts` (attestation typing)
- **New:** `packages/sdk/src/attestations/FinalAttestation.ts`
- **New:** `packages/sdk/src/attestations/AttestationManager.ts`

---

## §10 Preliminary Attestations (`did:webvh`)

### Must satisfy
- Optional preliminary attestations with CEL head hash + candidate artifact hash + explicit non-final marker (`provisional`).

### Existing code
- WebVH migration supports witness proofs but no standardized preliminary attestation schema/marker.

### Required changes
- Add `PreliminaryAttestation` schema and API.
- Ensure explicit marker cannot be interpreted as final.

**Primary modules/functions to change/add:**
- `packages/sdk/src/cel/layers/WebVHCelManager.ts`
- `packages/sdk/src/lifecycle/LifecycleManager.ts` (publish flow)
- **New:** `packages/sdk/src/attestations/PreliminaryAttestation.ts`

---

## §11 Resolver Requirements

### Must satisfy
- Resolve DID to DID document.
- Dereference DID URLs for resources.
- Machine-readable errors: `invalidDid`, `notFound`, `representationNotSupported`.
- Stable behavior for equivalent requests.

### Existing code
- `BtcoDidResolver` already emits `invalidDid`/`notFound` in resolution metadata.
- No unified resolver error contract across all methods; no formal dereference API.

### Required changes
- Standardize resolver return envelope across did methods.
- Add deterministic, testable dereference behavior.
- Add missing `representationNotSupported` and consistency checks.

**Primary modules/functions to change:**
- `packages/sdk/src/did/DIDManager.ts`
- `packages/sdk/src/did/BtcoDidResolver.ts`
- `packages/sdk/src/did/WebVHManager.ts`
- `packages/sdk/src/types/did.ts` (resolver/dereference result types)

---

## 3) Concrete File-Level Change List

## A. CEL Core
- `packages/sdk/src/cel/types.ts`
  - Add v1.1 event envelope/type definitions and required semantic fields.
- `packages/sdk/src/cel/algorithms/createEventLog.ts`
  - Populate required envelope fields on creation.
- `packages/sdk/src/cel/algorithms/updateEventLog.ts`
  - Populate required envelope fields on update.
- `packages/sdk/src/cel/algorithms/verifyEventLog.ts`
  - Enforce required semantics and suite rules in conformance mode.
- `packages/sdk/src/cel/serialization/json.ts`
  - Canonical deterministic serialization contract for hash/sign verification.

## B. Lifecycle/Mutability/Finalization
- `packages/sdk/src/lifecycle/OriginalsAsset.ts`
  - Track finalized versions and immutable boundaries.
- `packages/sdk/src/lifecycle/LifecycleManager.ts`
  - Deterministic final artifact generation.
  - Final/preliminary attestation emission.
  - Version-scoped mutation lock enforcement.
- `packages/sdk/src/cel/layers/WebVHCelManager.ts`
  - Preliminary attestation support.
- `packages/sdk/src/cel/layers/BtcoCelManager.ts`
  - Final attestation linkage and btco finalization metadata.

## C. DID Resolution/Dereference
- `packages/sdk/src/did/DIDManager.ts`
  - Add first-class DID URL dereference API.
  - Normalize error contract.
- `packages/sdk/src/did/BtcoDidResolver.ts`
  - Expand to full DID URL handling and standardized errors.
- `packages/sdk/src/did/WebVHManager.ts`
  - Deterministic resource mapping for DID URL forms.
- `packages/sdk/src/types/did.ts`
  - Add resolver/dereference result and error enums.

## D. Cryptosuite Conformance
- `packages/sdk/src/vc/cryptosuites/eddsa.ts`
- `packages/sdk/src/vc/proofs/data-integrity.ts`
- `packages/sdk/src/vc/Issuer.ts`
- `packages/sdk/src/vc/Verifier.ts`
- `packages/sdk/src/vc/CredentialManager.ts`
  - Move to `eddsa-jcs-2022` default in conformance mode.
  - Keep legacy compatibility mode as explicitly non-conformant.

## E. New Modules
- `packages/sdk/src/attestations/FinalAttestation.ts`
- `packages/sdk/src/attestations/PreliminaryAttestation.ts`
- `packages/sdk/src/attestations/AttestationManager.ts`
- `packages/sdk/src/did/DidUrl.ts`
- `packages/sdk/src/did/Dereferencer.ts`

---

## 4) Phased Implementation Plan

### Phase 0 — Guardrails + Contracts (1–2 days)
- Add v1.1 feature flag/conformance mode in SDK config.
- Introduce new type contracts (CEL envelope, resolver errors, attestation types).
- Add exhaustive test skeletons for §4–§11 normative requirements.

### Phase 1 — CEL Event Contract + Verification (2–4 days)
- Implement required CEL fields and semantic operation mapping.
- Update create/update/verify flows.
- Backward-compatible parser for legacy logs.

### Phase 2 — DID URL Parsing + Dereferencing + Resolver Errors (2–3 days)
- Add parser/formatter.
- Implement deterministic dereference for peer/webvh/btco.
- Standardize machine-readable error responses.

### Phase 3 — Cryptosuite Alignment (`eddsa-jcs-2022`) (2–4 days)
- JCS-first proof pipeline for required events and attestations.
- Verification binding to DID-resolved controller keys.
- Legacy fallback gates + deprecation warnings.

### Phase 4 — Finalization + Attestation Model (3–5 days)
- Deterministic artifact materialization.
- Preliminary and final attestation generation/storage/inscription linkage.
- Enforce immutable finalized version boundaries.

### Phase 5 — Migration + Hardening + Docs (2–3 days)
- Data migration helpers for pre-v1.1 CEL logs.
- Full integration/e2e suite updates.
- Conformance checklist doc + examples update.

---

## 5) Risk Matrix

| Risk | Impact | Likelihood | Mitigation |
|---|---|---:|---|
| Event schema breakage for existing CEL logs | High | Medium | Dual-read parser, adapter mapping (`create/update -> ResourceAdded/ResourceUpdated`), migration tooling |
| Cryptosuite switch introduces signature incompatibility | High | Medium | Conformance flag, phased rollout, verify-both/sign-jcs strategy during transition |
| DID URL dereference behavior diverges by method | Medium | Medium | Shared dereferencer interface + golden tests for equivalent requests |
| Btco final attestation not fully deterministic | High | Medium | Canonical serialization + deterministic artifact builder + test vectors |
| Performance regressions from stricter verification | Medium | Low | Benchmark suite on CEL verify path and caching for DID resolution |
| Breaking API surface for integrators | Medium | Medium | Additive APIs first, deprecate later, migration guide + codemods/snippets |

---

## 6) Migration Notes (for SDK Integrators)

1. **CEL event consumers**
   - Expect new canonical event envelope fields.
   - Legacy logs continue to parse via compatibility adapter.

2. **Signature/verification**
   - Conformant mode requires `eddsa-jcs-2022`.
   - Existing `eddsa-rdfc-2022` credentials/events remain verifiable only in legacy mode.

3. **Lifecycle behavior**
   - Once a version is finalized on btco, that version is immutable.
   - Subsequent evolution must proceed as new staged version lineage on webvh before re-finalization.

4. **Resolver API**
   - New standardized dereference result shape and machine-readable errors.
   - Consumers should switch from ad hoc `resolveDID()` assumptions to typed resolve/dereference responses.

5. **Attestation artifacts**
   - Preliminary and final attestations become first-class SDK outputs with stable schemas.
   - Downstream indexers should ingest attestation objects rather than infer finality heuristically.

---

## 7) Definition of Done (v1.1)

- All §4–§11 MUST requirements are traceable to tests and passing.
- Conformance mode returns claim string: `Originals Protocol v1.1 compliant`.
- SDK docs/examples updated for event schema, resolver API, and attestation flows.
- Backward compatibility validated on representative legacy CEL logs.
