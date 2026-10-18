# 011 — Replace CEL 3 with the Originals Protocol (VH-Log / did:vh)

Status: **approved by the owner on 2026-10-18**, with the recommendations for Q1–Q4 accepted (section 6). The provisional protocol choices in section 2 remain provisional until the spec decides them.

## 0. Pins

| Dependency | Pin | Notes |
|---|---|---|
| Originals Protocol | `aviarytech/originals-spec@d64fdbe4aef3d12e26109e7eeab28da569169e05` | Editor's Draft 0.1 |
| VH-Log | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` + PR 1 `a3e3627e`, PR 2 `0d5eb134`, PR 3 `3bcd0acb`, PR 8 `3770b574`, PR 9 `5552a668`, PR 10 `1867a2b1`, PR 11 `7bae699a` | PRs treated as merged |
| did:vh | `swcurran/didvh@e0b7cbad27d7b2274057251f85687e133329b5a9` + PR 3 `b3e7a56d` | extension mechanism treated as merged |
| did:webvh (experimental, on VH-Log) | `decentralized-identity/didwebvh` PR 302, merge `deef9cf1` (`spec-exp/`) | Merged 2026-10-18; keeps method value `did:webvh:1.0` |
| bip340-jcs-2025 | Data Integrity BIP340 Cryptosuite v0.1 (dcdpr) | Draft; see S6 below |
| SDK baseline | `onionoriginals/sdk@00fc683` | = current `main` |

These pins go into `specs/README.md` as the governing manifest, replacing the CEL 3 documents.

## 1. Architecture

### 1.1 Packages

A new package **`@originals/vh`** (`packages/vh`) replaces `@originals/cel`. Each layer is a subpath, and each layer only knows the layers below it:

| Subpath | Contents | Spec |
|---|---|---|
| `@originals/vh/json` | Strict JSON parser (rejects duplicate keys, lone surrogates, non-I-JSON numbers), JCS (RFC 8785), bounded sizes | P5.7, VH-Log |
| `@originals/vh/crypto` | multibase/multihash/multikey; `eddsa-jcs-2022`; `bip340-jcs-2025`; did:key decode | P5.12, VH-Log PR 3 |
| `@originals/vh/log` | Generic VH-Log engine: SCID, entry hash, parameters (accumulation/activation), proofs, witness threshold, version selection, comparing copies. **Specialisation hooks** for: designated version param, permitted suites, versionTime precision (PR 8), controller keys (PR 11), authoritative source (PR 2), alternative encoding (PR 10), non-HTTPS locations (PR 9) | VH-Log + PRs |
| `@originals/vh/didvh` | Plain `did:vh:1.0` resolver plus the extension registry (did:vh PR 3) | did:vh |
| `@originals/vh/webvh` | `did:webvh:1.0` as a VH-Log specialisation (PR 302); DID-to-HTTPS, `#files`, verification of logs produced by `didwebvh-ts` | did:webvh exp. (see Q1) |
| `@originals/vh/originals` | The `originals:1.0` extension: state schema, transitions, author binding, derived DID document, fork/anchor rules, verification report, evidence package codec | Originals §2–9 |
| `@originals/vh/fetch` | SSRF-safe fetcher (HTTPS only, no redirects, IP/private refusal pre- and post-DNS, size caps, timeouts). Node-only and isolated so the browser entries stay clean | P8.5, VH-Log |

`@originals/sdk` keeps the public workflow (create/edit/load/verify/publish) on top of this, as described in 1.3. `@originals/auth` keeps its surface and gains Originals-key and declaration support in Phase 3.

### 1.2 Verification pipeline (the asset log)

```
bytes ─▶ strict JSON lines ─▶ VH-Log engine (specialisation = originals:1.0)
          │  hash chain, SCID, versionTime, parameters, proof shape/suite
          │  controller-keys hook ─▶ AuthorDidResolver(did, versionId) ─▶ P5.3 binding
          │  witness hook (if active) ─▶ did:key witness proofs, threshold, P9.9 equality
          │  authoritative-source hook (anchored) ─▶ sat assembly P9.13/P9.15/P9.16
          ▼
     Originals state rules (P4.x, P5.1, P5.8, P6.5, P9.10) ─▶ derived DID doc (P3.8)
          ▼
     VerificationReport { history, authorBinding, identityEvidence, resources,
                          ordering, freshness, forks, anchors, ownership, current }
```

The generic engine never decides the Originals result (P3.5). Plain `did:vh:1.0` and `did:webvh:1.0` resolvers reject an `originals:1.0` log by its `method` value.

