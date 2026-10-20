# 011 — Replace CEL 3 with the Originals Protocol (VH-Log / did:vh)

Status: **approved by the owner on 2026-10-18**, with the recommendations for Q1–Q4 accepted (section 6). The provisional protocol choices in section 2 remain provisional until the spec decides them.

## 0. Pins

| Dependency | Pin | Notes |
|---|---|---|
| Originals Protocol | `aviarytech/originals-spec@1039c471c` (`master`) | Editor's Draft 0.1 with #34–#36 (Q5, Q6, Q15; #42 and #43 inside), #45 (editors, shared-host saves, identity continuity), #46 (an unanchored Original is never current), #47 (the newest known signer DID version), #48 (section 14 wire format) and #49 (the author adds and removes resources) merged; re-pinned from `051049d8b`. §12 has 159 rows; IDs are kept and the mapping is in `specs/README.md`. Open #50 (head `555ce24d3`: Bitcoin values and limits decided, 256 resources, row 160) is implemented |
| VH-Log | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` + PR 1 `a3e3627e`, PR 2 `0d5eb134`, PR 3 `3bcd0acb`, PR 8 `3770b574`, PR 9 `5552a668`, PR 10 `1867a2b1`, PR 11 `2fe380dbf` (keys and editors from a controller) | PRs treated as merged |
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
| `@originals/vh/log` | Generic VH-Log engine: SCID, entry hash, parameters (accumulation/activation), proofs, witness threshold, version selection, comparing copies with retained versionIds and minCopies (in PR 2, checked by the vh interop vectors). **Specialisation hooks** for: designated version param, permitted suites, versionTime precision (PR 8), controller keys and editors from a controller (PR 11, `ControllerKeys.editors`), authoritative source (PR 2), alternative encoding (PR 10), non-HTTPS locations (PR 9) | VH-Log + PRs |
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
          │  witness parameter ─▶ refused unless {} (no witnesses, Q14)
          │  authoritative-source hook (anchored) ─▶ sat assembly P9.13/P9.15/P9.16
          ▼
     Originals state rules (P4.x, P5.1, P5.8, P5.15–P5.18, P6.5, P9.10) ─▶ derived DID doc (P3.8)
          ▼
     VerificationReport { history, authorBinding, identityEvidence, resources,
                          ordering, assetFreshness, fork, aliases, anchoring, ownership,
                          validAsOf, historicallyAuthorizedOnly, current }

An unanchored Original is never `current` (P7.10): a valid one is reported
`validAsOf` its checkpoint with the signer DID versions relied on and when
they were obtained, and entries whose key was later removed, or any entry
after the author DID's deactivation, are `historicallyAuthorizedOnly` (P7.9).
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
- **Errors**: `OriginalsError extends StructuredError`, with `category ∈ { invalid-evidence, incomplete-evidence, unsupported-profile, unauthorized-key, author-binding, outside-grant, stale-parent, fork, deactivated, unavailable-bytes, limit-exceeded }` (section 6's suggested categories) plus a stable `code`. It replaces `CelError`.

## 2. Provisional choices (all marked `PROVISIONAL` in code and docs)

### 2.1 Asset log entry (D1, D4)

```jsonc
{
  "versionId": "2-QmEntryHash…",
  "versionTime": "2026-10-18T12:00:01.250Z",    // milliseconds (D5; VH-Log PR 8, owner decision)
  "parameters": {},                             // genesis: { "method": "originals:1.0", "scid": "…" }
  "state": {
    "id": "did:vh:<SCID>",                      // "did:vh:{SCID}" in the preliminary genesis
    "operation": "update",                      // create | update | deactivate; publishing and anchoring are updates
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
      "aliases": [],                            // ≤1 did:webvh, ≤1 did:btco
      "editors": [ { "did": "did:webvh:…bob", "name": false, "metadata": false,
                     "resources": ["photo"] } ]  // optional, 1–32 grants (P5.15)
    },
    // "editor": { "did", "verificationMethod", "versionId" } in an editor entry (P5.16)
    "transitions": [ { "resource": "photo", "from": "zQmH1…", "to": "zQmH2…" } ]
  },
  "proof": [ { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022",
               "verificationMethod": "did:webvh:…#orig-1",
               "proofPurpose": "assertionMethod", "proofValue": "z…" } ]
}
```

Rules this implies:
- `transitions` MUST list exactly the resources whose digest changed against the parent's asset state, and is empty at genesis except `from: null`. An unchanged digest does not advance a version (P4.4).
- There are no publish or migrate operations. Publication is an update that lists a did:webvh alias (P3.6); anchoring is an update that adds the sat's `did:btco:` alias, once and terminally (P9.10).
- Editors (P5.15–P5.18): the author grants editor DIDs the right to change the name, the metadata or named resources (`editors` above). An editor entry carries `editor` and is signed by the editor's own key, checked against the grant in its parent's state; only author entries change grants, aliases, lifecycle or parameters, anchor or deactivate. A grant never names the author's identity, the Original's own did:vh or any of its aliases.
- Shared-host saves (P6.7, P6.8): a host accepting entries from several signers compares the submitted parent with its head atomically, answers `accepted`, `already-accepted` (a byte-identical retry) or `stale-parent`, and never changes a submission; the SDK keeps a refused candidate, and `reconcile` has the caller sign a new candidate against the new head. It is serialization at one host, not consensus: forks published elsewhere stay unresolved (P6.6).
- `"originals:1.0"` implies `vh-log:1.0`. It permits SHA-256 only, and both `eddsa-jcs-2022` and `bip340-jcs-2025` for entry proofs. Asset logs use no witnesses (Q14); S3's witness-proof suite applies only if that is ever revisited. It uses the PR 11 controller-keys rule and the PR 2 authoritative-source rule. It uses PR 8 to permit up to three fractional digits (milliseconds), with no minimum interval. Compact encoding (PR 10) is defined in Phase 4. There are no fork declarations: only Bitcoin settles a fork (Q5).
- Files: `did.jsonl`, as did:vh requires at a `src` location (no `did-witness.json`, Q14).
- Further PROVISIONAL rules, as implemented in PR 3:
  - Resource ids are 1–64 characters from `A-Z a-z 0-9 . _ -`. Existing resources keep their order; an author entry appends added resources and may remove resources while one remains, an editor entry neither adds nor removes, and a resourceID is never used again in the Original (P4.1, P5.16, P14.5; originals-spec #49).
  - Media types are RFC 6838 `type/subtype`, without parameters. `size` is the exact byte length.
  - A descriptor's `mediaType` or `size` changes only together with its digest.
  - A deactivation changes no resource.
  - `transitions` lists resources in resource order.
  - The derived document's `#files` service has type `OriginalsFiles`, and its `serviceEndpoint` maps each resource id to its current descriptor.
  - `alsoKnownAs` is omitted while there are no aliases.

