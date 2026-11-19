# 050 — Signer sets, parent authority and scoped grants

Status: **delivered against originals-spec #66 (`a2b5013`), 2026-11-19.**
The spec assigned the final IDs: signer sets P5.19–P5.23 and P5.30, parent
Originals P5.24–P5.27, scoped grants P5.28, P5.29 and P14.23, decision D8;
section 12 rows 285–324 are registered as C12-382 to C12-421. Where the spec
differs from this plan, the spec governs (for example P5.25: an unknown pin
is incomplete for an unanchored parent; P5.23: every signer of an inscribed
set entry passes P9.15; packages put parent logs under `parents/`).
SDK PRs: W1 #1071, W2 #1072, W3 `feat/scoped-grants` (this PR).

Original status: **design contract, 2026-11-19.** The owner decided these changes on
2026-11-19, in a grilling session (plan 049 thread) and a Boop design session.
The spec PR (aviarytech/originals-spec) and the SDK implementation follow this
document and land together ("both in parallel"). Rule IDs below marked
**new** are proposed numbers. The spec PR assigns the final IDs, and this
plan is updated to match.

Terms follow [`CONTEXT.md`](../CONTEXT.md). Existing rule IDs refer to
originals-spec master plus PR 64 (EVM withdrawn, Bitcoin previews).

## 0. Decisions (owner, 2026-11-19)

| ID | Decision |
| --- | --- |
| W1 | **Signer sets.** An Original may be governed by a set of DIDs with a threshold instead of one author. This is part of `originals:1.0` itself: an additive draft change with no version bump. A set of one behaves exactly like today's single author, and every existing Original verifies unchanged. Any Original may use it. This reverses owner decision S8 and P5.2/P5.3 ("exactly one proof"). |
| W1a | **Extra signatures go in VH-Log's `proof` array:** one proof per signer, in signer order. This lifts the one-proof rule (P5.2, P14.8); no new member is added. |
| W1b | **Changing the set, and anchoring,** need a threshold of the parent entry's set. The sat holder still has no authority (P9.11, P9.12). |
| W2 | **Authority from a parent Original, pinned.** A child Original names a parent Original. Each child entry pins a parent versionId, and grants are judged at that version. The pin never goes backwards. |
| W2a | **A child keeps its own author** (or signer set), fixed at genesis (P5.8 unchanged). The parent contributes editor grants only. A parent's did:vh is never an editor (P5.15). |
| W3 | **Scoped grants.** A grant gains an optional `scope`. The core checks who may sign. A scope type defines what the scope allows and how to check it. A verifier that cannot check a scope reports it unchecked, never allowed. |
| W3a | **Standard scope types:** `paths` (file trees, used by code) and `items` (collections, with add, edit and remove, used by Boop lists). |
| R | **Reads** are host-enforced and are specified separately (the "read authorization" spec PR). Branches inherit read access through W2. Not in this plan. |

## 1. W1 — signer sets

### State (P14.4, P14.5 change)

- New optional asset member **`authors`**: `{ "threshold": t, "dids": [d1, …, dn] }`.
  - `dids` are sorted by code unit order, unique, 1 ≤ n ≤ 32 (`ORIGINALS_LIMITS.authors`, new, P7.7), and each uses a P5.8 method.
  - `t` is an integer with 1 ≤ t ≤ n.
- An Original **with** `authors` (a *set Original*) names its signers in the entry state's `author` member as an **array** of signer references `{did, verificationMethod, versionId}`, sorted by `did` and unique. An Original **without** `authors` keeps `author` as one object, exactly as today.
- An entry's `author` is an array exactly when that entry's `asset` has `authors`. Once present, `authors` is never removed. A set may shrink to one member.

### Authorization (P5.2, P5.3, P5.4, P5.8, P5.9, P5.16 change; new P5.19–P5.23)

