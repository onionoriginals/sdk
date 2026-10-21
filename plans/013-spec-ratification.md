# 013 — Spec ratification inventory: what the SDK chose where the spec is open

Status: **inventory for the spec owner.** It records the choices the Originals implementation made where the spec leaves a decision open or marks one provisional, so they can be ratified, changed or rejected in one originals-spec PR. It changes no code and no behaviour. Every item cites the code at a stated revision; anything not checked is marked "not determined".

## 0. Sources

| Layer | Revision | Notes |
|---|---|---|
| Local/web: vh core, SDK local workflow, evidence packages, hosting, continuity, editors, shared-host saves | `onionoriginals/sdk` `a07210cb` (worktree `wt-docs`, branch `docs/013-spec-ratification`) | Called **L** below. |
| Bitcoin verifier and did:btco authors | branch `fix/a432-btco` at `3c982ca1` | Called **V**. It is being restacked onto L; the semantics are the same. It forks from L's history at `ca7c4e6a`, so it lacks L's editors and continuity work. |
| Bitcoin writer, catch-up and durable recovery | branch `fix/975-durable` at `7b2f6918` | Called **W**. Forks at `ca7c4e6a`; it does not contain V's full-log anchoring. Pending changes are listed in section 6.3. |
| Spec in the SDK pin | `aviarytech/originals-spec@a432aa6` (`specs/README.md:17` at L) | Section 12 has 139 rows; L's `specs/originals-conformance.json` holds C12-01…C12-139 in that numbering. |
| Spec master | `9058816` | Section 12 is shorter. The local copy has 112 matrix rows; the request gives 113, and the difference is not reconciled here. C12 citations will move when the pin moves. Nothing is renumbered here. |
| Editor proposal | spec PR #45 | Master drops P5.14–P5.18, P6.7, P6.8 and the "change outside the editor's grant" category of section 6. The SDK cites them at a432. |

V and W still carry `specs/originals-conformance.json` pinned to `b8e8323` (84 rows). Their tests cite C12-NN in that numbering, plus "row NN" in a432 numbering.

Path shorthand: `vh/` = `packages/vh/src/`, `sdk/` = `packages/sdk/src/`, `landing/` = `apps/landing/`. A line number is at the revision named in the row or heading.

Two owner decisions are coming. Section 8 lists the places they will affect, with no change made:

- an unanchored Original is never reported `current`, only "valid as of a checkpoint";
- key custody is out of scope.

## 1. D1 — asset state, method value, DID document, checkpoints, deactivation (L)

### 1.1 Entry state schema

Every member is required unless marked optional. Unknown members anywhere in the state are rejected (`STATE_MEMBERS`, `vh/originals/state.ts:99-105`, P5.7).

| Member | Type and rule | Code |
|---|---|---|
| `state.id` | `"did:vh:<SCID>"`; `did:vh:{SCID}` in the preliminary genesis | `state.ts:303`; `build.ts:87` |
| `state.operation` | `"create"` at genesis, then `"update"` or `"deactivate"`. `"migrate"` is reserved and refused as `unsupported-profile` / `STATE_OPERATION_UNSUPPORTED`. There is no `publish` operation: publishing is an update that lists a did:webvh alias. | `state.ts:26-32`, `:306-309` |
| `state.author` | `{ did, verificationMethod, versionId }`, all strings, exact members. `did` is fixed at genesis (`AUTHOR_DID_CHANGED`). | `state.ts:65-69`, `:146-163`; `profile.ts:74-77` |
| `state.editor` (optional) | Same shape as `author`. Present only in an editor entry (section 9). | `state.ts:72`, `:85` |
| `state.asset` | The full asset state, never a delta | `state.ts:54-62`, `:220-249` |
| `asset.name` | String of 1–1,024 UTF-16 code units (`ORIGINALS_LIMITS.nameLength`). It cannot be null (P4.6). | `state.ts:222-224` |
| `asset.metadata` (optional) | JSON object. Absent means removed; `null` on input removes it (P4.6). | `state.ts:225`; `build.ts:110,115` |
| `asset.status` | `"active"` or `"deactivated"`. It must agree both ways with `operation` and the VH `deactivated` parameter (P6.5). | `state.ts:226`, `:325-328` |
| `asset.resources` | Array of descriptors; at least one at genesis; at most 64. The id list and its order are fixed after genesis (P4.1). | `state.ts:227-234`, `:331-344` |
| descriptor | `{ id, mediaType, size, digest }`, exact members. `id` matches `^[A-Za-z0-9._-]{1,64}$`. `mediaType` is an RFC 6838 `type/subtype` with no parameters, ≤127+1+127 characters. `size` is a safe non-negative integer. `mediaType` and `size` change only together with `digest`. | `state.ts:133-144`, `:336-341` |
| `asset.aliases` | Array of DIDs. At L: at most one did:webvh, none at genesis, it never disappears, and it moves only within its SCID. A did:btco alias is refused at L (`STATE_ALIASES_UNSUPPORTED`). At V: at most one did:webvh and one did:btco, and no did:webvh change after anchoring. | L `state.ts:235-246`, `:314-322`; V `state.ts:150-167`, `:204-226` |
| `asset.editors` (optional) | Editor grants; absent means none, and an empty list is refused (section 9). | `state.ts:47-61`, `:187-217` |
| `state.transitions` | `[{ resource, from: digest \| null, to: digest }]`. Exactly the resources whose digest changed, in resource order; `from: null` at genesis; empty on deactivation. | `state.ts:74-78`, `:284-291`, `:346-355` |

Parameters (VH-Log, via the specialisation):

- **Genesis** sets exactly `{ "method": "originals:1.0", "scid": … }` (`build.ts:95`).
- **Later entries** set `{}`, or `{ "deactivated": true }` to deactivate (`build.ts:151`).
- **Forbidden:** `updateKeys` and `nextKeyHashes`, because keys come from a controller (`PARAMETER_FORBIDDEN`, `vh/log/index.ts:294-295`).
- **Witness:** only `{}` is accepted (`WITNESS_NOT_PERMITTED`, `profile.ts:101-103`, Q14).
- **Editor entries** have empty parameters (`profile.ts:111-113`).
- **Accepted but unused:** the verifier still accepts `watchers` and `ttl` on author entries, because they are generic VH-Log parameters (`log/index.ts:218`, `:338-346`). The builders never set them.

### 1.2 Method value and versions

| Item | Choice | Code |
|---|---|---|
| Method value | `ORIGINALS_METHOD = "originals:1.0"`, the only value | `state.ts:12-13` |
| What it implies | `vhLog: "vh-log:1.0"`. `entrySuites` is `eddsa-jcs-2022` and `bip340-jcs-2025`. `witnessSuites` is `["eddsa-jcs-2022"]`, a dead entry because witnesses are refused. At most one proof (`maxProofs: 1`). `versionTime` allows 3 fractional digits. Keys are of kind `controller` (VH-Log PR 11). | `profile.ts:19-25`, `:66-70` |
| did:vh version | The extension does not name a did:vh version. A resolver applies did:vh `e0b7cba` with PR 3, and extension methods may not start with `did:vh:`. Plain `did:vh:1.0` (eddsa only) rejects an `originals:1.0` log by its method value. | `vh/didvh/index.ts:24-36`, `:105-113`, `:207-210` |
| Generic resolution | `resolveDidVh(did, { didLog, extensions: [originalsExtension(authors)] })` derives the document through the extension. `src` retrieval is `featureNotSupported`. | `didvh/index.ts:116-136`, `:203-223`; `profile.ts:144-146` |

Tests: `vh/tests/originals.test.ts` C12-70 (`:460`), C12-71 (`:468`), C12-65 (`:474`), C12-63 (`:260`), C12-72 (`:267`), C12-50 (`:493`); `vh/tests/didvh.test.ts`.

### 1.3 Derived DID document (P3.8)

`deriveDocument` (`profile.ts:127-141`) uses the last entry of the verified prefix:

```json
{ "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:vh:<SCID>",
  "controller": "<state.author.did>",
  "alsoKnownAs": ["<aliases…>"],
  "service": [{ "id": "did:vh:<SCID>#files", "type": "OriginalsFiles",
    "serviceEndpoint": { "<resourceId>": { "mediaType": "…", "size": 0, "digest": "z…" } } }] }
```