### 2.2 Author keys and witness declaration in the author DID (D2, D3) — owner decision: ordinary DID constructs

The owner chose ordinary DID document constructs over a dedicated declaration (Q6):

- **Keys.** Any verification method embedded in the author DID document and listed under `assertionMethod` may sign the author's Originals. P5.3 is checked as: embedded (not a reference into another document), in `assertionMethod`, `controller` equal to the author DID, type `Multikey`, and a `publicKeyMultibase` that verifies the proof. A key that is also an update key of the author DID's own log is rejected, because that is still checkable (P5.11).
- **Witnesses — superseded by Q14.** Asset logs use no witnesses, so author DIDs declare none for Originals. The design below was the PR 7a proposal and is kept for the record:

```json
{ "id": "<authorDid>#originals-witnesses", "type": "OriginalsWitnesses",
  "serviceEndpoint": { "threshold": 2, "witnesses": [ { "id": "did:key:z6Mk…" }, … ] } }
```

  At most one such service is allowed. An author DID without it declares no witnesses, so it cannot publish hosted Originals (P9.8). The service type and member names are PROVISIONAL.

This departs from the pinned text of P5.3, P5.11 and P9.9; see S8.

### 2.3 Evidence package (D4) — decided by owner: ZIP

The owner chose an **uncompressed ZIP**, written and read by the SDK's own strict stored-only codec (`packages/sdk/src/originals/zip.ts`; no compression library), with a fixed layout and a JSON manifest. Entries are sorted, dated 1980-01-01, with the UTF-8 flag and mode 0100644, so the same contents give the same bytes (P14.10, PROVISIONAL #48):

```
originals-evidence.json   exactly { format: "originals-evidence/0.1", profile: "originals:1.0",
                            original: "did:vh:…", checkpoint: "7-Qm…", head: "9-Qm…",
                            completeness: "complete"|"partial",
                            missing: [ {kind:"resource", resource, version, digest, versionId}
                                     | {kind:"identity", did, role:"author"|"editor"} ] }
asset/did.jsonl
signers/<hex sha256(did)>/did.jsonl (+ did-witness.json where that DID's method has witnesses)
resources/<digest>
```