- **P5.19 (new) Genesis of a set Original.** Every member of the genesis set signs: the genesis `author` array lists every DID in `authors.dids`, so membership needs consent.
- **P5.20 (new) Author entries.** An author entry of a set Original is signed by at least the **parent's** threshold of the **parent's** members. If the entry adds members, every added member also signs. Signers outside the parent's set (other than added members) are rejected.
- **P5.21 (new) Converting a single-author Original.** An author entry of a single-author Original may introduce `authors`. The set must contain the author, and the entry is signed by the author and by every other member. From that entry on, the Original is a set Original. P5.8's "fixed at genesis" is read as "the signer set changes only under P5.20".
- **P5.22 (new) Proofs.** The proof array has exactly one proof per signer reference, in the same order. Each proof's `verificationMethod` is byte-identical to its reference, and P5.3 and P5.11 apply to each signer against its own DID. P5.8's rule that a versionId never goes backwards applies per identity.
- **P5.23 (new) Currency (P7.9 analogue).** A set entry that is not inscribed is currently authorized only if at least the parent's threshold of its signers meet P7.9's current-key test. Otherwise it is historically authorized only. For an inscribed entry, P9.15 applies per signer at the inscription, and the threshold must hold there.
- **Editors** (P5.15, P5.16): an editor DID MUST NOT be a member of `authors` at the same entry. An editor entry copies `author` (the array) from its parent unchanged.
- **Only author entries** (P5.16) may change `authors`, as well as the members they could change before. Genesis, anchoring entries and deactivation are author entries, so a threshold signs them (W1b).
- **Derived DID document (P14.9):** for a set Original, `controller` is the array `authors.dids` at that version.
- **Bitcoin (P9.10, P9.15):** an anchoring entry is an author entry. Paying for or broadcasting the inscription gives no authority.

### SDK surface (`@originals/vh/originals`, `@originals/sdk`)

- Builders accept a signer set. `prepare*` returns an unsigned entry. `signEntry` gains a multi-signer form: `cosign(unsigned, signer) → partially signed`, and `finalize(partial) → LogEntry` once enough proofs are present, with the proofs ordered by DID.
- `sdk.create({ authors: { threshold, members: AuthorRef[] }, signers: EntrySigner[] })` and `sdk.edit(..., { signers })`. There is also a draft flow for signers who are not all present: `sdk.prepare*` → `sdk.cosign(draft, signer)` → `sdk.commitDraft(draft)`.
- The report lists signers per entry, and `authorBinding` covers every signer. The identity evidence in packages includes every member DID that signed any entry (P7.1).

## 2. W2 — parent authority, pinned

### State

- New optional asset member **`parent`**: `{ "did": "did:vh:<SCID>", "versionId": "<parent versionId>" }`.
  - `parent.did` is set at genesis and never changes.
  - `parent.versionId` is the **pin**. An author or editor entry may move it forward: it MUST be equal to, or later in the parent's log than, its parent entry's pin.
  - A child cannot leave its parent except by deactivation.
  - `parent.did` MUST NOT be the child's own did:vh.

### Inherited grants (new P5.24–P5.27)

- **P5.24** An editor entry of a child is authorized by a grant in its parent entry's own `editors` (as today) **or** by a grant in the parent Original's `asset.editors` at the version this entry pins. An inherited grant's `name`, `metadata`, `resource` and `scope` apply to the child's content exactly as a direct grant's would. The report says which grant authorized the entry.
- **P5.25 Evidence.** Checking an inherited grant needs the parent's log through the pinned version, verified as an Original (with its own signer evidence). An evidence package for the child includes it, as a nested package or as the parent's log and signer evidence. When it is missing, the result is incomplete identity evidence (P5.6, P7.4), never a pass. The pinned version must exist in the parent's verified log, and the parent must not be deactivated at it.
- **P5.26 Revocation.** An entry authorized only by an inherited grant that is absent from the parent's latest verified state is reported as historically authorized only (P7.9 by analogy). A forked parent has no latest state, so such entries are historically authorized only. Entries stay valid.
- **P5.27 Anchoring.** For an inscribed child entry whose parent is anchored, the pin MUST NOT be older, in the parent's log, than the parent's accepted head at the child entry's inscription in chain order (P9.15 analogue). An entry that breaks this is rejected. *(This corrects the shorter wording sent to the reads thread, "after the parent is anchored, older pins are rejected". An unanchored child has no ordering against the parent's inscriptions, so only the historically-authorized-only label applies to it.)*
- **Authority is grants only.** The parent's author or signer set has no authority over the child (W2a). A child's author is its own, fixed at genesis.