### 1.3 SDK surface (Phase 1 shape; names are provisional)

```ts
const sdk = OriginalsSDK.create({ store, authorDids /* AuthorDidResolver registry */ });
const r = await sdk.create({ name, metadata, resources, signer });  // → { kind: "original", original } | { kind: "draft", draft }
await sdk.edit(original, { parent: checkpoint, name?, metadata? /* null removes */, resources?, signer });
await sdk.deactivate(original, { parent, signer });
const pkg  = await sdk.package(original, { checkpoint? });         // EvidencePackage (complete|partial)
const view = await sdk.load(pkg);                                   // read-only; VerificationReport; no signer
```

- **Signer** (`OriginalsSigner`): `{ verificationMethod, cryptosuite, sign(request) }`. `request` carries the parsed entry and a human-readable summary (P5.11). There are local Ed25519 and secp256k1 (BIP340) signers for tests and an external-signer adapter for Turnkey.
- **Store** (`OriginalsStore`): a durable commit contract (P6.2). It stages bytes and the entry, then atomically advances the head. It ships with memory and Node-fs implementations; the fs one uses write-temp + fsync + rename of the head pointer. Recovery on open returns either the prior head or the fully committed one.
- **Conflict semantics**: an edit names its parent. If the parent has moved the result is `StaleParent`, with no rebase (P4.5, P6.4). An identical accepted retry returns the existing checkpoint.
- **Errors**: `OriginalsError extends StructuredError`, with `category ∈ { invalid-evidence, incomplete-evidence, unsupported-profile, unauthorized-key, author-binding, stale-parent, fork, deactivated, unavailable-bytes, limit-exceeded }` (section 6's suggested categories) plus a stable `code`. It replaces `CelError`.

## 2. Provisional choices (all marked `PROVISIONAL` in code and docs)

### 2.1 Asset log entry (D1, D4)

```jsonc
{
  "versionId": "2-QmEntryHash…",
  "versionTime": "2026-10-18T12:00:01.250Z",    // milliseconds (D5; VH-Log PR 8, owner decision)
  "parameters": {},                             // genesis: { "method": "originals:1.0", "scid": "…" }
  "state": {
    "id": "did:vh:<SCID>",                      // "did:vh:{SCID}" in the preliminary genesis
    "operation": "update",                      // create | update | publish | migrate | deactivate
    "author": {
      "did": "did:webvh:…",                     // fixed at genesis (P5.8)
      "verificationMethod": "did:webvh:…#orig-1",
      "versionId": "5-Qm…"                      // did:btco: inscription id (P5.13)
    },
    "asset": {                                  // the full asset state, never a delta (D1)
      "name": "Harbor at dawn",
      "metadata": { … },                        // absent ⇔ removed (P4.6)
      "status": "active",                       // "deactivated" ⇔ parameters.deactivated (P6.5)
      "resources": [ { "id": "photo", "mediaType": "image/jpeg", "size": 123456,
                       "digest": "zQm…" } ],     // multibase base58btc of a sha2-256 multihash
      "aliases": []                             // ≤1 did:webvh, ≤1 did:btco
    },
    "transitions": [ { "resource": "photo", "from": "zQmH1…", "to": "zQmH2…" } ]
  },
  "proof": [ { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022",
               "verificationMethod": "did:webvh:…#orig-1",
               "proofPurpose": "assertionMethod", "proofValue": "z…" } ]
}
```

Rules this implies:
- `transitions` MUST list exactly the resources whose digest changed against the parent's asset state, and is empty at genesis except `from: null`. An unchanged digest does not advance a version (P4.4).
- The migrate entry names its sat by adding a `did:btco:` alias.
- `"originals:1.0"` implies `vh-log:1.0`. It permits SHA-256 only, and both `eddsa-jcs-2022` and `bip340-jcs-2025` for entry proofs. Witness proofs use `eddsa-jcs-2022` only, with did:key Ed25519 (see S3). It uses the PR 11 controller-keys rule and the PR 2 authoritative-source rule. It uses PR 8 to permit up to three fractional digits (milliseconds), with no minimum interval. Compact encoding (PR 10) is defined in Phase 4. There are no fork declarations: only Bitcoin settles a fork (Q5).
- Files: `did.jsonl` and `did-witness.json`, as did:vh requires at a `src` location.

### 2.2 Author keys and witness declaration in the author DID (D2, D3) — owner decision: ordinary DID constructs

The owner chose ordinary DID document constructs over a dedicated declaration (Q6):

- **Keys.** Any verification method embedded in the author DID document and listed under `assertionMethod` may sign the author's Originals. P5.3 is checked as: embedded (not a reference into another document), in `assertionMethod`, `controller` equal to the author DID, type `Multikey`, and a `publicKeyMultibase` that verifies the proof. A key that is also an update key of the author DID's own log is rejected, because that is still checkable (P5.11).
- **Witnesses.** The witness list and threshold are a standard DID service:

```json
{ "id": "<authorDid>#originals-witnesses", "type": "OriginalsWitnesses",
  "serviceEndpoint": { "threshold": 2, "witnesses": [ { "id": "did:key:z6Mk…" }, … ] } }
```

  At most one such service is allowed. An author DID without it declares no witnesses, so it cannot publish hosted Originals (P9.8). The service type and member names are PROVISIONAL.

This departs from the pinned text of P5.3, P5.11 and P9.9; see S8.

### 2.3 Evidence package (D4) — decided by owner: ZIP

The owner chose an **uncompressed ZIP** (fflate, already a dependency) with a fixed layout and a JSON manifest:

```
originals-evidence.json   { format: "originals-evidence/0.1", profile: "originals:1.0",
                            original: "did:vh:…", checkpoint: "7-Qm…", completeness: "complete"|"partial",
                            missing: [ {kind:"resource"|"identity"|"witness", …} ], limits: {…} }
asset/did.jsonl, asset/did-witness.json
authors/<sha256(authorDid)>/did.jsonl (+ did-witness.json | btco inscriptions)
resources/<digest>
```

Import rejects absolute paths, `..`, symlinks, duplicate names, and anything over the size, count or ratio bounds before extraction (P7.5). An in-memory object form of the same package is also exposed for API callers.

### 2.4 Limits (P7.7)

The provisional limits are 10,000 entries, 64 KiB per entry, 64 resources, 1,000 author-DID versions, a 16 MiB log file and a 64 MiB resource (configurable). Exceeding a limit produces a last-valid-prefix result labelled `limit-exceeded`.

### 2.5 Bitcoin representation (D6)

This is deferred to Phase 4 and will come to you as its own proposal before any writer code. The working idea is one inscription per publication on the anchoring sat:
- The body is `text/jsonl` of the full entries beyond the durable boundary.
- A compact delta encoding (PR 10) is added only if size demands it.
- Media inscriptions stay raw bytes bound by digest.

## 3. Phased delivery (spec §10), as stacked PRs against `main`

Each PR is test-first and driven by the §12 matrix. Every §12 row gets a stable test ID (`C12-NN`) in `packages/vh/tests/conformance/`. A row is either green or explicitly `todo(phase N)`, so coverage gaps stay visible.

| PR | Phase | Scope | Exit evidence |
|---|---|---|---|
| **1** | 0 | Pins manifest; rewrite `specs/README.md`, `CLAUDE.md`; replace `packages/sdk/V3.md` with `packages/sdk/ORIGINALS.md` (contract doc); §12 matrix registry with all rows `todo` | docs only |
| **2** | 1 | `@originals/vh` json/crypto/log/didvh: strict JSON, JCS, eddsa-jcs-2022, bip340-jcs-2025 (own impl on `@noble/curves` v2), VH-Log engine + hooks, plain did:vh | VH-Log spec example vectors (entry hash `QmQ6FJ4…`); W3C eddsa-jcs-2022 vectors; bip340 cross-check against `@did-btcr2/cryptosuite` as a **devDependency only**; Node ESM + browser-safety on new entries |
| **3** | 1 | `@originals/vh/originals` + `webvh` (verify only): state schema, transitions, author binding, derived DID doc, report, evidence codec | All local §12 rows (create/edit/verify, digest, genesis, chain, binding, method/relationship, JWK key, suites, two proofs, null/omit metadata, null name, counters, unchanged digest, resource set, deactivation agreement, duplicate keys, unsigned field, unlisted digest alg, limits, archive traversal, generic resolver rejection, derived doc) |
| **4** | 1 | SDK local slice: `create`/`edit`/`deactivate`/`package`/`load`, drafts, durable store, signer contract, new CLI (`originals`) | Fresh-process test: package in one process, verify in another with no key and network disabled; interrupted-commit test; signer-rejection test |
| **5** | 1 | **Deletion**: `packages/cel` entirely; SDK `v3/`, `lifecycle/`, `migration/`, `kinds/`, `cel/cli/`, `examples/`, `playground/`, previous-SDK tests and `docs/history/previous-sdk`; landing switched to the new local API (see Q4 for hosted/Bitcoin routes) | Full repo build/typecheck/lint/test green; `verify:esm`, `verify:browser` |
| **6** | 2 | Author-DID rotation and deactivation, incomplete identity evidence, freshness policy and retained versionIds, comparing copies, forks reported as unresolved conflicts (Q5) | §12 rows: removed key (unwitnessed), added key without asset entry, stale author history, old prefix as current, divergent branches, older-prefix import |
| **7** | 3 | Witnesses: reference witness (P9.8 obligations, 60 s freshness, last-approved tracking), witness client, publish entry (activate witnesses + did:webvh alias, P3.6 two-way binding), hosted layout, exact-snapshot public reader, P9.7 serving headers | Witness rows; hosted mixed snapshot; alias both directions; SSRF/redirect/size rows |
| **8** | 3 | `@originals/auth`: separate Originals key (P5.11) + declaration service on author DID; landing hosted path; Boop adapter notes (Boop repo is out of this repo — documented, not changed) | auth tests; landing hosted journey |
| **9** | 4 | Bitcoin representation proposal → then did:btco (author + alias), sat assembly (P9.13), inscription-time checks (P9.15), anchor selection (P9.16), ownership report (P9.11) against fixtures | Bitcoin §12 rows on fixtures |
| **10** | 4 | Writer/provider: prepare/submit/retry/durable boundary, landing `server/bitcoin.ts` reconciliation | **Real Core 31.1 / ord 0.29.0 regtest** journey incl. faults; no mainnet/testnet spending |

Each PR is registered with `link_pull_request` and nothing gets merged without your go-ahead.

## 4. Spec findings (rule ID → issue → proposed fix)

- **S1 — resolved by the owner (Q5): only Bitcoin settles forks.** *Where:* P6.6 against VH-Log "Comparing Copies of a Log".
  - *Issue:* VH-Log says a resolver **MUST** fail resolution when two verified copies diverge. P6.6 instead lets a signed declaration make one branch current, and no VH-Log hook permits that.
  - *Decision:* forks that are not on Bitcoin are not settled. A verifier reports them as an unresolved conflict (`logForked`), and no branch is current. The only thing that settles a fork is the Bitcoin authoritative source (VH-Log PR 2, P9.13, P9.16). Abandonment declarations are dropped.
  - *Spec edits needed:* remove the declaration mechanism from P6.6, so that divergent valid branches are always an unresolved conflict and are never current. Drop the declaration clauses from P9.16 and D5. Replace §12 rows C12-24 and C12-25 with "fork not on Bitcoin: unresolved conflict, no branch current", and drop C12-40.
- **S2 — resolved by the owner (Q7): reworded.** *Where:* P9.9, "An asset log's witness parameter MUST equal the declaration in the author DID version that the entry references".
  - *Issue:* read literally, this rule breaks things in two ways. Every Original by an author who declares witnesses would need witnesses active, so no local Originals would be possible for that author. And the migrate entry, which **MUST** set `{}`, could never comply.
  - *Fix (accepted by the owner, Q7):* reword it as "An entry that sets the witness parameter to a value other than `{}` MUST set it equal to the declaration in the author DID version the entry references." The rest of P9.9 stays. Implementation proceeds on the reworded rule.
- **S3 — not blocking (witness-proof suites).** *Where:* P5.12 and VH-Log PR 3.
  - *Issue:* PR 3 requires each method value to state which suites are allowed for entry proofs and which for witness proofs. The spec names only the entry suites.
  - *Fix:* add "witness proofs: `eddsa-jcs-2022`" under `originals:1.0`. That is the provisional choice here.
- **S4 — not blocking (did:webvh alias identifier).** *Where:* §3, the `did:webvh:<SCID>:example.com/photo` example, and P3.6.
  - *Issue:* the alias log has its own SCID, but the example reads as if it reuses the did:vh SCID. The spec also doesn't say how the alias document "points to" the did:vh.
  - *Fix:* the provisional choice is `alsoKnownAs: ["did:vh:…"]` in the alias document, plus a note that the SCIDs differ.
- **S5 — editorial.** *Where:* P9.10, "an ordinary entry under P5.10".
  - *Issue:* the reference should be P5.9, or simply "an ordinary entry".
  - *Fix:* correct the cross-reference.
- **S6 — not blocking (bip340-jcs-2025 is v0.1).** *Where:* the cryptosuite draft.
  - *Issue:* the algorithm text encodes `proofValue` as base58btc multibase, but the data-model section says base64url. The draft also gives 33-byte compressed secp256k1 Multikeys (`0xe701`) without saying how to convert them to x-only keys for BIP340.
  - *Fix:* follow the algorithm text (`z…`) and BIP340 lift-x, and pin interop against `@did-btcr2/cryptosuite`.

- **S7 — not blocking (VH-Log worked example).** *Where:* VH-Log, "Generate Entry Hash".
  - *Issue:* the example preliminary entry does not hash to the stated entry hash `QmQ6FJ4fk2xheSSQoEjVpTgx9AQPKhJgtR9hn1nr4EeCrZ`. JCS, a sha2-256 multihash and base58btc give `QmXoHG2Z6Hg1kmryaRxcqgzF6nv2vgLZnYHvGirL9t2a8U`. The algorithm text is unambiguous, and logs from `didwebvh-ts` verify under it.
  - *Fix:* regenerate the example upstream. Until then it is not used as a test vector.
- **S8 — owner decision Q6 departs from P5.3, P5.11 and P9.9 (author keys).**
  - *Issue:* the pinned text requires an "Originals declaration" listing the keys allowed to sign Originals. The owner chose ordinary DID constructs instead: `assertionMethod` for keys and a service entry for witnesses.
  - *Consequence:* a verifier can no longer check that an author key is used only for Originals. P5.11's protection against a host application tricking a general-purpose assertion key into signing Originals entries then rests on signer discipline alone, not verification. The section 11 row "Malicious host application" weakens accordingly.
  - *Spec edits needed:*
    - P5.3: "is listed under assertionMethod" (drop "and in that version's Originals declaration").
    - P5.11: "SHOULD be used only for Originals entries". Keep "MUST NOT be an updateKey of the author DID's own log".
    - P9.9: the declaration is the witness list and threshold, carried in a DID service.
    - §12 C12-60: "Author key not under assertionMethod: author binding failure".
    - D2 and D3: record the encoding.

## 5. bip340-jcs-2025: build vs. depend

The choice is to **implement it in-house on `@noble/curves` v2 (`schnorr`)** and use `@did-btcr2/cryptosuite` only as a dev-time cross-check. The package isn't suitable as a runtime dependency:
- It pulls `@web5/dids` and noble **v1**, while we're on v2.
- It is MPL-2.0.
- Its proof handling is tied to did:btcr2.

The algorithm itself is small: JCS, then `sha256(sha256(config) ‖ sha256(doc))`, then BIP340. Our own implementation stays browser-safe and dependency-free beyond noble.

## 6. Owner decisions (2026-10-18)

- **Q1 — did:webvh version for author DIDs.** Verify author DIDs with our own VH-Log engine under experimental did:webvh (PR 302, method value `did:webvh:1.0`). `@originals/auth` keeps `didwebvh-ts` for creating and updating author DIDs for now, and a compatibility test pins that our resolver accepts its output.
- **Q2 — package.** A new `@originals/vh` (`packages/vh`). `@originals/cel` is deleted in PR 5.
- **Q3 — evidence package.** An uncompressed ZIP, laid out as in 2.3. The format itself remains PROVISIONAL under D4.
- **Q4 — landing during the gap.** From PR 5 on, the landing's hosted and Bitcoin asset flows are switched off behind a flag until PRs 8 and 10 replace them. The old engine is not kept alive to serve them: after PR 5 only the new engine is in the tree.
- **Q5 — forks (S1).** Only Bitcoin settles forks. A fork that is not on Bitcoin is an unresolved conflict, and no branch is current. Abandonment declarations are dropped.
- **Q6 — author keys and witnesses (S8).** Use ordinary DID constructs: `assertionMethod` keys, plus a service entry for the witness list and threshold.
- **Q7 — witness parameter (S2).** The rewording in S2 is accepted.
- **Q8 — versionTime precision (D5).** Milliseconds, using VH-Log PR 8 with three fractional digits.
- **Q9 — the `brianorwhatever/vh` interop repository.** It holds a TypeScript VH-Log reference implementation and shared vectors pinned at `f2f9fda`. `@originals/vh` keeps its own engine, because it carries the PR 2–11 hooks, and joins that interop harness so the shared vectors check it.
- **Q10 — VH-Log PR 1.** It is treated as merged too (witnesses verify a candidate without its own witness threshold).