`head` is the packager's head, so a package of an earlier checkpoint is never taken for the latest state (P7.6). There is no `limits` member and no asset witness file (asset logs have no witnesses, P9.8). Each signer that signed an entry (the author, and each editor, P7.1) has its did:vh or did:webvh history under `signers/`; nothing about did:btco is packaged, because did:btco signers are read from Bitcoin (P9.18). Import rejects absolute paths, `..`, symlinks, duplicate names, compressed or encrypted entries, and anything over the entry-count (20,000) or total-size (512 MiB) bounds before extraction (P7.5). `EvidenceContents` is the in-memory form of the same package.

### 2.4 Limits (P7.7)

The limits (P14.13), decided by the owner on 21 October 2026 (D6; spec PR #50 (open)), are 10,000 entries, 65,536 bytes per entry measured as the UTF-8 length of its stored line without the line feed, 256 resources at one time, 32 editor grants, 1,000 signer-DID versions, a 16 MiB fetched log file, a 64 MiB fetched resource and 15 s per fetch (the fetch caps are configurable). Exceeding a limit produces a last-valid-prefix result labelled `limit-exceeded`.

### 2.5 Bitcoin representation (D6)

Proposed and accepted (owner decision Q15): see [plan 012](012-bitcoin-representation.md).
In short: the anchoring entry is an ordinary update that adds the sat's
did:btco alias; every inscription on the anchoring sat carries one complete
entry as `application/vnd.originals.vh+jsonl`, with no did:btco metadata; the
history before the anchor comes from a copy and chains to it; Bitcoin is the
authoritative source from the anchor on; inscriptions count at 1 confirmation
with their depth reported; did:btco author DIDs follow the method spec v0.2.0.
Spec findings S10–S12 are in plan 012 section 2.

## 3. Phased delivery (spec §10), as stacked PRs against `main`

Each PR is test-first and driven by the §12 matrix. Every §12 row gets a stable test ID (`C12-NN`) in `packages/vh/tests/conformance/`. A row is either green or explicitly `todo(phase N)`, so coverage gaps stay visible.

| PR | Phase | Scope | Exit evidence |
|---|---|---|---|
| **1** | 0 | Pins manifest; rewrite `specs/README.md`, `CLAUDE.md`; replace `packages/sdk/V3.md` with `packages/sdk/ORIGINALS.md` (contract doc); §12 matrix registry with all rows `todo` | docs only |
| **2** | 1 | `@originals/vh` json/crypto/log/didvh: strict JSON, JCS, eddsa-jcs-2022, bip340-jcs-2025 (own impl on `@noble/curves` v2), VH-Log engine + hooks, plain did:vh | VH-Log spec example vectors (entry hash `QmQ6FJ4…`); W3C eddsa-jcs-2022 vectors; bip340 cross-check against `@did-btcr2/cryptosuite` as a **devDependency only**; Node ESM + browser-safety on new entries |
| **3** | 1 | `@originals/vh/originals` + `webvh` (verify only): state schema, transitions, author binding, derived DID doc, builders, verification report (the evidence codec moved to PR 4, with packaging) | All local §12 rows (create/edit/verify, digest, genesis, chain, binding, method/relationship, JWK key, suites, two proofs, null/omit metadata, null name, counters, unchanged digest, resource set, deactivation agreement, duplicate keys, unsigned field, unlisted digest alg, limits, archive traversal, generic resolver rejection, derived doc) |
| **4** | 1 | SDK local slice: `create`/`edit`/`deactivate`/`package`/`load`, drafts, durable store, signer contract, evidence package codec (ZIP), new CLI (`originals`) | Fresh-process test: package in one process, verify in another with no key and network disabled; interrupted-commit test; signer-rejection test |
| **5** | 1 | **Deletion**: `packages/cel` entirely; SDK `v3/`, `core/`, `lifecycle/`, `migration/`, `cel/`, `examples/`, `playground/`, `verify/`, previous-SDK tests and `docs/history/previous-sdk`. The non-history modules stay (`vc/`, `storage/`, `events/`, `kinds/`, `resources/`, DID, Bitcoin and providers; owner decision Q12), with the cel utilities they need moved into the SDK. The landing runs on the new SDK: signed-in authors sign with their did:webvh `#key-1` (auth pulled forward from PR 8, Q12), and signed-out visitors use a browser-local did:vh. Hosted, Bitcoin, `/explore` and `/me` are off (Q4) | Full repo build/typecheck/lint/test green; `verify:esm`, `verify:browser` |
| **6** | 2 | Author-DID rotation and deactivation, incomplete identity evidence, freshness policy, retained versionIds per Original and author DID, forks reported as unresolved conflicts (Q5) | §12 rows: removed key (unwitnessed), added key without asset entry, stale author history, old prefix as current, divergent branches, older-prefix import |
| **7a** | 3 | No witnesses (Q14, S9): the asset log refuses a witness parameter; witness-only §12 rows become not-applicable. A witness design (declaration, reference witness, witness service) was built in PRs #961 and #963 and withdrawn | Witness parameter refused; registry check for not-applicable rows |
| **7b** | 3 | Hosting: publication as an update entry listing the did:webvh alias (P3.6 two-way binding; no publish operation), hosted layout, exact-snapshot public reader, P9.7 serving headers, `@originals/vh/fetch` | Hosted mixed snapshot; alias both directions; SSRF/redirect/size rows |
| **8** | 3 | `@originals/auth` and the landing's hosted path: author-controlled alias on originals.build (Q13), landing server hosting the layout with P9.7 headers, publish flow behind `hostedPublication` (off); Boop adapter notes (Boop repo is out of this repo — documented, not changed) | auth tests; landing hosted journey on fixtures |
| **8b** | 2 | Identity continuity: a did:webvh signer that moves under portability (P5.14), `identityFetch` | §12 rows C12-132 to C12-138 |
| **8c** | 2 | Editors (P5.15–P5.18): grants in the asset state, editor entries signed by editors' own DIDs, `outside-grant` | §12 rows C12-113 to C12-124 (unanchored parts) |
| **8d** | 3 | Shared-host saves (P6.7, P6.8): `sign`, `submit`, `refused`, `sync`, `reconcile`; the landing's verifying submit route | §12 rows C12-125 to C12-131 |
| **8e** | 2, 3 | Re-pin to originals-spec master `051049d8b`: an unanchored Original is never current, valid as of its checkpoint (P7.10, #46); historically authorized only (P7.9); #48's provisional wire format (`signers/`, no asset witness file, UTF-8 entry size, 64 MiB resource fetch cap) | §12 rows C12-22, C12-48, C12-140 to C12-145, C12-150, C12-152, C12-153 |
| **8f** | 1, 2 | Re-pin to originals-spec master `1039c471c` (#47–#49) with open #50: the author adds and removes resources, editors cannot, resourceIDs are never reused (P4.1, P4.4, P5.15, P5.16, P14.4); editors move into the VH-Log engine as VH-Log PR 11's "Editors from a Controller" hook [S25]; up to 256 resources (P14.13) | §12 rows C12-16, C12-154 to C12-160 |
| **9a** | 4 | Bitcoin verifier on fixtures (plan 012): anchoring entry and alias rules, assembly over sat snapshots supplied as evidence (no Bitcoin `src` yet; plan 012 §3.4), chain order, inscription time, P9.15 for did:vh/did:webvh authors, anchors and conflicting anchors, ownership report, reorg reporting | Bitcoin §12 rows on recorded fixtures |
| **9b** | 4 | did:btco author DIDs in the Originals verifier per the method spec v0.2.0 (CBOR metadata, chain order, terminal deactivation) | §12 rows 58–61 |
| **9c** | 4 | The SDK's legacy did:btco resolver and writer (`BtcoDidResolver`, `DIDManager.migrateToDIDBTCO`) moved to method v0.2.0 metadata, replacing the content-based convention (Q15 C) | Legacy did:btco tests on v0.2.0 |
| **10** | 4 | SDK writer: `prepareEntryInscription` on the anchoring sat through the sat inscription builder and recovery store, `readAnchored`, durable boundary and retries (P9.4–P9.6) | **Real Core 31.1 / ord 0.29.0 regtest** journey (`scripts/regtest/originals-anchor.ts`): anchor, reinscribe, wrong sat, reorg, crash and resume, uninscribed entry; no mainnet/testnet spending |
| **10b** | 4 | Landing: anchoring behind `bitcoinAnchoring` (off); `server/bitcoin.ts` reinscription of the Original's own sat in place of its refusal of inscribed inputs, and reconciliation of Originals inscriptions | Landing regtest journey |

Each PR is registered with `link_pull_request` and nothing gets merged without your go-ahead.

### 3.1 Publishing `@originals/vh` (owner decision Q11, 2026-10-18)

`@originals/vh` is a public package, published with the SDK's releases.
`@originals/sdk` depends on it from PR 4 on. Releasing still needs the owner's
approval. Before the first release that includes `@originals/vh`, the owner
must also confirm npm trusted publishing for the new package
(`docs/RELEASE_TOKEN_ROTATION.md`). npm may need the package to exist before
a trusted publisher can be registered for it.

## 4. Spec findings (rule ID → issue → proposed fix)

- **S1 — resolved by the owner (Q5): only Bitcoin settles forks.** *Where:* P6.6 against VH-Log "Comparing Copies of a Log".
  - *Issue:* VH-Log says a resolver **MUST** fail resolution when two verified copies diverge. P6.6 instead lets a signed declaration make one branch current, and no VH-Log hook permits that.
  - *Decision:* forks that are not on Bitcoin are not settled. A verifier reports them as an unresolved conflict (`logForked`), and no branch is current. The only thing that settles a fork is the Bitcoin authoritative source (VH-Log PR 2, P9.13, P9.16). Abandonment declarations are dropped.
  - *Spec edits needed:* remove the declaration mechanism from P6.6, so that divergent valid branches are always an unresolved conflict and are never current. Drop the declaration clauses from P9.16 and D5. Replace §12 rows C12-24 and C12-25 with "fork not on Bitcoin: unresolved conflict, no branch current", and drop C12-37 (C12-40 before the re-pin).
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
    - P9.9: superseded by S9 (no witnesses).
    - §12 C12-52 (C12-60 before the re-pin): "Author key not under assertionMethod: author binding failure".
    - D2 and D3: record the encoding.

- **S9 — resolved in the spec (originals-spec PR #33, merged 2026-10-20; now pinned): owner decision Q14, no witnesses.**
  - *Issue:* once activated, witnesses cannot be removed (P9.9), and every later entry, including the one that replaces them and the anchoring entry (P9.10), needs threshold approval from the current set. Losing a threshold of witnesses permanently freezes every hosted Original that uses them. Originals witnesses are also stateful services beyond did:webvh witnesses (60-second author DID reads, a last-approved ledger, independence from the host).
  - *Decision:* asset logs do not use witnesses. Unanchored Originals have claimed ordering only; Bitcoin anchoring gives proven ordering and a single history. Author DIDs keep their own method's witnesses.
  - *Accepted consequences:* a stolen author key can create a branch before its removal (never current after removal, P7.9; an unresolved fork until anchoring, Q5); the first valid anchor wins (P9.16), so a key thief holding a sat can win that race; a host can serve an old prefix to a first-time reader (retained versionIds protect repeat readers, P7.8).
  - *Spec edits needed:* P9.8 (drop the hosted-witness requirement and witness obligations); P9.9 (drop the witness list; an asset log entry that sets a non-empty witness parameter MUST be rejected); P9.10 (drop the witnessed-migrate branch); P9.16 (every anchor is unwitnessed); P5.10 and P6.5 (drop the witness-refusal clauses); P7.6 (drop the activation clause); section 2, D3 and section 11 (ordering is claimed off-chain, proven on anchoring); section 12 (rows C12-35, 36, 39, 42, 53, 54, 55, 56 and 71 moot; a new row for a refused witness parameter). Sent to the spec thread on 2026-10-19.

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
- **Q9 — the `brianorwhatever/vh` interop repository.** It holds a TypeScript VH-Log reference implementation and shared vectors pinned at `f2f9fda`. `@originals/vh` keeps its own engine, because it carries the PR 2–11 hooks, and runs the shared vectors in this repository. Registering it in that repository's harness is not planned (owner, 2026-10-18).
- **Q10 — VH-Log PR 1.** It is treated as merged too (witnesses verify a candidate without its own witness threshold).
- **Q11 — `@originals/vh` on npm.** Public, published with the SDK's releases (section 3.1).
- **Q12 — PR 5 shape (2026-10-18).** One PR. The non-history SDK modules stay. The landing's signed-in authoring moves forward from PR 8: the user's did:webvh already keeps its Turnkey authorship key (`#key-1`, assertionMethod) separate from its identity update key (`#key-0`), so it signs Originals directly.
- **Q13 — hosted landing (2026-10-19).** Signed-in authors' aliases live on originals.build, and each alias log's update key is in the author's Turnkey wallet (P3.7). `hostedPublication` stays off until the owner's public-host proof passes. (Its witness-service part is superseded by Q14.)
- **Q14 — no witnesses (2026-10-19; S9).** Asset logs do not use witnesses. Anyone who needs proven ordering anchors on Bitcoin. This withdraws the PR 7a witness design and the PR 8a witness service, supersedes Q7 for asset logs, and leaves Q13's alias decision in place.
- **Q15 — Bitcoin representation (2026-10-20; plan 012).** Anchoring inscription carries the anchoring entry only; full entries, no deltas yet; did:btco author DIDs follow the method spec v0.2.0; inscriptions count at 1 confirmation with their depth reported.