### SDK surface

- `sdk.create({ parent: { did, versionId } })`. `sdk.edit` takes `{ pin?: versionId }`, which by default advances to the newest parent version held.
- `package(did)` includes the parent's evidence through the highest pin. The report gains `parentAuthority: { did, pins, status }` and, per entry, `authorizedBy: "author" | "editor" | "inherited-editor"`.

## 3. W3 — scoped grants

### State

- An editor grant becomes `{did, name, metadata, resource, scope?}`. `scope` is an object with a `type` string and members that the type defines. It restricts only what `resource: true` allows. A grant with `scope` and `resource: false` is rejected.
- **P5.28 (new) Checking.** A verifier that knows a scope type checks each entry relying on a scoped grant: the change from the parent's resource version to this one must stay within the scope. If it does not know the type, or the bytes it needs are missing, it reports the entry's scope as `unchecked`, and the entry is not verified as authorized (incomplete, never valid).
- **Standard scope types (P5.29, new; section 14 lists their members):**
  - **`paths`**: `{ "type": "paths", "paths": [pattern, …] }`, with 1 to 64 patterns using the gitignore-like syntax of plan 049 K7 (`*` is one segment, `**` is any number of segments, and a trailing `/**` means one or more segments). It applies to a resource media type that defines a **path view**: a map from path to content digest, computed from the resource and the objects it references. The touched paths are the added, removed and changed ones; a rename touches both paths. Every touched path must match a pattern. `application/vnd.originals.code-tree+json` defines a path view (plan 049 K2).
  - **`items`**: `{ "type": "items", "ops": ["add" | "edit" | "remove", …] }`, sorted, unique and non-empty. It applies to a media type that defines an **item view**: a map from item id to content digest. Add means a new id, remove means an id that is gone, and edit means a changed digest. Every change must be of an allowed op. Boop's list media type defines an item view.
- Read grants may carry the same `scope` later (plan 049: per-path reads).

## 4. Conformance (section 12)

New rows, `C12-4xx`, are assigned in the spec PR. Each comes with its negative cases:

- W1:
  - genesis signed by every member, and one missing member is rejected;
  - an author entry meets the threshold, and one short of it is rejected;
  - signers outside the set are rejected;
  - adding a member without that member's signature is rejected;
  - the proof order and count match the signer references;
  - an editor who is also a member is rejected;
  - converting a single-author Original works, and a conversion that drops the author is rejected;
  - a removed key makes the entry historically authorized only below the threshold, and current at or above it;
  - an anchoring entry below the threshold is rejected;
  - the derived DID document's `controller` is the member array;
  - existing single-author vectors stay byte-identical.
- W2:
  - an inherited grant allows a change;
  - an inherited grant that was later revoked is historically authorized only;
  - a pin going backwards is rejected;
  - missing parent evidence is incomplete;
  - a pin naming an unknown parent version is rejected;
  - a parent deactivated at the pin grants nothing;
  - a forked parent leaves inherited entries historically authorized only;
  - a child pinning its own did:vh is rejected;
  - an anchored child pinning an old parent version is rejected.
- W3:
  - a change inside a `paths` scope is allowed, and one outside is rejected;
  - a rename touches both paths;
  - each `items` op is allowed or rejected as the scope says;
  - an unknown type, or missing bytes, is unchecked (incomplete);
  - `scope` with `resource: false` is rejected;
  - pattern and op syntax is validated.

## 5. Delivery

1. **Spec PR** to `aviarytech/originals-spec`, stacked on PR 64. It covers the rules above, section 12 rows, section 13 (decision W, reversing S8) and section 14 members.
2. **SDK PRs**, each against `main` with tests citing the new rows: (a) W1 in vh and sdk, (b) W2, (c) W3 (the scope checker registry, `paths` with the code tree path view, and `items` as a generic JSON item-view reference implementation). They repin to the spec PR head, which is treated as merged, as `specs/README.md` does for upstream PRs.
3. **Plan 049 follow-up:** the code profile moves onto the core mechanisms:
   - repo Original → a set Original, with W1 delegates and threshold;
   - branch → a child of the repo with W2 pins, replacing `metadata.code.repoVersion`;
   - path grants → W3 `paths` scopes on inherited grants.