- `alsoKnownAs` is omitted while there are no aliases.
- There is no `verificationMethod`, `authentication` or `assertionMethod`, and no deactivated marker in the document.
- Editors do not appear.
- `serviceEndpoint` is a map of resource id to descriptor, not a URL, so the `#files` service of the did:vh does not locate bytes by itself. The did:webvh alias's implicit `#files` does (`vh/webvh/index.ts:120`).

Tests: C12-68 and C12-69 (`originals.test.ts:443`).

**Alternative:** spec section 3 says the did:vh "can locate the Original's files itself" through `#files`. A descriptor map does not do that. Either the spec accepts a descriptor map, or the service gains a URL (for example the alias's `#files` base) once published.

### 1.4 Exact-checkpoint resolution (P3.2)

The checkpoint is always addressed by its full `versionId`.

| API | Behaviour | Code |
|---|---|---|
| `verifyOriginal({ checkpoint })` | Selects that entry. An unknown checkpoint adds reason `checkpoint-not-found`; a non-head checkpoint adds `checkpoint-is-not-head`, so it is never `current`. | `vh/originals/verify.ts:43-44`, `:335-340` |
| `sdk.get(did, { checkpoint })` | `incomplete-evidence` / `CHECKPOINT_NOT_FOUND` when it is not a verified checkpoint | `sdk/originals/sdk.ts:543-551` |
| `sdk.package(did, { checkpoint })` | A package of that prefix. On load, `checkpoint !== head` adds `package-checkpoint-is-not-its-head`. | `sdk.ts:837-862`, `:885` |
| `resolveDidVh` options | `versionId`, `versionNumber` or `versionTime` (at most one). `versionTime` selects the last entry at or before it. | `didvh/index.ts:60-62`, `:119-123`; `log/index.ts:843-857` |

There is no DID URL query (`?versionId=`) parsing anywhere in `vh/` or `sdk/originals/`.

Tests: `originals.test.ts:85`; `sdk/tests/unit/originals/evidence.test.ts:57`.

### 1.5 Deactivation history

- The deactivating entry is terminal: an entry after it fails with `deactivated` / `ENTRY_AFTER_DEACTIVATION` (`log/index.ts:435`).
- `OriginalsReport.deactivated` is the log's flag (`verify.ts:157`, `:380`). `report.state.status` is the selected checkpoint's.
- `resolveDidVh` returns `didDocument: null` when the log is deactivated and no version is selected, and `didDocumentMetadata.deactivated` (`didvh/index.ts:179-192`). An earlier version still resolves to its document.
- No separate list of deactivation events is exposed. Under the current rules it would hold at most one entry, the head.

Tests: C12-21 (`originals.test.ts:240`, `sdk.test.ts:88`), C12-76 (`originals.test.ts:231`).

## 2. D3 — identity versions in evidence packages

| Item | Choice | Code |
|---|---|---|
| Which identities | Every signer DID the packaged prefix names: the author and each editor of an editor entry | L `sdk.ts:837-845`; `evidence.ts:119-142` |
| Path | `authors/<hex(sha256(utf8(did)))>/did.jsonl`, the signer DID's whole log as the SDK holds it (not truncated to the version named), with `retrievedFrom` stripped | `evidence.ts:57-59`, `:66-70`; `sdk.ts:842` |
| Witness file | `authors/<hex>/did-witness.json` when the evidence has one (did:webvh witnesses are allowed for author DIDs) | `evidence.ts:69`, `:135-136` |
| Format | VH-Log JSON Lines, UTF-8 (fatal decoding) | `evidence.ts:51`, `:77-83` |
| Strictness | A file under `authors/` that belongs to no signer the log names is refused (`EVIDENCE_LAYOUT`) | `evidence.ts:138-142` |
| Missing declaration | `{ kind: "identity", did, role: "author" \| "editor" }` in `manifest.missing`; the package is then `partial` | `evidence.ts:25-28`; `sdk.ts:845`, `:858` |
| Freshness | Never taken from a package. `retrieved` only comes from `identityFetch` at the location P5.14 names. | `author.ts:38-44`; `sdk.ts:416-459` |
| did:btco at L | Refused as `unsupported-profile` / `AUTHOR_METHOD_NOT_IMPLEMENTED` | L `vh/originals/author.ts:75` |
| did:btco at V | **Not packaged.** `writeEvidence` skips authors without a `log`, and `package()` lists the DID as `missing` identity, so the package is `partial`. Sat evidence is never in a package; `load(zip, { bitcoin })` takes it separately. A did:btco version's `versionId` is its inscription id (PROVISIONAL). | V `sdk/originals/evidence.ts:65`; `sdk.ts:522-525`, `:545`; `vh/originals/author.ts:104-116` |

did:btco history at V (`vh/originals/author.ts:125-169`, `cbor.ts`):

- **Versions.** A version is a confirmed inscription that every index places on the DID's sat and network, whose metadata is strict CBOR with `id === did`. Versions are in chain order.
- **Deactivation.** The first `deactivated: true` ends the history.
- **Ordering.** P5.13: a version must precede the inscription in chain order (`bitcoin.ts:189-229`).
- **Limits.** At most 1,000 versions. CBOR depth is 64, and CBOR integers are ≤ 2^53−1.

Tests: L `evidence.test.ts`, `continuity.test.ts`, `editors.test.ts`; V `vh/tests/btco-author.test.ts` (C12-59, C12-60, C12-61; rows 98–102).

**Mismatch:** P9.18 says Bitcoin alone verifies a did:btco signer's identity, yet V calls such a package `partial` with that identity `missing`. Either a did:btco signer gets its own missing kind (for example "on Bitcoin"), or the package carries the sat reads.

## 3. D4 — entry fields, encodings, file names, package, limits

### 3.1 Entry fields and encodings

| Item | Choice | Code |
|---|---|---|
| Operation | `state.operation` (section 1.1) | `state.ts:26` |
| State commitment | The full asset state in each entry is the commitment. There is no separate hash member. | `state.ts:1-6`, `:80-88` |
| Resource transitions | `state.transitions` (section 1.1) | `state.ts:284-291` |
| Author reference | `state.author { did, verificationMethod, versionId }` | `state.ts:65-69` |
| Editor reference | `state.editor`, same shape | `state.ts:72` |
| Digest | `"z"` + base58btc(`0x12 0x20` ‖ SHA-256). Only base58btc multibase is accepted. A non-canonical encoding is `STATE_DIGEST`; another multihash code is `unsupported-profile` / `STATE_DIGEST_ALGORITHM`. | `state.ts:107-131`; `vh/crypto/index.ts:35-49` |
| Proof value | Multibase base58btc of the signature | `sdk.ts:694` |
| versionId / versionTime | VH-Log `<n>-<entryHash>`. versionTime: UTC, `Z` or `+00:00`, 0–3 fractional digits. | `log/index.ts:378-397` |

Tests: `originals.test.ts:504` (digest encoding), C12-80 (`:164`), C12-79 (`:221`), C12-73 (`:215`).

### 3.2 File names and discriminators

| Item | Choice | Code |
|---|---|---|
| Asset log | `did.jsonl`; compact JSON per line, `\n`-terminated, no blank lines | `log/index.ts:938-941`, `:652` |
| Asset witness file | `asset/did-witness.json` is still legal in packages and hosted layouts and is fetched optionally. Q14 makes it dead. | `evidence.ts:7,65,75`; `sdk.ts:951`; `landing/server/hosted-layout.ts:11` |
| Local store | `<root>/originals/<scid>/did.jsonl` | `sdk/originals/fs-store.ts:4` |
| Log discriminator | Genesis `parameters.method = "originals:1.0"` | `build.ts:95` |
| Package discriminator | Manifest `format: "originals-evidence/0.1"` (another value is `unsupported-profile` / `EVIDENCE_FORMAT`) and `profile: "originals:1.0"` (`EVIDENCE_PROFILE`) | `evidence.ts:22`, `:89-90` |
| Inscription discriminator (V) | Media type `application/vnd.originals.vh+jsonl` | V `vh/originals/bitcoin.ts:46` |

### 3.3 Evidence package (owner decision Q3: uncompressed ZIP)

- **Layout** (`evidence.ts:1-14`; only this layout is accepted, `:75`, `:113`):
  - `originals-evidence.json`
  - `asset/did.jsonl` (required), `asset/did-witness.json`
  - `authors/<64 hex>/did.jsonl|did-witness.json`
  - `resources/<digest>`, where the digest matches `z[1-9A-HJ-NP-Za-km-z]{1,120}` and is checked as a digest.
- **Manifest:** exactly `format`, `profile`, `original`, `checkpoint`, `head`, `completeness`, `missing` (`evidence.ts:30-40`, `:85-95`). It is written as 2-space-indented JSON with a trailing newline (`:63`).
  - `checkpoint` is the last entry of `asset/did.jsonl`.
  - `head` is the packager's head.
  - `missing` items are `{ kind: "resource", resource, version, digest, versionId }` or `{ kind: "identity", did, role? }`. Their shape is not validated on read; only `Array.isArray` is checked (`:93`).
- **Completeness:** the package is `complete` iff `missing` is empty and identity evidence is complete (`sdk.ts:858`). On load, a mismatch between the declaration and the verified result adds `manifest-completeness-mismatch`, and so do `manifest-original-mismatch` and `package-checkpoint-is-not-its-head`. Any of them clears `current` (`sdk.ts:883-888`).
- **ZIP codec** (`sdk/originals/zip.ts`):
  - Writing: stored only, names sorted, UTF-8 flag, file mode 0644, DOS date 1980-01-01 (`:47-49`, `:130-134`).
  - Refused on read, before extraction:
    - compression, encryption, data descriptors, symlinks and non-regular files;
    - duplicates, absolute paths, `..`, backslashes, NUL, and paths longer than 255;
    - multi-disk and ZIP64 archives;
    - a CRC mismatch.
  - Lines: `:53-66`, `:136-210`.
- **Plan drift:** plan 011 §2.3 lists a manifest `limits` member, a `witness` missing kind, and "btco inscriptions" under `authors/`. None is implemented.

Tests: `evidence.test.ts` C12-01 (`:27`), C12-10 (`:42`), C12-77 (`:87`), C12-83 (`:110-160`), and the manifest mismatch test (`:68`).

### 3.4 Every size, count and time limit

| Limit | Value | Where enforced | Category / code |
|---|---|---|---|
| Asset log entries | 10,000 | `verify.ts:272` via `log/index.ts:573-577`; pre-fetch `sdk/originals/retrieval.ts:39` | `limit-exceeded` / `LOG_TOO_LONG` (history `limit-exceeded`) |
| Entry size | 65,536, measured as `JSON.stringify(entry).length` (UTF-16 code units of the re-serialised entry, not bytes of the line) | `log/index.ts:415-416` | `limit-exceeded` / `ENTRY_TOO_LARGE` |
| Resources per state | 64 | `state.ts:228` | `limit-exceeded` / `STATE_TOO_MANY_RESOURCES` |
| Name length | 1,024 UTF-16 code units | `state.ts:222` | `invalid-evidence` / `STATE_NAME` |
| Resource id | 1–64 characters | `state.ts:133` | `STATE_RESOURCE` |
| Media type | ≤127 / ≤127 characters | `state.ts:135` | `STATE_RESOURCE` |
| Identity history (did:vh, did:webvh) | 1,000 versions (`maxVersions`) | `author.ts:87` | `limit-exceeded` / `LOG_TOO_LONG` |
| Identity history (did:btco, V) | 1,000 | V `author.ts:133`, `:158` | `invalid-evidence` / `AUTHOR_HISTORY_TOO_LONG` |
| Editors | 32 | `state.ts:23`, `:191` | `limit-exceeded` / `STATE_TOO_MANY_EDITORS` |
| Proofs per entry | 1 | `profile.ts:68`; `log/index.ts:455` | `invalid-evidence` / `PROOF_COUNT` |
| JSON nesting | 64 | `vh/json/index.ts:39`, `:90-91` | `limit-exceeded` / `JSON_TOO_DEEP` |
| JSON text size | Optional `maxBytes`; no default, and not set when verifying local logs | `json/index.ts:218-227` | `limit-exceeded` / `JSON_TOO_LARGE` |
| versionTime future skew | 300 s (`futureToleranceSeconds`) | `log/index.ts:496` | `VERSION_TIME_FUTURE` |
| ZIP entries | 20,000 (configurable `archiveLimits`) | `zip.ts:18`, `:154` | `invalid-evidence` / `ARCHIVE_TOO_MANY_ENTRIES` |
| ZIP total uncompressed | 512 MiB | `zip.ts:18`, `:192` | `invalid-evidence` / `ARCHIVE_TOO_LARGE` |
| ZIP path | 255 characters | `zip.ts:56` | `ARCHIVE_PATH` |
| One fetched file | 16 MiB; timeout 15 s | `vh/fetch/index.ts:21-25` | `unavailable-bytes` / `FETCH_TOO_LARGE`, `FETCH_TIMEOUT` |
| Retrieval budget (`loadPublished`, `retrieveHosted`) | 1,024 requests; bytes = archive `maxTotalBytes`; files = archive `maxEntries`; 16 MiB per file; 15 s per request; 120 s total | `sdk/originals/hosting.ts:48-80`; `retrieval.ts:80-140` | `limit-exceeded` / `RETRIEVAL_BUDGET_EXCEEDED` (`details.limit` ∈ requests, bytes, archive-bytes, archive-entries, time) |
| Identity fetch | 16 MiB, 15 s per file | `sdk.ts:430` | unavailable: freshness not established |
| Shared-host submit body (landing) | 12 MiB; 60 submits per minute per IP | `landing/server/originals-routes.ts:32`, `:81`, `:160` | HTTP 413 / 429 |
| Inscription body (V) | 350,000 bytes, verifier side | V `vh/originals/bitcoin.ts:49`, `:307` | ignored as `too-large` |
| CBOR (V) | depth 64; integers ≤ 2^53−1 | V `vh/originals/cbor.ts:13`, `:35` | `CBOR_INVALID` |
| Sat read (V, pre-existing adapter) | ≤10,000 inscriptions per sat; ≤32 MiB content+metadata; 30 s default, 120 s max; 512 requests default, 50,000 max | V `sdk/adapters/providers/sat-snapshot.ts:33-36`, `:99`, `:140` | — |
| Inscription clock (V) | 2,000 headers per batch; 10,000 header requests per `at`; save every 144 blocks; block time 0…0xffffffff | V `sdk/originals/bitcoin.ts:141`, `:177`, `:185`, `:314` | `BLOCK_TIME_BUDGET_EXCEEDED` (`incomplete-evidence`) |
| Writer (W) | dust/postage minimum 546; relay floor 1.1 sat/vB; no fee-rate ceiling on this path | W `sdk/bitcoin/transactions/commit.ts:23`; `fee-calculation.ts:10` | plain `Error` |

Tests: C12-82 (`originals.test.ts:286`); `vh/tests/json.test.ts`; `hosting.test.ts` (C12-26, C12-66, C12-78, C12-84); `vh/tests/fetch.test.ts` (C12-78, C12-81); C12-83 (`evidence.test.ts`).

Gaps against P7.7 and plan 011 §2.4:

- There is no cap on resource versions apart from the entry count.
- There is no 64 MiB per-resource cap and no 16 MiB cap on a log read locally. The 16 MiB cap applies only to a fetched file.
- The archive limits use `invalid-evidence`, while the other limits use `limit-exceeded`.
- An entry that fits 65,536 can still overflow the 350,000-byte anchoring inscription once the whole log must fit (section 6.4).

## 4. D5 — local commit, duplicates, versionTime, stale parents (L)

| Item | Choice | Code | Tests |
|---|---|---|---|
| Commit order | 1. Sign and verify the whole candidate log against its exact parent (`COMMIT_VERIFICATION_FAILED` otherwise). 2. Store each new resource (content-addressed; skipped if present). 3. Replace `did.jsonl` conditionally on `expectedHead`. 4. Raise retained versionIds. | `sdk.ts:685-733` | C12-13 (`sdk.test.ts:120`) |
| FileStore write | Every file goes to `<name>.<12 hex>.tmp` (opened `wx`), is written, fsynced and closed, renamed, then the directory is fsynced. `.tmp` files are deleted on `open`. | `fs-store.ts:99-111`, `:67-91` | C12-14 (`fs-store.test.ts:56`, fault hook `beforeRename`) |
| Locks | In-process promise chain per Original (commit) and per DID (retained). "One process may write a store at a time" is documented, not enforced. The landing's shared host adds an instance lock. | `fs-store.ts:13-17`, `:122-133`, `:185-194`; `landing/server/shared-saves.ts:40-47` | — |
| Retained versionIds | Never lowered. VH ids compare by number; ids without one (did:btco) replace as given. | `store.ts:84-92`; `fs-store.ts:185-194` | — |
| Duplicate: local commit | If the draft's versionId is already in the stored log, `commit` returns `{ status: "duplicate" }` with the current view, without signing | `sdk.ts:714-721`, `:239-242` | C12-15 (`sdk.test.ts:110`) |
| Duplicate: import | `already-current` when the log equals the local one. `kept-newer-local` for an older prefix. `conflict` for a diverging valid branch, which is kept with `putBranch` and never replaces local history. `imported` otherwise. | `sdk.ts:1006-1020` | C12-77 (`evidence.test.ts:87`), `:99` |
| Duplicate: shared host (P6.7, a432) | A byte-identical line already accepted gives `200 { status: "already-accepted", checkpoint, head }`, and the SDK commits it locally | `landing/server/shared-saves.ts:232-235`; `sdk.ts:744-768` | `landing/src/sdk/shared-host.test.ts` (C12-125…C12-131) |
| versionTime | Milliseconds (owner decision Q8; VH-Log PR 8, 3 digits). The SDK writes `new Date(max(clock(), previous + 1 ms)).toISOString()`: always 3 digits and `Z`, strictly increasing even if the clock stalls. Clock source: `options.clock ?? Date.now`. No minimum interval. | `sdk.ts:84`, `:380`, `:555-558`; `profile.ts:67`; `log/index.ts:489-495` | `originals.test.ts:278`; `sdk.test.ts:131` |
| Stale parent | Before preparing: the stored head ≠ `parent` gives `stale-parent` / `STALE_PARENT`. A resource whose current digest ≠ `expectedDigest` gives `STALE_DIGEST`. Re-checked at signing and again as compare-and-swap in `store.commit`. A refused shared-host candidate cannot be re-signed (`CANDIDATE_REFUSED`). There is never a rebase. | `sdk.ts:585-595`, `:609`, `:690`, `:674-678`; `fs-store.ts:127-128`; `store.ts:101-103` | C12-12 (`sdk.test.ts:98`); `fs-store.test.ts:39` |
| Parent must verify | An Original whose history or identity evidence does not fully verify cannot be extended (`PARENT_NOT_VERIFIED`, `incomplete-evidence`). A deactivated one gives `ORIGINAL_DEACTIVATED`. | `sdk.ts:588-591` | — |

**Mismatch:** spec 9058 `06-operations.md:37` still says VH entries carry whole-second versionTime and that finer precision is open (D5). The SDK is on milliseconds per Q8.

## 5. D6 — Bitcoin verifier and did:btco (V, `3c982ca1`)

| Item | Choice | Code | Tests |
|---|---|---|---|
| Media type | `application/vnd.originals.vh+jsonl` (PROVISIONAL). Any other type is ignored as `not-an-originals-inscription`. | `vh/originals/bitcoin.ts:46`, `:305` | `vh/tests/bitcoin.test.ts` (row 72, C12-75) |
| Body cap | 350,000 bytes (PROVISIONAL), checked before decoding; `too-large` | `bitcoin.ts:49`, `:307` | `bitcoin.test.ts:485` (row 117), `:494` (row 118) |
| Metadata | Any non-null metadata is ignored as `carries-metadata` | `bitcoin.ts:306` | `bitcoin.test.ts:420` |
| Decoding | UTF-8, fatal, BOM kept (so a BOM fails), then JSON Lines of objects; else `undecodable` | `bitcoin.ts:149-157`, `:309` | `btco-author.test.ts:105`; `bitcoin.test.ts:174` |
| Confirmations | 1 (PROVISIONAL policy); fewer is `unconfirmed`, observed only | `bitcoin.ts:304`; `btco.ts:143-144` | `bitcoin.test.ts:166`, `:446` (row 96) |
| Depth reporting | `confirmations` on `anchoring.anchor`, `conflicting[]` and `accepted[]`, and in `OwnershipReport`. `anchoring.tip {height, hash}` is the lowest tip read. Across indexes, depth is the minimum. Adapter depth = `tip.height − creation.height + 1`. | `bitcoin.ts:72-79`, `:120`, `:129`; `btco.ts:140`, `:160-161`; `sdk/originals/bitcoin.ts:403-404` | `sdk/tests/unit/originals/bitcoin.test.ts:307` |
| Reorg | `authoritative-source-changed` when the retained versionId leaves the Bitcoin log. `anchor-changed` with `anchoring.change {previous, current \| null}`. The clock refuses an off-chain block (`BLOCK_NOT_ON_CHAIN`). | `verify.ts:374-377`; `bitcoin.ts:378`, `:443-444` | `bitcoin.test.ts:200` (C12-40, row 97), `:619` (row 105) |
| Anchoring inscription | The whole log: it starts at version 1 (`does-not-start-at-genesis`), ends at the first entry listing a did:btco alias (`last-entry-not-anchoring`), names the sat it was read under (`names-another-sat`), and verifies as one log (`not-one-log`) | `bitcoin.ts:253`, `:314-330` | `bitcoin.test.ts:369`, `:391`, `:401` (rows 93, 107, 108) |
| Later inscriptions | One entry each (`more-than-one-entry`), extending the head (`does-not-extend-head`), at a strictly greater height (`not-above-previous-height`) | `bitcoin.ts:397-428` | `bitcoin.test.ts:150` (C12-32), `:411` (row 92) |
| Copies | Compared only: `anchoring.copy` is `absent`, `agrees`, `differs` or `used`, plus `superseded`. With no anchor found the copy is verified: the whole copy if `unverified`, or the part before the anchor if `not-anchored`. | `bitcoin.ts:332-333`, `:373-377`, `:430-438` | `bitcoin.test.ts:211`, `:244`, `:276`, `:381` |
| Placement | Reads are merged per alias, one `SatEvidence` per index, and each must name its index (`SAT_INDEX_REQUIRED`). An inscription counts only if every read places it on the alias's sat number and network with identical reports. The read's own sat label does not count (`not-on-sat`, `other-network`). | `btco.ts:111-117`, `:126-148`; `sdk/originals/bitcoin.ts:444-446` | `bitcoin.test.ts:503`, `:511` (rows 109, 110) |
| Multi-index disagreement | The disputed inscription and everything after it on that sat are dropped (`placement-disputed`, `after-disputed-placement`; `anchoring.disputed[]`). Before any anchor this gives `unverified`. Owner disagreement gives `owner: null` and reason `ownership-indexes-disagree`. | `btco.ts:149-162`; `bitcoin.ts:367`, `:375`; `verify.ts:371-372` | `bitcoin.test.ts:518` (row 115), `:544` |
| Index count | One index is accepted with no warning. Agreement is shown only as the length of `anchoring.indexes[]`; there is no explicit P9.11 "independent indexes agreed" field. | — | — |
| Anchor selection | Candidates are sorted by height, txIndex, inscriptionIndex. The first for the target Original wins; others go to `conflicting[]`. `uniqueness: "not-established"`; `OwnershipReport.status: "provisional"`; `output` is `txid:vout` from the satpoint. | `bitcoin.ts:118-132`, `:357-361`, `:395`, `:451-453`; `btco.ts:83-85` | `bitcoin.test.ts:121` (C12-30, C12-27), `:267` (C12-36) |
| Unresolved | `AnchoringReport.status` is `anchored`, `unverified` or `not-anchored`, with reasons `bitcoin-evidence-missing` and `anchor-not-found-on-bitcoin`. An incomplete sat read fails as `unavailable-bytes` / `SAT_READ_INCOMPLETE`; none at all is `SAT_READ_MISSING`. | `bitcoin.ts:93-97`; `verify.ts:348-353`; `sdk/originals/bitcoin.ts:417-425` | `bitcoin.test.ts:102` (row 95) |
| Bitcoin `src` kind (P9.13) | **Not implemented as a did:vh `src`.** Evidence enters as `verifyOriginal({ bitcoin: SatEvidence[] })`, `sdk.get(did, { bitcoin })` and `load(zip, { bitcoin })`. | `verify.ts:63-71`; `sdk.ts:353`, `:545`; `didvh/index.ts:117-126` | none |
| did:btco grammar | `^did:btco:((?:sig\|test\|reg):)?(0\|[1-9]\d{0,15})$` and sat ≤ `MAX_SAT = 2_099_999_997_689_999`. Prefixes: none = mainnet, `sig:`, `test:` (testnet3 and testnet4 collapse), `reg:` (PROVISIONAL). | `btco.ts:3-25`; `sdk/adapters/providers/sat-snapshot.ts:28` | `bitcoin.test.ts:553` (row 114) |
| Anchoring rules | `sdk.anchor(did, {parent, author, signer, sat})` is an ordinary update adding the did:btco alias (`ALREADY_ANCHORED` on repeat). The alias never changes (`STATE_ANCHOR`). There is no did:webvh change after anchoring. The anchoring sat may not be the author's own did:btco sat. | `sdk.ts:470-477`; `state.ts:27-30`, `:150-167`, `:204-226` | `bitcoin.test.ts:571`, `:580`, `:589` (C12-35) |
| Retained anchor | `RetainedAnchor {inscription, sat, owner \| null}` via the optional `getRetainedAnchor`/`putRetainedAnchor`. FileStore writes `<root>/anchors/<sha256-hex(did)>.json` = `{"did", "anchor"}` atomically, on every verification that reports an anchor. | `bitcoin.ts:82-87`; `store.ts:48-49`; `fs-store.ts:118`, `:184-186`, `:229-241` | `fs-store.test.ts:56` |

Inscription time (`InscriptionClock`, V `sdk/originals/bitcoin.ts`):

- **Definition.** The running maximum of header `time` from genesis, stored in seconds and returned in milliseconds (`:193`, `:201`, `:257`).
- **Reorgs.** Before reading past held blocks it probes the highest held block and bisects to the fork point. A different genesis gives `BLOCK_SOURCE_NETWORK_MISMATCH` (`:195-239`).
- **Batching.** An optional `headers(from, count)` source; `batch` defaults to 2,000 (`:141`).
- **Budget.** `maxRequests` defaults to 10,000. `AbortSignal` cancels; progress is kept (`:177`, `:266-286`).
- **Store format "OICK" v1 (PROVISIONAL)** (`:51`, `:93-97`, `:328-392`):
  - magic `OICK`, format byte 1, network byte (0 mainnet, 1 signet, 2 testnet, 3 regtest), 2 unused bytes;
  - u32 LE block count, then 32-byte hashes, then u32 LE maxima;
  - trailing CRC-32.
- **Damaged or foreign store files.** A corrupt or decreasing file is discarded and rebuilt. A file for another network gives `CLOCK_STORE_NETWORK_MISMATCH`.
- **Persistence.** It saves every 144 blocks and on `flush()`. `fileClockStore(path)` writes atomically (`fs-store.ts:81-101`).
- **Tests.** `sdk/tests/unit/originals/bitcoin.test.ts:54-300` (C12-45; #971; #973) and `clock-bench.test.ts`.

## 6. D6 — Bitcoin writer, catch-up and recovery (W, `7b2f6918`)

Shorthand at W: `bw` = `sdk/originals/bitcoin-writer.ts`, `ios` = `sdk/bitcoin/inscribe-on-sat.ts`, `rec` = `sdk/bitcoin/inscription-recovery.ts`, `commit` = `sdk/bitcoin/transactions/commit.ts`, `fss` = `sdk/originals/fs-store.ts`. None of this is stated by the spec.

### 6.1 Transactions

| Choice | Value | Code |
|---|---|---|
| Body today | The stored signed line, verbatim, plus `\n`: **one entry per inscription, and the anchoring inscription carries the anchoring entry only** (plan 012 §5 decision A, superseded) | `bw:158`, `bw:240` |
| Envelope | The `contentType` tag only. No metadata, pointer or parent tags. | `ios:86-89`; `commit:586-605` |
| Commit/reveal | Script-path P2TR with a fresh random internal reveal key (never stored), `micro-ordinals` `p2tr_ord_reveal`, single leaf `0xc0`, commit output at vout 0 | `commit:614-651` |
| Reveal | Pre-signed before any broadcast. One input (commit:0), one output to the caller's `changeAddress`, so the sat lands there. Postage = commit amount − reveal fee, ≥ 546. | `ios:157-164`; `commit:236-240`, `:277` |
| Commit amount | `max(minimumCommitAmount ?? 546, 546 + revealFee)` | `commit:664-666` |
| Sat location | `fundingUtxos[0]` is the identity input, and its first sat (offset 0, FIFO, no pointer) must be the anchoring sat, else `WRONG_SAT`. Later entries spend the output now holding the sat. | `ios:66-80`; `bw:161-164` |
| Funding | `exactUtxos: true`: the caller's set and order, with no selection. It refuses invalid, locked, inscription-bearing or non-segwit UTXOs. The built and signed commit must spend the declared outpoints in order (`COMMIT_TX_MISMATCH`). | `ios:86-95`, `:128-155`; `commit:490-520`, `:691-708` |
| Fee rate | Caller's `feeRate` in sat/vB, > 0, floor 1.1 sat/vB, no ceiling on this path. Regtest uses 2. | `commit:471`; `fee-calculation.ts:10-24` |
| Change | One output to `changeAddress`, dropped into the fee under 546 | `commit:742-746` |
| RBF | Sequence `0xfffffffd` on every input. The reveal can only be rebroadcast or bumped by CPFP. | `commit:24-38` |
| Network check | The sat alias's network must equal `params.network` (`NETWORK_MISMATCH`). `readSat` refuses a snapshot for another network or sat. One provider index is used. | `bw:110`, `:144-146`, `:286-293` |
| Next entry | Before the anchor shows, the queue starts at the anchoring entry; after, at the successor of Bitcoin's head. Any other target is `HEAD_NOT_NEXT` (anchor not yet shown, already inscribed, or skips one). | `bw:92-108`, `:148-156` |

### 6.2 Catch-up and durable recovery

- **Catch-up step** (`catchUp`, `bw:232-273`). Each call re-reads the sat, recomputes `PendingEntries` (`bw:73-90`) and returns one step with no broadcast:
  - `done`: nothing left to inscribe;
  - `prepare {versionId, replaces}`: build the next inscription;
  - `resume {recoveryId, broadcast}`: finish a stored pair;
  - `wait-for-confirmation {recoveryId, inscriptionId, reason: "unconfirmed" | "not-indexed"}`.
- **Pacing.** One entry is in flight at a time, which gives one block per entry.
- **Matching records.** A record matches when its sat, network and reveal body bytes equal the next entry's line.
- **`replaces`.** It lists confirmed inscriptions of the same entry that Bitcoin ignored. The new pair is a replacement, not a retry (P9.6).
- **Refusals.**
  - `RECOVERY_IDS_REQUIRED` (`incomplete-evidence`): the store cannot list and no ids were given.
  - `BITCOIN_HEAD_NOT_STORED` (`stale-parent`).
  - `NOT_ANCHORED`, `SAT_SNAPSHOT_UNSUPPORTED`, `NETWORK_MISMATCH`.
- **Recovery record** `{ recoveryId: <commit txid>, prepared, broadcast }` (`rec:13-34`).
  - `prepared` holds `version: 1`, the network, satoshi, inscriptionId (`<revealTxid>i0`), both txids, the signed commit hex, the reveal hex, the funding UTXOs and `changeAddress`.
- **States:** `prepared`, `commit_broadcast_unknown`, `commit_broadcast`, `reveal_broadcast_unknown`, `reveal_broadcast`. The record is persisted before every broadcast (`rec:26-33`, `:253-340`).
- **Already broadcast.** RPC −27 and the "already in mempool / known / in chain / outputs in utxo set" strings count as already broadcast (`rec:147-173`).
- **Hard errors.** Missing-input and conflict errors are never tolerated (`rec:185-221`).
- **Checks on load.**
  - Hex form; txids recomputed; the reveal spends commit:0; funding order.
  - The reveal's destination is `changeAddress`.
  - A single-leaf tapscript holding exactly one inscription.
  - The Schnorr signature verifies.
  - Lines: `rec:58-119`.
  - A different pair under the same id is refused (`rec:238-241`).
- **Store.** `fileRecoveryStore(dir)` writes `<dir>/<recoveryId>.json` (id `^[0-9a-f]{64}$`) with JSON.stringify, via tmp (`wx`), fsync, rename and directory fsync. `list()` returns sorted ids. Records are never pruned. The files hold signed spending transactions in plaintext (`fss:63-75`, `:105-163`).
- **Restart.** `catchUp` lists the ids. `resumeInscriptionOnSat` re-sends the stored bytes with no signer (`rec:344-352`).
- **Refusal codes.**
  - `invalid-evidence`: `NOT_ANCHORED`, `NOTHING_TO_INSCRIBE`, `ENTRY_NOT_STORED`, `HEAD_NOT_NEXT`, `WRONG_SAT`, `NETWORK_MISMATCH`, `RECOVERY_ID_INVALID`, `RECOVERY_RECORD_DAMAGED`.
  - Transaction-layer codes are plain `StructuredError` with no Originals category: `INVALID_INPUT`, `SAT_INDEX_UNSUPPORTED`, `INVALID_SATOSHI`, `COMMIT_TX_MISMATCH`, `COMMIT_TX_INVALID`, `INVALID_INSCRIPTION_RECOVERY`, `INSCRIPTION_RECOVERY_PERSIST_FAILED`, `INSCRIPTION_RECOVERY_REQUIRED`.
  - Insufficient funds and a fee rate ≤ 0 are plain `Error`.
- **Tests.**
  - `sdk/tests/unit/originals/bitcoin-writer.test.ts:71-334`, citing C12-28, C12-30 and C12-40 in b8e8323 numbering.
  - `fs-store.test.ts:106+`.
  - Regtest on Core 31.1 and ord 0.29.0: `scripts/regtest/originals-anchor.ts` (8 steps) and `originals-restart.ts` (SIGKILL at `reveal_broadcast_unknown`, then a resume in a fresh process).

### 6.3 Pending writer changes (not in W)

- **P9.17 as amended by spec #42.** The anchoring inscription will carry the whole log, genesis through the anchoring entry; later inscriptions stay at one entry. Today W inscribes the anchoring entry alone. W enforces no 350,000-byte cap; only the 65,536 entry limit bounds a body.
- **P9.18.** Before inscribing, verify the log through the signed anchoring entry and every signer's identity evidence. Label the result "pending Bitcoin acceptance" until confirmed. Tell the author what Bitcoin will not hold. Today there is no explicit gate and no pending label: the only pre-confirmation statuses are `unverified` and `not-anchored`.
- **Docs.** `ORIGINALS.md:297-300` at W ("every inscription carries one complete entry") and plan 012 §5 A will change with these.

### 6.4 Writer interplay

- 10,000 entries × 65,536 far exceeds 350,000 bytes. Under P9.17 a long log cannot be anchored, so the writer will need a size refusal before signing the anchoring entry.
- `catchUp` treats a missing ownership output as live (`bw:263`).

## 7. Other PROVISIONAL items and implementation choices

### 7.1 PROVISIONAL markers not covered above

Marked at L unless stated.

| Where | Choice |
|---|---|
| `vh/originals/profile.ts:23` | `witnessSuites: ["eddsa-jcs-2022"]` (plan S3). This is dead, because `profile.ts:101-103` refuses any witness. Remove it or keep it for a future profile. |
| `vh/originals/alias.ts:4`; `landing/src/sdk/publish.ts:7`; `ORIGINALS.md:273` | The alias "points back" when its latest document's `alsoKnownAs` lists the did:vh; the two SCIDs differ (plan S4). |
| `vh/originals/build.ts:56`; `ORIGINALS.md:275` | Publishing is an author update that lists the alias; there is no `publish` operation. |
| `vh/originals/state.ts:236`, `:314`; `ORIGINALS.md:286` | At most one did:webvh alias. Genesis lists none. Once listed it stays and moves only within its SCID. Layers move one way. |
| `vh/originals/author.ts:38`; `verify.ts:68`; `sdk.ts:99`; `ORIGINALS.md:104`, `:243`; `.changeset/originals-identity-continuity.md:6` | Freshness `retrieved` (P5.14), below. |
| `vh/fetch/index.ts:22`; `sdk/originals/retrieval.ts:3`; `hosting.ts:48`, `:75`; `sdk.ts:88`; `ORIGINALS.md:306` | The 16 MiB file cap and the retrieval budgets of section 3.4 |
| `sdk/originals/hosting.ts:4`; `ORIGINALS.md:292`; `landing/server/hosted-layout.ts:4` | Hosted layout, below |
| `landing/server/shared-saves.ts:53`; `landing/src/sdk/shared-host.ts:7`; `ORIGINALS.md:398` | Shared-host authorization and wire format, below |
| `sdk/originals/signer.ts:79`; `ORIGINALS.md:91` | The wording of `describeEntry`, the text shown to a signer (P5.11) |
| `vh/originals/index.ts:4`; `ORIGINALS.md:9-10`, `:20`; `specs/README.md:29-35`; `.changeset/originals-vh-extension.md:5` | General statements that names follow plan 011 §2 |
| `plans/011-originals-vh-replacement.md:3`, `:53`, `:69`, `:107`, `:149`, `:201`, `:241` | Plan statements. `:128` and `:198` are witness items superseded by Q14. |
| V `vh/originals/author.ts:113`; `ORIGINALS.md:314` (W `:331`) | A did:btco author version is named by its inscription id. Not determined whether did:btco v0.2.0 defines it that way. P5.13 at 9058 says "the versionId that method assigns". |
| V `vh/originals/state.ts:27`, `:150` | No `publish` or `migrate` operation. At most one alias of each method. |
| V `sdk/originals/bitcoin.ts:51`, `:396`; `ORIGINALS.md:258`, `:264`, `:354` | The clock store format and defaults; the `btcoAlias` prefixes |
| V/W `plans/012-bitcoin-representation.md` (V `:8`, `:63`, `:149`, `:183`; W `:6`, `:58`, `:131`, `:161`) | Plan 012 framing, representation, prefixes and inscription-id versionIds |

Editor markers are listed in section 9. The writer code at W (`bw`, `ios`, `rec`, `fss`) carries no PROVISIONAL tag, although every choice in section 6.1 is one.

### 7.2 Error categories and codes beyond spec section 6

- **Union.** The categories are a union at L `vh/errors.ts:21-33`. Section 6 suggests them at `06-operations.md:39` (a432 and 9058).
- **`limit-exceeded`.** Not in section 6 at either pin. It is used for:
  - `JSON_TOO_DEEP`, `JSON_TOO_LARGE`;
  - `ENTRY_TOO_LARGE`, `LOG_TOO_LONG`;
  - `STATE_TOO_MANY_RESOURCES`, `STATE_TOO_MANY_EDITORS`;
  - `RETRIEVAL_BUDGET_EXCEEDED`.

  It is also a `history.status` value (`verify.ts:124`, `:177`). P7.7 uses the label, but section 6 does not list it.
- **`outside-grant`.** In section 6 at a432, absent at 9058 (it moved with #45). Codes: `EDITOR_AUTHOR_ONLY`, `EDITOR_OUTSIDE_GRANT`, `EDITOR_PARAMETERS`.
- **Codes.** Section 6 leaves codes open. Notable additions at L:
  - `COMMIT_VERIFICATION_FAILED`, `PARENT_NOT_VERIFIED`, `STALE_DIGEST`, `CANDIDATE_REFUSED`;
  - `HOST_ANSWER_INVALID`, `HOST_DIVERGES` (`fork`), `RECONCILE_CHANGE_REQUIRED`, `REFUSED_NOT_FOUND`;
  - `ALIAS_NOT_CONFIRMED`, `SIGNER_REQUIRED` (`unauthorized-key`), `SNAPSHOT_LOG_INVALID`;
  - `EVIDENCE_*`, `ARCHIVE_*`.
- **V codes.** V adds about 25 codes in existing categories: `ALREADY_ANCHORED`, `STATE_ANCHOR`, `SAT_*`, `BLOCK_*`, `CLOCK_*`, `CBOR_INVALID`, `AUTHOR_PLACEMENT_DISPUTED`, … It also adds non-error vocabularies: 19 ignored-inscription reasons and 4 placement reasons (V `bitcoin.ts:51-70`, `btco.ts:88`).
- **W.** Operational refusals ("nothing to inscribe", "wrong sat") are filed as `invalid-evidence`, because section 6 has no operational category.
- **Landing HTTP codes.** The landing returns codes outside the taxonomy (`shared-saves.ts:9-11`): `stale_parent`, `not_hosted`, `hosted_log_invalid`, `original_mismatch`, `identity_evidence_conflict`, `resource_not_in_entry`, `digest_mismatch`, `resource_missing`, `entry_invalid`.

### 7.3 Hosting, aliases, freshness, shared host, refused candidates (L)

**Hosted layout** (relative to the alias's `#files` base):

- **SDK side.**
  - The base is `https://<host>[:port]/<path>/`. The alias log is `<path>/did.jsonl`, or `.well-known/did.jsonl` for a bare domain. The implicit `#files` is `{ id: "<did>#files", type: ["PathHandler","PathService"], path: "/", serviceEndpoint: <base> }` (`vh/webvh/index.ts:102-120`).
  - `hostedFiles` serves the alias log, the alias `did-witness.json`, and the evidence package unpacked under `originals/` (`HOSTED_PREFIX`) (`sdk/originals/hosting.ts:80-104`).
  - Resources are served with the signed `Content-Type` and `nosniff`. Other headers: `CSP: default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`, `CORP: cross-origin` and `Referrer-Policy: no-referrer`. Active types also get `Content-Disposition: attachment` (`hosting.ts:106-124`).
- **Landing side** (`landing/server/hosted-layout.ts:6-13`):
  - `<host>/<user-slug>/did.jsonl`: the author;
  - `<host>/<user-slug>/o-<name>/{did.jsonl, did-witness.json}`: the alias;
  - `<host>/<user-slug>/o-<name>/originals/…`: the package.
  - The landing's digest regex is `z…{40,60}` (`:25`) against the SDK's `{1,120}`.

**Alias naming (landing only, not the SDK):**

- The name is `o-` plus the first 16 characters of the SCID (`landing/src/sdk/publish.ts:29-32`), checked by `^o-[1-9A-HJ-NP-Za-km-z]{16}$` (`hosted-layout.ts:24`).
- The alias is `did:webvh:<SCID'>:<domain>:<user-slug>:o-<name>`, created `portable: true` with `alsoKnownAs: [original]` (`publish.ts:34-50`).
- `user-slug` = `user-` plus the first 16 characters of the auth `sub` (`landing/server/originals-routes.ts:41-43`).
- 16 base58 characters is about 93 bits. Collisions within one user's namespace are not handled beyond that.

**Freshness:**

- `Freshness = "asserted" | "retrieved" | "not-established" | "stale"` (`verify.ts:74`). Only `asserted` and `retrieved` count as established.
- `retrieved` applies only to signer identities, and only when `retrievedFrom` equals `didWebvhLogUrl` of the location in the latest entry that identity signed (`verify.ts:188-205`, `:303-307`).
- `assetFreshness.status` is only `asserted`, `not-established` or `stale` (`verify.ts:372-376`).
- Alias statuses: `confirmed`, `not-confirmed`, `unavailable`, `invalid` (`ORIGINALS.md:284-285`).
- Tests: `vh/tests/freshness.test.ts` (C12-08, C12-22, C12-23, C12-41, C12-51, C12-64); `vh/tests/continuity.test.ts:171`, `:181`.

**Shared-host saves (P6.7, P6.8 at a432):**

- **Route.** `POST /api/originals/submit/<encoded host/user-slug/o-name>` (`originals-routes.ts:30`, `:156-176`).
- **Body.** `{ original, entry, resources: { <digest>: <base64> }, identities: [{ did, log, witness? }] }`.
- **Answers.**
  - `200 { status: "accepted" | "already-accepted", checkpoint, head }`.
  - `409 { status: "stale-parent", error: "stale_parent", head }`.
  - Errors: 400, 401, 404, 413, 422.
- **Authorization.** Any signed-in caller (JWT `authSub`) with a valid entry may submit. Accepted files stay the namespace owner's and count against the owner's quota. Marked PROVISIONAL (`shared-saves.ts:49-54`; `originals-routes.ts:157-158`). Cross-account submit is tested (`landing/src/sdk/shared-host.test.ts:24`, `:326`).
- **Host checks** (`shared-saves.ts:232-299`), in order:
  1. A byte-identical accepted line gives `already-accepted`.
  2. The entry must chain to the head.
  3. Full `verifyOriginal` over head plus entry. Submitted signer logs are used only if they extend the stored ones (`identity_evidence_conflict` otherwise).
  4. Re-compare the head.
  5. Write bytes, then DID logs, then the asset log (the commit point), then the manifest.

  One queue runs per Original, and one process per data directory (instance lock).

**Refused candidates:**

- `StoredRefused { label: "refused", parent, entry, hostHead, reconciledAs? }` (`sdk/originals/store.ts:42-52`).
- `reconciledAs` is the versionId of the accepted reconciled candidate. It is set after reconcile, and the refused record is kept (`sdk.ts:826-830`).
- FileStore path: `<root>/originals/<scid>/refused/<sha256(versionId)>.json`, overwritten only with the identical entry (`fs-store.ts:7`, `:214-220`).
- `dropRefused` exists but nothing calls it.
- **Doc mismatch:** `ORIGINALS.md:386-387` says a reconciled refused candidate "is dropped".
- Tests: `sdk/tests/unit/originals/shared-host.test.ts:169`; `fs-store.test.ts:109` (C12-125).

**`retrieveHosted`** (`sdk.ts:923-960`):

- Fetches the alias log, the manifest, the asset log, then the planned author logs and resources, with the retrieval budget checked before any planned fetch.
- Returns the contents unverified. `sync` and `reconcile` verify them.

## 8. Items the two coming owner decisions will affect (no change made)

### 8.1 "Unanchored Originals are never `current`, only valid as of a checkpoint"

| Where `current` is reported | Code (L) |
|---|---|
| `OriginalsReport.current = reasons.length === 0`. `ordering` is always `"claimed"` at L, and nothing adds a reason for being unanchored. | `vh/originals/verify.ts:156`, `:161`, `:428` |
| `OriginalView.current` (from `get`, `create`, `edit`, `publish` results) | `sdk/originals/sdk.ts:235`, `:533` |
| `LoadedEvidence.report.current` (and-ed with the manifest checks) | `sdk.ts:888` |
| `PublishedOriginal.report.current` | `sdk.ts:264`; `ORIGINALS.md:302` |
| `ImportResult.status: "already-current"` (the name only) | `sdk.ts:270` |
| CLI "not current: <reasons>" and `--freshness asserted` | `sdk/originals/cli.ts:46`, `:57` |
| Landing engine passes `freshness: "asserted"`, so its own unanchored Originals report `current: true` | `landing/src/sdk/engine.ts:211` |

- **When `current` can be true.** Unanchored, `current` is true only with `freshness: "asserted"` (`verify.ts:373`, `:396`), because the asset log has no `retrieved` path.
- **Tests.** About 15 tests assert `current` is `true` (for example `originals.test.ts:56`, `:121`, `:404`).
- **Checkpoints.** The "valid as of a checkpoint" notion already exists in part: a non-head checkpoint is verified and reported with `checkpoint-is-not-head` (`verify.ts:339`). There is no `validAsOf` member.
- **V's anchored exemptions.** These are unaffected by the decision (V `verify.ts:369`, `:383`, `:387`, `:398`):
  - author DID deactivation;
  - the P7.9 latest-key check;
  - missing bytes.

### 8.2 "Key custody is out of scope"

- **Signer interface.** `OriginalsSigner { verificationMethod, cryptosuite, sign(request) → Uint8Array }` takes the full entry, summary and display (`sdk/originals/signer.ts:41-55`). The SDK never signs on its own (`SIGNER_REQUIRED`, `sdk.ts:666-671`).
- **`keySigner`.** `keySigner({ keyType, secretKey, verificationMethod, confirm? })` holds raw key bytes "for tests and local custody". Ed25519 maps to `eddsa-jcs-2022`, anything else to `bip340-jcs-2025` (`signer.ts:136-165`).
- **Landing custody.**
  - **Visitor.** An in-browser did:vh author, nothing persisted (`landing/src/sdk/local-author.ts:1-7`).
  - **Backup wrapping key.** A non-extractable AES-GCM key in IndexedDB `originals-authorship-keystore` (`landing/src/sdk/keystore.ts:21-24`).
  - **Passphrase backup.** PBKDF2-SHA256 at 210,000 iterations into AES-256-GCM, format `originals/authorship-key-backup` v1, passphrase ≥ 8 characters (`landing/src/sdk/key-backup.ts:1-15`).
  - **Signed-in users.** A server-held Turnkey authorship key `#key-1` (assertionMethod), separate from the identity key `#key-0` (`landing/src/sdk/turnkey-authorship-signer.ts:1-17`; Q12).
- **Bitcoin (W).**
  - Funding and sat keys stay with the caller through `BitcoinSigner.signAndFinalizeCommitPsbt` (`ios:24`, `:102`).
  - The reveal key is ephemeral (`commit:614`).
  - The sat lands at the change address.
  - Recovery files hold signed spending transactions in plaintext.
- **Not determined:** whether the older `sdk/crypto/OriginalsSigner.ts` (`KeyStore`, `ExternalSigner`) is still exported. It is not used by `sdk/originals/`.

## 9. Editor choices (spec PR #45, separate proposal)

These belong to #45. They cite P5.14–P5.18 and P6.7–P6.8 at a432; master `9058816` has none of them.

| Item | Choice | Code (L) |
|---|---|---|
| State member | `asset.editors?: EditorGrant[]`, `EditorGrant = { did: string; name: boolean; metadata: boolean; resources: string[] }`, exact members (PROVISIONAL names) | `vh/originals/state.ts:42-52`, `:195-198` |
| Absent vs empty | Absent means none. `[]` is refused (`STATE_EDITORS`). Removing all grants omits the member. | `state.ts:60`, `:190`; `build.ts:84`, `:118` |
| Grant rules | Unique DIDs of a listed method (`did:vh:`, `did:webvh:`, `did:btco:`). Not the author DID, and not any did:webvh with the author's SCID. `resources` are distinct ids from the resource set. | `state.ts:170`, `:187-217` |
| Limit | 32 grants (`limit-exceeded` / `STATE_TOO_MANY_EDITORS`) | `state.ts:23`, `:191` |
| Editor reference | `state.editor = { did, verificationMethod, versionId }`. The signer is `editor ?? author`. The editor entry carries the parent's `author` unchanged (`EDITOR_AUTHOR_CHANGED`). | `state.ts:71-93`, `:268-270` |
| Entry rules | The grant comes from the parent's state. The entry is an update, not genesis or deactivate. It changes no grants, aliases or status (`outside-grant` / `EDITOR_AUTHOR_ONLY`). Name, metadata and resources change only as granted (`EDITOR_OUTSIDE_GRANT`). No grant is `unauthorized-key` / `EDITOR_NOT_GRANTED`. Parameters are empty (`EDITOR_PARAMETERS`). The builders refuse the same before signing. | `state.ts:262-282`; `profile.ts:110-113`; `build.ts:76`, `:132-139`, `:162` |
| Authority hook | Editor authority is a profile rule; no VH-Log hook carries it (PROVISIONAL) | `state.ts:259-260` |
| Key order | P5.8 per signer identity: never older than the version that identity's previous entry named (`SIGNER_VERSION_REGRESSED`) | `profile.ts:89-94` |
| Report | `identityEvidence.editors: SignerEvidence[]`. Reasons: `editor-history-older-than-retained`, `editor-freshness-not-established`, `head-key-not-in-latest-signer-document`. | `verify.ts:96-106`, `:309-333`, `:399-400`, `:424` |
| Evidence | Editors share `authors/<sha256(did)>/`. A missing editor history is `{ kind: "identity", did, role: "editor" }`. A missing editor history in the log stops verification with `EDITOR_HISTORY_MISSING` (`details.role: "editor"`). | `evidence.ts:8-10`; `sdk.ts:845`; `profile.ts:86` |
| Signer display | `summarize` and `describeEntry`, with the signer `{ role, did, verificationMethod, versionId }` and `editorsChanged`. The line wording is PROVISIONAL. | `sdk/originals/signer.ts:59-97` |
| Continuity (P5.14) | The identity is the DID at genesis. A did:webvh move needs the same SCID with the identity among the document ids. `retrievedFrom` must be the latest location that identity signed with; editor entries never reveal the author's location. | `vh/originals/author.ts:98-102`; `verify.ts:188-205`; `sdk.ts:91-102` |
| Editor fork in Bitcoin (V) | V's `signerOf` treats every inscribed entry as an author entry (HOOK comment for P5.16–P5.18). The restack must wire editor entries into P9.12 and P9.15. | V `vh/originals/bitcoin.ts:160-168` |

Tests:

- `vh/tests/editors.test.ts`: C12-05, 06, 113–122, 124, 130, 131, 134.
- `sdk/tests/unit/originals/editors.test.ts`: C12-113–115, 117–119, 124, 134.
- `vh/tests/continuity.test.ts`: C12-132, 134–136, 138.
- `sdk/tests/unit/originals/continuity.test.ts`: C12-132–135, 137.

All are a432 numbering.

## 10. Choices that may conflict with the spec text or deserve a decision

Most important first.

1. **Writer vs P9.17 and P9.18.** W inscribes the anchoring entry alone, with no 350,000-byte refusal, no pre-inscription verification and no "pending Bitcoin acceptance" label. These are pending changes (6.3). The entry and history limits (65,536 × 10,000) also need reconciling with a 350,000-byte whole-log anchor (6.4).
2. **Unanchored `current`.** It can be `true` today, and the landing asserts freshness to get it (8.1). The coming decision changes the report shape (`current`, `reasons`, `OriginalView.current`, CLI).
3. **Rule IDs gone from master.** P5.14–P5.18, P6.7–P6.8 and the `outside-grant` category exist only at a432 and in #45. Editors, continuity and shared-host saves cite them (section 9).
4. **Bitcoin `src` kind (P9.13).** It is not implemented as a did:vh `src`; Bitcoin evidence is a separate option.
5. **Index agreement (P9.10, P9.11).** One index is accepted silently, and there is no explicit "independent indexes agreed" member.
6. **did:btco signers in packages (P9.18).** They are reported as `missing` identity, so the package is `partial`, though Bitcoin verifies them.
7. **did:btco versionId = inscription id.** This is PROVISIONAL. Not determined against did:btco v0.2.0 (P5.13 says the method assigns it).
8. **`limit-exceeded`.** It is a category the SDK uses that section 6 does not list (P7.7 uses only the label). The archive limits use `invalid-evidence` instead.
9. **`#files` service of the did:vh.** It is a descriptor map, not a locator, while section 3 says the did:vh "can locate the Original's files itself" (1.3).
10. **versionTime precision.** The SDK uses milliseconds (Q8, VH-Log PR 8). Spec master `06-operations.md:37` still describes whole seconds as the VH baseline and leaves this open (D5).
11. **Entry size.** It is measured in UTF-16 code units of a re-serialised entry, not bytes of the line. Name length is also in code units.
12. **Witness leftovers after Q14.** `witnessSuites` (`profile.ts:24`); `asset/did-witness.json` in the package and hosted layouts; `StoredOriginal.witness`.
13. **Shared-host authorization.** Any signed-in caller with a valid entry may save into another user's namespace, at that user's quota (PROVISIONAL; deployment question).
14. **Refused candidates.** They are kept with `reconciledAs` after reconciling, but `ORIGINALS.md:386-387` says they are dropped. Fix the doc or the code.
15. **Undeclared parameters.** Generic VH `watchers` and `ttl` parameters are accepted in asset log author entries; the profile could forbid them.
16. **Unchecked `missing` shapes.** Manifest `missing` items are not validated on read, and plan 011 §2.3's `limits` and `witness` items were not implemented.
17. **"Retrieved" freshness at an abandoned location (P5.14, P7.8).** Found by the authorization review of L. The SDK finds a moved identity's log at the location named by the latest entry that identity signed, and reports freshness `retrieved` when that log is found. An attacker holding a key the author later removed can sign an entry naming a version from before a move; the "latest location" is then the old host, and a frozen prefix log served there gives `retrieved` with no key-removal reason. Today `current` stays false only because unanchored asset freshness is never established without `asserted`. Proposed: a log retrieved at a location counts as established only if its latest version's `id` names that location, or only with the identity method's witness/watcher support; otherwise freshness is `not-established`.

Review status: L was reviewed adversarially for authorization, concurrency and retrieval limits after this inventory was taken; the fixes in progress change behaviour in those areas (for example the shared-host submit route refusing entries that cannot be current, and per-identity editor ordering by SCID) but none of the items above.
