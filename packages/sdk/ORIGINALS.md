# Originals SDK: the Originals Protocol contract

**Status: target contract, partly implemented.** Phases 1 (local use) and 2
(author DID rotation, freshness and forks) and phase 3 (hosted publication)
are in `@originals/sdk/originals`; the landing's hosted path is plan 011 PR 8.
This document describes what
`@originals/sdk` provides once the phases of
[plan 011](../../plans/011-originals-vh-replacement.md) land. Each section
names the phase that delivers it. API names are provisional until that phase's
PR merges. Choices the spec leaves open are marked PROVISIONAL. The governing
documents are listed in [`specs/README.md`](../../specs/README.md), and rule
IDs (P5.3) refer to the Originals Protocol.

This contract replaces the CEL 3 guide, deleted with the CEL 3 code in plan
011 PR 5. Nothing written under CEL 3 is read, converted or migrated.

## Model

- An Original is `did:vh:<SCID>`. Its asset log is a did:vh log under the
  `originals:1.0` extension (PROVISIONAL method value). Each entry holds the
  full asset state: name, metadata, lifecycle status, resource descriptors and
  aliases.
- The author is a DID fixed at genesis. The baseline profile lists did:vh,
  did:webvh and did:btco. Every entry carries exactly one proof, by an
  `assertionMethod` key of the author DID at the author DID version the entry
  names. That key must not also be an update key of the author DID's own log.
  Asset logs do not use witnesses (owner decision Q14). Accepted
  cryptosuites are `eddsa-jcs-2022` and `bip340-jcs-2025`.
- The author can grant editors (P5.15–P5.18): each editor signs its own
  entries with its own DID, only for the content its grant allows.
- Keys rotate in the author DID only. The asset log has no update keys.
- A did:webvh author can move to another host under did:webvh portability
  and stays the same identity: the DID at genesis, which every entry keeps
  naming (P5.14).
- The DID document of the did:vh is derived from the log. It is never stored or
  taken from a host.

## Local use — phase 1 (implemented; `@originals/sdk/originals`)

```ts
import { OriginalsSDK, MemoryStore, keySigner } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs"; // Node: durable local store

const sdk = OriginalsSDK.create({
  store: await FileStore.open("./originals"),   // or new MemoryStore()
  authors: [{ ...authorDidEvidence, obtainedAt }], // or (did) => Promise<AuthorDidEvidence | undefined>
});
const signer = keySigner({ keyType: "Ed25519", secretKey, verificationMethod: `${authorDid}#orig` });
const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: authorVersionId };

const created = await sdk.create({ name, metadata, resources: [{ id: "photo", mediaType: "image/jpeg", bytes }], author, signer });
// created.kind === "original" | "draft" (no signer: an unsigned draft, never history, P6.3)
// entry timestamps carry milliseconds (VH-Log PR 8; plan 011, Q8)

const edited = await sdk.edit(did, {
  parent: original.checkpoint,   // required; a moved parent is a StaleParent conflict (P4.5)
  name,                          // omitted keeps the value; null is rejected (P4.6)
  metadata,                      // omitted keeps the value; null removes it (P4.6)
  resources: [{ id: "photo", bytes, expectedDigest }], // a new id adds a resource (P4.1)
  remove: ["sketch"],            // author only; at least one resource remains (P4.1)
  author, signer,
});
await sdk.deactivate(did, { parent, author, signer }); // terminal (P6.5)

const draft = await sdk.prepareEdit(did, { parent, name, author }); // prepare now, sign later
await sdk.commit(draft, signer);                                     // retrying returns status "duplicate"

const pkg = await sdk.package(did, { checkpoint });  // ZIP evidence package, complete or partial (P7.1)
const { report, manifest, reasons } = await sdk.load(pkg.bytes); // read-only; no key, no network (P7.3)
await sdk.import(pkg.bytes); // "imported" | "already-current" | "kept-newer-local" | "conflict" (P7.5)
```

The `originals` command verifies a package offline:
`originals verify harbor.zip [--json] [--now <time>]`. It prints the
checkpoint the package is valid as of and the signer DID versions it relied
on; it never reports an unanchored Original as current (P7.10). The
`--freshness asserted` option was removed (originals-spec #46).

- **Durable commit (P6.2).** The SDK signs the entry, verifies the whole
  resulting history, stores new bytes, and then replaces the log atomically.
  `FileStore` writes to a temporary file, fsyncs it and renames it. An
  interrupted commit recovers to either the prior checkpoint or the fully
  committed one. A signer rejection or an invalid proof leaves the prior
  checkpoint unchanged (P6.1).
- **One writing process per store.** `FileStore.open` takes `<root>/.lock`
  atomically (a `link` of a per-process record), so exactly one process holds
  a root; another opening it gets `STORE_LOCKED`. A lock is taken over only
  when its holder is confirmed gone: same host, and its pid no longer runs or
  now belongs to a different process. A lock under the opener's own pid is
  held (worker threads of one process share its pid but not its handles, so
  a worker opening a root its process holds gets `STORE_LOCKED`) unless a
  recorded kernel start time (Linux) shows an earlier process that had the
  pid. A takeover whose taker died between claiming the break and the rename
  is completed by a later opener, by exactly one. A lock from another host,
  or one whose holder cannot be confirmed gone, stays refused; remove
  `<root>/.lock` (and any `<root>/.lock.break.*`) by hand once no process
  uses the store (PROVISIONAL). Handles in one process share the root. `close()` on the last
  handle waits for every write in flight, then releases the lock, so a store
  can be handed to another process; a closed handle refuses writes
  (`STORE_CLOSED`).
- **Retries (P6.4).** Committing an accepted, identical draft returns its
  existing checkpoint with status `duplicate`. Any other retry needs a new
  preparation step.
- **Entry size (P7.7; P14.13).** An entry is at most
  `ORIGINALS_LIMITS.entryBytes` (65,536) bytes, measured as the UTF-8 byte
  length of its stored line without the line feed (previously UTF-16 code
  units of the re-serialized entry), measured before the line is parsed and
  never again after. Entries parsed with `parseLog` carry their stored line's
  size, and `verifyLog` takes the sizes (`lineBytes`) from a caller that has
  the lines; an entry with no stored line is measured as its JCS
  serialization (PROVISIONAL). A commit of a larger entry fails with
  `limit-exceeded` (`COMMIT_VERIFICATION_FAILED`), and a verifier reports the
  log `limit-exceeded` at that entry (`ENTRY_TOO_LARGE`).
- **Resource set (P4.1, P5.16, P14.4, P14.5; originals-spec #49).** Genesis
  names at least one resource. The author's `edit` adds a resource by giving
  bytes and a `mediaType` for a new id, appended after the existing resources
  in the order given, and removes resources with `remove: [id]`, as long as one
  remains. A resourceID is never used again in the Original, even after its
  resource is removed (`STATE_RESOURCE_REUSED`); there is no rename. A removed
  resource must also leave every grant, so pass `editors` without it
  (`STATE_EDITORS` otherwise), and an added resource is in no grant until the
  author grants it. The adding entry may itself grant it, and the grant takes
  effect from the next entry (P5.15, P5.17; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges). An editor never adds or removes a resource
  (`outside-grant`, `EDITOR_AUTHOR_ONLY`), even one its grant names. A removed
  resource's earlier versions stay in `resources`, in evidence packages and in
  hosted snapshots, and stay checked (P8.3). The entry's transitions give
  `from: null` for an added resource and `to: null` for a removed one: first
  the resulting resources in order, then the removed ones in their previous
  order. BREAKING for TypeScript: `Transition.to` is `string | null`.
- **Limits (P7.7, P14.13; decided by the owner, spec PR #50 (open)).**
  `ORIGINALS_LIMITS`: 10,000 entries, 65,536 bytes per entry, 256 resources at
  any one time (removing one makes room for another), 32 editor grants and
  1,000 versions of one signer DID. Exceeding one is `limit-exceeded`
  (`STATE_TOO_MANY_RESOURCES` for resources).
- **Exact members (P14.1, P14.4, P14.8).** An entry's `parameters` are
  exactly `method` and `scid` at genesis, exactly `{"deactivated": true}` for
  a deactivation, and `{}` for every other entry; anything else (`ttl`,
  `watchers`, `witness: {}`, `deactivated: false`, a repeated `method`) is
  `invalid-evidence` (`PARAMETER_MEMBERS`); `updateKeys` and `nextKeyHashes`
  stay `PARAMETER_FORBIDDEN` and a null value `PARAMETER_NULL`. An entry
  proof has exactly `type`, `cryptosuite`, `verificationMethod`,
  `proofPurpose` and `proofValue` (`PROOF_MEMBERS`): `created`, `expires`,
  `id`, `domain`, `challenge`, `nonce`, `previousProof` and `@context` are
  rejected.
- **Form (P14.2, P14.3).** `versionTime` ends in `Z` (`+00:00` is
  `VERSION_TIME_FORMAT`), with at most three fractional digits. Each line of
  an asset log, and of an Originals inscription body, is compact JSON ending
  in a single LF: a missing final LF, CRLF or whitespace between tokens is
  `LOG_LINE_FORMAT` for the log (an inscription is `undecodable`). This is
  the asset log's rule only: did:vh and did:webvh signer and alias logs keep
  their own method's rules. No number in an entry is an integer outside the
  IEEE 754 safe range, however written (`1e16`, `9007199254740993.0`;
  `JSON_UNSAFE_NUMBER`).
- **Versions (P4.4).** Resource versions are derived from history. A caller's
  counter is rejected, and an unchanged digest does not advance a version. A
  resource added after genesis starts at version 1.
- **Signing (P5.11).** The signer receives the unsigned entry, the proof options,
  a summary of the Original, the operation and the resource changes, with
  `summary.signer` naming whose key signs (the author, or the editor of an
  editor entry), and `display`, the text `describeEntry(summary)` renders for
  that person (PROVISIONAL wording). `keySigner` refuses anything that is not
  an Originals entry for its own key or whose summary misstates it, passes the
  text to its optional `confirm` callback (returning false refuses), and
  computes the signed bytes itself rather than taking the caller's.

## Verification report — phase 1, extended in later phases

`load`, `verify` and `resolve` return a report that keeps its parts separate:

| Part | Values |
|---|---|
| `history` | valid · invalid (with the first failing entry) · limit-exceeded |
| `authorBinding` | valid · failed (per entry) |
| `identityEvidence` | complete · incomplete, with the latest author DID versionId used, whether it is deactivated (P6.5), and its freshness: established (the log was obtained at the DID's location and its own witnesses approve its latest version) · not-established · stale against the retained versionId (P7.8), with `obtained`: where (`location`, the URL it was retrieved from, or null), when (`obtainedAt`), from what `source`, as of which `latestVersionId`, and whether that version is `witnessed`. `editors` lists the same for each editor DID relied on (P7.8, P5.18); `status` is incomplete when any signer's evidence is |
| `assetFreshness` | not-established · stale against the retained versionId · anchored (the sat's log, as of the read's tip, P9.13), with every compared copy of the asset log (P7.6) |
| `resources` | available · partial (resource and checkpoint missing) · digest failure. Content availability is reported here and nowhere else: missing bytes, current or historical, leave the log verified and are never a verification failure (P7.3, P7.4, P9.18); bytes that are supplied are always checked, and a mismatch fails |
| `ordering` | claimed · anchored (P7.6). Asset logs have no witnesses (Q14), so an unanchored Original's ordering is claimed only |
| `fork` | the version at which known branches diverge and each branch's entry there. A fork not on Bitcoin is an unresolved conflict with no current branch (owner decision Q5); only an anchor settles one (P9.16) |
| `anchors` | every anchoring entry (phase 4) |
| `ownership` | none · provisional, with confirmation depth and index agreement (P9.11, P9.16): no index lists every sat, so ownership is never more than provisional |
| `validAsOf` | for a valid result, anchored or not, `{ checkpoint, signers: [{ did, role, versionId, obtainedAt, source, location }] }`: the checkpoint the result is valid as of, and for the author and each editor that signed through it, the latest DID versionId relied on and when and where that history was obtained (P7.8, P7.10). Null when the checkpoint does not verify (failed or limit-exceeded history, failed binding, incomplete identity evidence, a failed digest) or the Original is forked. A stale prefix is still valid as of its own checkpoint |
| `historicallyAuthorizedOnly` | each entry through the checkpoint whose key the latest verified state of its signer's DID no longer lists (`key-not-in-latest-signer-document`), whose editor DID is deactivated (`signer-did-deactivated`), or any entry once the author DID is deactivated (`author-did-deactivated`) (P7.9, P6.5, P5.18). It does not invalidate the checkpoint; any result including such an entry lists it |
| `current` | never true for an Original that is not anchored, however fresh the evidence (P7.10): off Bitcoin nothing shows that a newer entry or another branch does not exist. Only an anchored Original's state from its sat can be current |
| `reasons`, `retain` | why the result is not current (`not-anchored` for every unanchored Original, then anything else that applies); the highest versionIds to keep for the Original and each author DID, never lower than those supplied |

`AuthorDidEvidence` carries `obtainedAt` (ISO 8601) and `source` (`package`,
`host`, `fetched`, `retained` or `supplied`). The SDK stamps evidence it
obtains: a package's when it is read, a hosted snapshot's, a log retrieved
with `identityFetch`, and evidence its store kept (with the time it was first
obtained). Evidence passed in `authors` keeps the caller's `obtainedAt`, and
is reported with null when it has none, never a guessed time.

Errors are `OriginalsError` (a `StructuredError`) in one of these categories:
`invalid-evidence`, `incomplete-evidence`, `unsupported-profile`,
`unauthorized-key`, `author-binding`, `outside-grant` (a change outside an
editor's grant, or one only the author may make), `stale-parent`, `fork`,
`deactivated`, `unavailable-bytes` or `limit-exceeded`.

## Evidence package — phase 1, implemented (PROVISIONAL format, D4)

The package is an uncompressed ZIP containing `originals-evidence.json` (the
manifest), `asset/did.jsonl` through the checkpoint, the DID histories of
every signer (the author and each editor that signed an entry, P7.1) under
`signers/<hex sha256 of the DID>/` (`did.jsonl`, and `did-witness.json` where
that DID's method has witnesses; `signerPath(did)`), and the resource bytes
under `resources/<digest>`. There is no asset witness file: asset logs have
no witnesses (P9.8). PROVISIONAL (P14.10, section 14;
BREAKING): the directory was `authors/` and an
`asset/did-witness.json` was written; neither is written or read any more,
and a package or hosted snapshot carrying them is rejected
(`EVIDENCE_LAYOUT`). The manifest records the packager's head, so a
package of an earlier checkpoint is never reported as the latest state (P7.6).
The manifest names the Original, the profile and the target checkpoint, and
declares the package complete or partial, listing any missing items. Each
has exactly the members of its kind (P14.10): `{ kind: "resource", resource,
version, digest, versionId }` or `{ kind: "identity", did, role: "author" |
"editor" }`, with `role` required; anything else is `EVIDENCE_MANIFEST`. The
landing host lists a signer DID history it does not hold as an identity
item, so a hosted snapshot is complete only when no resource version and no
signer history is missing. Archive names are at most 255 UTF-8 bytes, for
the reader and the writer (`ARCHIVE_PATH`; previously UTF-16 code units).

Import bounds sizes and counts before extracting anything. It rejects absolute
paths, `..` segments, symbolic links and duplicate entries. It never replaces a
newer local history with an older prefix (P7.5). Loading a package never
confers signing authority (P8.4).

The SDK and resolvers do not encrypt. Plaintext metadata and base64 are not
confidentiality (P8.2).

## Author DID rotation, freshness and forks — phase 2 (implemented)

Rotation is an author DID update. Entries naming the new author DID version
can use the new key without any asset log entry (P5.10). An unanchored entry
signed by a key the latest author DID no longer lists is reported as
historically authorized only, with unproven ordering, whatever time it claims
(P7.9); it stays part of a valid checkpoint.

An unanchored Original is never current (P7.10; originals-spec #46): a valid
one is reported valid as of its verified checkpoint. There is no freshness
policy off Bitcoin; the `freshness: "asserted"` option was removed (breaking).
Freshness is still reported per log (P7.8): `established`, `not-established`
or `stale`. A log obtained at a location establishes freshness (`established`) only
when the DID's own witnesses approve its latest version, that version's `id`
names the location it was obtained at, and that is the location the latest
entry the identity signed names (P7.8, P5.14; owner decision of 23 October
2026; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges). Watchers are not consulted, so a
log supported only by watchers is reported not established. Otherwise freshness is `not-established`
(or `stale`), and the report states where, when and as of which version the
history was obtained (`identityEvidence.obtained` and each editor's:
`{ location, obtainedAt, source, latestVersionId, witnessed }`).
`describeFreshness(did, evidence)` (`@originals/vh/originals`) says it in
plain words, as the CLI and the landing show it: "The history of <did> was
obtained from <location> at <time>; its latest version there is <versionId>.
Its freshness is not established. The DID may have a newer version, for
example one that removes a key, that this verifier has not seen."
The store retains the highest versionId it has verified for each Original and
each author DID.
Of the signer DID evidence a package or host supplies, the `authors` option
configures and the store keeps, the one with the newest verified version is
used, compared by the versionIds that verify and never by bytes: an older log
that differs only in formatting or a final line feed never rolls a newer one
back, so an entry whose key that newer version removed is still reported
historically authorized only (P7.8, P7.9; originals-spec #47,
merged). The newest verified versionId held is compared against as
retained. Evidence whose verified versions diverge from another's is an
identity fork: incomplete identity evidence (`AUTHOR_DID_FORK`), never the
package's history.
Evidence that falls short of a retained versionId is `stale`; the result is
valid as of its own, older checkpoint.
Evidence that diverges from it is a fork (for the Original) or incomplete
identity evidence (for an author DID). Reads, commits and imports advance the
retained versionIds; `load` only compares against them.

Divergent valid branches are an unresolved fork with no branch current. An
import that diverges from the local log returns `conflict` and the store keeps
the other branch, so every later read reports the fork with both branches
(P6.6), with no branch valid as of a checkpoint (`validAsOf` null). Edits
continue on the local branch. Only
anchoring on Bitcoin settles a fork (owner decision Q5, P9.16). Import never
replaces stored author DID evidence with an older or diverging history.

Stores implement `getRetained`/`putRetained` and `putBranch`/`getBranches` in
addition to the phase 1 methods; `MemoryStore` and `FileStore` do.

## Editors (P5.15–P5.18, implemented)

The author grants editors in the asset state; an editor signs its own entries
with its own DID through the normal edit API, and the author does not
countersign them:

```ts
// PROVISIONAL member names (D4). Absent means no editors.
const editors = [
  { did: bobDid, name: false, metadata: false, resources: ["photo"] },
  { did: carolDid, name: false, metadata: true, resources: [] },
];
await sdk.create({ name, resources, author, signer, editors });
await sdk.edit(did, { parent, editors: [...], author, signer });   // the author grants, narrows or revokes
await sdk.edit(did, { parent, editors: null, author, signer });    // removes every grant
await sdk.edit(did, { parent, resources: [{ id: "photo", bytes }], editor: bobRef, signer: bobSigner });
```

- A grant names one editor DID, unique in the list, using a method P5.8
  lists (did:vh, did:webvh, did:btco), never the author DID or a DID of the
  author's identity (for a did:webvh author, any did:webvh with its SCID).
  `resources` are resourceIDs of the Original's current resource set. At most
  `ORIGINALS_LIMITS.editors` (32) grants (P7.7). An empty list is
  not used: no editors means no `editors` member (PROVISIONAL).
- An editor entry carries `editor: { did, verificationMethod, versionId }` in
  its signed state. It is checked against the grant in its parent's state, so
  a grant, a change to it and a revocation take effect from the next entry
  (P5.17). Its author reference is its parent's, its operation is update, its
  parameters are empty, and only the name, metadata and resources the grant
  allows change. Only author entries add or remove resources, change grants,
  aliases, lifecycle or parameters, start an Original, anchor it or deactivate
  it. A change outside
  the grant is refused before anything is signed (`outside-grant`); an editor
  with no grant is `unauthorized-key` (`EDITOR_NOT_GRANTED`).
- Editor keys follow the author key rules against the editor DID (P5.3,
  P5.10–P5.14, P7.8, P7.9): an entry by a key the latest editor DID no longer
  lists, or by a deactivated editor DID, is historically authorized only;
  versionIds never go backwards per signer identity (P5.8). Once the author
  DID is deactivated every entry, editor's included, is historically
  authorized only (P5.18, P6.5). Editors rotate, remove keys or move only in
  their own DIDs.
- A grant never names the Original itself: its did:vh or any of its aliases,
  including the anchoring sat's did:btco, so holding the sat confers no edit
  authority (P5.15, P9.12; `STATE_EDITORS`).
- An editor entry and a revoking author entry with the same parent are a fork,
  unresolved until anchoring (P6.6). Branch length and the number of signers
  decide nothing; an entry bringing content from another branch is an ordinary
  single-parent entry and the fork remains. After anchoring, chain order on
  the sat decides: whichever is inscribed first extends the head, and the
  other does not (P5.17, P9.13).
- Anchored editor entries (P5.18, P9.15): an editor entry inscribed on the
  anchoring sat is checked against the editor DID's state at its inscription
  time, exactly as an author entry is against the author DID's (versionTime
  with the named-later-version exception for did:vh and did:webvh, chain order
  for did:btco, P5.13), and is refused once the author DID's state at its
  inscription time is deactivated (`author-deactivated-at-inscription-time`).
  The `author-*` reasons of `anchoring.ignored` name the signer DID's state.
  An editor entry inscribed by the sat's holder is accepted (P9.12); only an
  author entry anchors.
- Editor authority is VH-Log PR 11's "Editors from a Controller" [S25]
  (swcurran/VH-Log#11 at `2fe380dbf`, treated as merged): the generic engine's
  editor hook (`ControllerKeys.editors` in `@originals/vh/log`) enforces that
  an editor entry is not the genesis entry, sets no parameter
  (`EDITOR_PARAMETERS`, so an editor deactivation is refused there), is checked
  against the editors in its parent (`EDITOR_NOT_GRANTED`), leaves the grants
  unchanged and carries one proof by its editor; the Originals profile
  supplies the grants, the `editor` reference, the editor key rules and the
  grant's scope. No signer is required to use did:btco.

## Moved author DIDs — identity continuity (P5.14, implemented)

A did:webvh author DID can move to another host or path under the did:webvh
method's portability rules: `portable: true` at genesis, then a version whose
document `id` is the new DID with the same SCID and the prior DID in
`alsoKnownAs` (didwebvh-ts writes such moves with `updateDID({ domain })`).
The identity is still the DID at genesis, and every entry keeps naming it as
`author.did`. An entry names the verification method as it appears at the
version it names, so after a move it is `<new DID>#key`:

```ts
const author = { did: identityDid, verificationMethod: `${movedDid}#orig-2`, versionId: afterMove };
```

- P5.3 is checked against the document `id` at the named version: the
  method's id must be in that `id`'s namespace and its controller must be
  that `id`. A method that kept the old DID as its controller across a move
  (as didwebvh-ts writes one) fails author binding; rotate to a method of the
  new `id`. Entries signed before the move keep verifying against the
  versions before it.
- The author's history is the identity DID's own log, verified from genesis,
  with the same SCID. `alsoKnownAs`, a log with another SCID, a redirect, a
  host's claim or a change of DID method never makes another DID the author.
  Histories are looked up by the identity DID (evidence packages already file
  them under it).
- A reader finds a moved log in the evidence package, or, with the SDK's
  `identityFetch` option, at the location of the DID in the verification
  method id of the latest entry the identity signed, without redirects
  (`safeFetch` refuses them). That entry is the latest one that verified
  with the evidence the reader holds, so an appended line whose proof does
  not verify cannot choose the request. A reader holding no evidence that
  verifies any entry of that identity can check no proof before retrieving
  (P5.14; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges): it first asks the location named by the earliest chained
  entry the identity signed (for the author, the genesis entry, which is
  bound to the Original's SCID), and the latest chained entry's location
  only when that gives no usable log. A log found first verifies the
  entries, and the latest verified entry's location is then asked. An
  unverified line can choose a request, never the result. A log retrieved
  from the latest verified entry's location that verifies and extends
  the other evidence is used. Retrieval alone does not establish its
  freshness: that needs the DID's own witnesses to approve its latest
  version, whose `id` must name the location (P7.8; owner decision of 23
  October 2026; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges). Otherwise the identity's freshness is not established, and
  the report states the URL, when it was retrieved and its latest
  versionId. Either way an unanchored Original is only valid as of its
  checkpoint (P7.10). Editor entries
  carry their parent's author reference, so they never reveal where a moved
  author now is: the author's location comes from the latest author entry.
  The same applies to each editor DID.

```ts
const reader = OriginalsSDK.create({ store, authors: [], identityFetch: async (url, o) => (await safeFetch(url, o)).bytes });
```

- An Original's own did:webvh alias moving is an alias change by an author
  entry; it does not affect author binding.

## No witnesses (owner decision Q14)

Asset logs never activate VH witnesses: an entry that sets the witness
parameter to anything but `{}` is rejected (`WITNESS_NOT_PERMITTED`), and
`{}` too, since an entry's parameters have exact members (P14.1,
`PARAMETER_MEMBERS`). On the
local and web layers an Original is author-signed with claimed ordering.
Accepted consequences: a stolen author key can make a branch before its
removal, which is historically authorized only once the key is removed
(P7.9) and stays an unresolved fork until anchoring; the first valid anchor wins (P9.16), so
authors who need protection should anchor early; and a host can show an old
prefix to a first-time reader (retained versionIds protect repeat readers).
Bitcoin anchoring gives proven ordering, a single history and an owner.

## Hosted publication — phase 3 (implemented)

The author creates a did:webvh alias log on their domain whose document lists
the Original in `alsoKnownAs` (PROVISIONAL, plan 011 S4; the two logs have
different SCIDs). Publishing is an ordinary update that lists the alias in the
asset state (PROVISIONAL: there is no separate publish operation):

```ts
await sdk.publish(did, { parent, author, signer, alias }); // alias: { did, log, witness? }
const files = await hostedFiles(sdk, did, alias);           // Map<path, bytes> under the alias's #files base
```

A resource larger than a hosted reader fetches (`FETCH_LIMITS.maxResourceBytes`,
64 MiB; P8.5, P14.13) can be created and edited locally, since
a local package is never fetched, but it is never published: `publish`,
`hostedFiles` and a shared-host `submit` refuse a log that lists one, at any
version, with `limit-exceeded` `RESOURCE_OVER_FETCH_LIMIT` naming the resource
(`details.resource`, `digest`, `size`, `limit`), before anything is written or
sent. `assertHostable(log)` runs the same check.

An alias counts only in both directions: the asset state lists it and its
latest document points back (P3.6). Reports list each alias as `confirmed`,
`not-confirmed` (with a reason), `unavailable` or `invalid`; an unconfirmed
alias never changes the Original's own result, and the alias log never
supplies state. Asset-log rules (PROVISIONAL): genesis lists no alias; at most
one did:webvh alias; once listed it stays, moving only within its own SCID
(P9.3). `verifyOriginalByAlias`
reaches an Original through its alias and fails with `ALIAS_NOT_CONFIRMED`
unless both directions hold.

Hosted layout (PROVISIONAL), relative to the alias's `#files` base: the alias
log where did:webvh publishes it, and the Original's evidence package unpacked
under `originals/`. The files for a checkpoint are deterministic, so a retried
publication repeats the same snapshot (P9.2). The public reader:

```ts
import { safeFetch } from "@originals/vh/fetch";
const r = await reader.loadPublished(aliasDid, async (url, options) => (await safeFetch(url, options)).bytes, { signal });
r.verified; // the exact snapshot: history ending at its checkpoint, binding, identity, no failed digest, the alias
r.report.resources; // content availability, separately: missing bytes do not fail `verified` (P7.3, P7.4)
r.report.validAsOf; // the checkpoint it is valid as of; an unanchored Original is never current (P7.10)
```

Retrieval is bounded as a whole, not only per file (issue #970). These are
implementation limits (PROVISIONAL), set with the SDK's `retrievalLimits`:

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxRequests` | 1,024 | requests in one call, failed and optional ones included |
| `maxTotalBytes` | `archiveLimits.maxTotalBytes` (512 MiB) | bytes accepted in one call, counted as they arrive, alias log included |
| `maxFileBytes` | `FETCH_LIMITS.maxBytes` (16 MiB) | one response other than a resource: logs, witness files, the manifest (P7.7) |
| `maxResourceBytes` | `FETCH_LIMITS.maxResourceBytes` (64 MiB) | one resource response (P8.5; P14.13); a larger resource is unavailable content, not a failure (P7.4) |
| `requestTimeoutMs` | `FETCH_LIMITS.timeoutMs` (15 s) | one request |
| `timeoutMs` | 120 s | the whole call, so slow or absent optional files cannot multiply the per-request timeout |

The snapshot's own files are also held to `archiveLimits`, the bounds `load`
applies to one package: at most `maxEntries` files and `maxTotalBytes` bytes.
The manifest is checked first. The asset log is unverified, so before anything
it asks for is requested, every line must carry a well-formed author reference
and asset state (else `SNAPSHOT_LOG_INVALID`, in the category of the rule it
breaks) and be at most 65,536 UTF-8 bytes (`ENTRY_TOO_LARGE`, P7.7), and the
whole plan (each signer's log and witness, each resource) must fit the
request and file limits. Each request gets
`{ maxBytes, timeoutMs, signal }`: the smaller of its own cap and what is left
of the budget. A fetcher that ignores them is still bounded, because the SDK
checks every returned size and stops waiting at the deadline. Exhausting a
budget is a `limit-exceeded` error, `RETRIEVAL_BUDGET_EXCEEDED`, whose
`details.limit` names the limit (`requests`, `bytes`, `archive-bytes`,
`archive-entries` or `time`). Aborting `signal` is `RETRIEVAL_ABORTED`. Neither
is ever a result, and nothing is assembled into an archive.

`@originals/vh/fetch` retrieves HTTPS only, with no credentials, no redirects,
no private or special-use address before or after DNS (connecting to the
vetted address), and caps on size and time, which a caller's `signal` can end
sooner (FETCH_ABORTED); every refusal is
`unavailable-bytes` (P8.5). `servingHeaders(mediaType)` gives the P9.7 headers:
the signed type, `nosniff`, a script-free sandboxing CSP, and `attachment` for
active types. Hosts must also serve resources from an origin without user
credentials, and clients must escape names and metadata.

## Shared-host saves (implemented; P6.4, P6.7, P6.8)

A host that accepts entries for one Original from several signers serializes
them: one accepted append at a time at that host. It is not consensus and does
not prevent forks published elsewhere (P6.6). The SDK talks to it through a
`SharedHost` (`submit(submission)` and `accepted(original)`); the transport is
the host's.

```ts
const draft = await sdk.prepareEdit(did, { parent, resources, author });
const candidate = await sdk.sign(draft, signer); // verified against the exact parent; not history yet
const saved = await sdk.submit(candidate, host);
// saved.status: "accepted" | "already-accepted" -> committed locally; saved.hostHead, saved.behind
//               "stale-parent"                  -> saved.refused is kept, labelled "refused"
const kept = await sdk.refused(did);             // each with its signed entry and its draft
await sdk.sync(did, host);                       // fetch and verify the host's accepted log
await sdk.reconcile(did, {
  host, refused: kept[0].versionId, author, signer,
  change: ({ head, refused }) => ({ resources: [...] }), // the caller's reconciled change; required
});
```

- **Local commit.** A shared-host save signs and verifies the candidate
  against the exact local parent (P6.1, P6.4) and commits it locally only once
  the host answers `accepted` or `already-accepted`. A candidate whose parent
  is no longer the local head is a `STALE_PARENT` conflict before anything is
  sent. Once an Original is shared-hosted, save through `submit`: a plain
  `commit` advances only local history, and the host refuses anything that
  does not extend its head.
- **Retries (P6.4, P6.7).** A retried candidate is sent byte for byte. A host
  that already accepted it answers with its checkpoint and its current head;
  the SDK commits it locally and reports `behind: true` when the head has
  moved on. `submit` keeps the candidate as pending (`putPending`) before it
  is sent and forgets it once the host answers, so after a lost answer or a
  crash `sdk.pending(did)` returns it to submit again, never a new candidate
  for the same change. A candidate already committed locally that the host
  refuses as stale is a fork with the host (`fork`, `HOST_DIVERGES`), not a
  refused candidate.
- **Refused candidates (P6.8).** After a stale-parent answer the store keeps
  the refused signed entry and its new bytes (`putRefused`; the bytes are
  content addressed and are never a version on their own). Local history does
  not move. `commit`, `sign` and `submit` refuse a refused candidate with
  `CANDIDATE_REFUSED`; `package`, `hostedFiles` and verification read only the
  committed log, so a refused candidate is never packaged, published or
  inscribed. Publishing it would fork the Original (P6.6). A log that carries
  a refused candidate, arriving through `import` or `sync`, is kept as a
  branch (`conflict`) and never committed.
- **Reconcile (P6.8).** `reconcile` fetches the host's accepted log and
  verifies it. A log that extends local history becomes local history; one
  that diverges is kept as a branch and reconcile fails with `fork`
  (`HOST_DIVERGES`). The new candidate's parent is the new head and its
  content is what the caller supplies: the SDK never merges. The signer's
  request summarizes the change from the new head (P5.11), and the SDK never
  signs on anyone's behalf. Once the reconciled candidate is accepted, the
  refused one it names is dropped.
- **What a host judges with (P7.8, PROVISIONAL).** A host verifies each
  submission with the signer DID logs it holds, or a submitted one that
  verifies and extends what it holds. A host never sent a newer DID log,
  for example one deactivating the author DID or removing a key, accepts an
  entry that log would refuse: the host judges with the identity evidence
  it holds, and its acceptance does not establish freshness (P7.8). Readers
  judge for themselves with the newest evidence they can get, and an entry
  that newer evidence makes historically authorized only is reported so to
  them (P6.5, P7.9). Sending
  the newer log to the host (with a save, or by the owner) makes it refuse
  such entries from then on.
- **Forks.** A refused candidate published elsewhere is a fork, unresolved
  until anchoring; branch length, number of entries and which keys signed
  decide nothing. An entry that brings content from another branch is an
  ordinary single-parent entry on its own branch, and the fork remains (P6.6).

Stores implement `putRefused`/`getRefused`/`dropRefused` and
`putPending`/`getPending`; `MemoryStore` and `FileStore`
(`<root>/originals/<scid>/refused/`, `<root>/originals/<scid>/pending.json`) do.
`sdk.retrieveHosted(aliasDid, fetch)` reads a hosted snapshot, unverified and
within the `loadPublished` bounds, for a host's `accepted`.

The landing host (`apps/landing/server/shared-saves.ts`, PROVISIONAL wire
format) takes `POST /api/originals/submit/<domain>/<user-slug>/o-<name>` with
`{ original, entry, resources: { digest: base64 }, identities }` and answers
`200 { status: "accepted" | "already-accepted", checkpoint, head }` or
`409 { status: "stale-parent", head }`; anything else is an error. It checks
byte-identical retries first, then that the entry chains to its head, then
cheap checks (the signer is the author or granted in the head's state, and its
key at the named version verifies the proof), then that it verifies under the
profile against the head, using the submitted signer DID log where it extends
the one it holds, and that the new entry is not historically authorized only
(`422 { error: "entry_historically_authorized_only", reason }`: no removed
key, no deactivated editor DID, no deactivated author DID; P7.9, P6.5,
P5.18). It never asks that the head be current, which no unanchored Original
is (P7.10). It writes new bytes and DID logs, then the asset log (the commit
point: the save is accepted from then on), then the manifest, which the next
request repairs if its write failed, and stores the exact submitted line.
Resource bytes are served only once the accepted log lists them, with the
media type it declares. The body is read with a byte counter, and identities,
their size, resources and queued submissions per Original are bounded
(PROVISIONAL). Submissions for one Original run one at a time in-process and
the head comparison and log replace are one synchronous step, which assumes
one server process per data directory (the landing's instance lock enforces
it); several instances would need a shared compare-and-swap on the head. The
signed entry authorizes the change; the caller only decides who may spend the
namespace owner's quota (owner decision of 22 October 2026). The caller must
be the namespace owner, or an account whose landing DID the head state names
as the author or a granted editor (P5.15): a did:webvh on the Original's host
whose one path segment is the account's slug. Any other caller is refused
(`403 { error: "caller_not_authorized" }`) against the head the save would
extend. A byte-identical retry is acknowledged (P6.7, C12-128) to a caller
allowed at the matching entry's parent, named by that parent's state (which
names any valid signer of the entry, P5.16, P5.17), so an editor whose grant was revoked after its entry
was accepted still gets `already-accepted` with the checkpoint and current head
(owner decision of 23 October 2026). A caller that no line of the hosted log
names is refused before its body is read. Every caller refusal is the same 403;
that is hygiene, not confidentiality, since the hosted log is public. Accepted files stay the
namespace owner's.
Once hosted, an asset log changes only through the submit route: an upload
(PUT) may create it or repeat it byte for byte (a retried publication, P9.2),
never roll it back or advance it unverified; a signer's DID log and witness
file only grow.

## Bitcoin anchoring and ownership — phase 4 (implemented in the SDK; the landing's path, PR 10b, is behind `bitcoinAnchoring`, off)

The representation is [plan 012](../../plans/012-bitcoin-representation.md)
(owner decision Q15). An Original can be anchored from the local or the web
layer, once, terminally, to one sat (P9.10):

```ts
await sdk.anchor(did, { parent, author, signer, sat: "did:btco:reg:5000000000" }); // the anchoring entry
// (refused with ANCHORING_LOG_TOO_LARGE, nothing committed, if the log through it would exceed 350,000 bytes)
// Publish the next committed entry on the anchoring sat (`@originals/sdk/originals/bitcoin`, kept out
// of the browser-first entry). The first funding UTXO must hold the sat at offset 0. Until Bitcoin shows
// the anchor, the inscription is the whole stored log from genesis through the anchoring entry; then one
// entry, the one after Bitcoin's head. `versionId` names it explicitly; it is refused unless it is next
// (HEAD_NOT_NEXT). Every read names the index serving it (`index`, P9.11); `indexes` adds independent
// ones, whose reads are compared (P9.10 SHOULD: an index you run, or two independent ones):
const read = { provider, clock, index: "ord@node-a", indexes: [{ provider: other, index: "ord@node-b" }] };
// recoveryStore is required: a pair for the same entry that can still land refuses a second one
// (PAIR_IN_FLIGHT) unless `replaces: [recoveryId]` says it is a deliberate replacement (P9.6).
// `recoveryStore: null` skips that check deliberately (pair.inFlightGuard: "skipped").
const pair = await prepareEntryInscription({ sdk, did, fundingUtxos: [satUtxo, feeUtxo], satSigner, changeAddress, feeRate, network, ...read, recoveryStore });
pair.carries;   // the versionIds in the body: genesis..anchoring entry, or the one entry
pair.offChain;  // what Bitcoin will not hold: { resources, identities (did:vh/did:webvh signers), onBitcoin, replication: "not-guaranteed" }
// Send it: re-reads the sat and verifies through the entry again (still next, no other pair in flight, the indexes
// agree, the sat still in the pair's funding input; P9.6, P9.10, P9.18), then persists before each broadcast.
// A replacement keeps the `replaces` it was prepared with (pair.replaces).
await submitEntryInscription({ sdk, did, pair, ...read, provider, recoveryStore });
// after a crash: resumeEntryInscription({ sdk, did, ...read, recoveryStore, recoveryId }) sends the same pair once catchUp
// says to (re-verified, P9.18). submitPreparedInscriptionOnSat and resumeInscriptionOnSat, also exported, are the
// unchecked low-level calls: they broadcast stored bytes without any Originals check.
const published = await readAnchored(sdk, did, { ...read, recoveryStore });  // what Bitcoin shows: the durable boundary (P9.4)
published.publication; // "pending-bitcoin-acceptance" while the anchor is observed but not shown; then "anchored" (P9.18)
published.recoveryIssues; // damaged or inconsistent recovery records, skipped: [{ recoveryId, code, message }]
const pending = await nextPendingEntry(sdk, did, read); // { committed, accepted, acceptedHeight, next, queue, remaining, publication }
// Catching up, one step at a time, from a fresh read and the recorded pairs. A store with `list()`
// (Node: fileRecoveryStore(dir) from `@originals/sdk/originals/fs`) finds them itself after a restart;
// otherwise pass `recoveryIds` (their commit txids):
const plan = await catchUp({ sdk, did, ...read, recoveryStore });
// plan.action: "prepare" (prepareEntryInscription, then submit) | "resume" (resumeEntryInscription(plan.recoveryId))
//            | "wait-for-confirmation" (a pair for the next entry is out) | "done"
//            | "wait-for-evidence" (the pair is on the sat, but this writer lacks the signer DID version it names,
//              plan.signer at plan.signerVersionId: supply that history; nothing is prepared over it)
//            | "wait-for-bitcoin" (indexes disagree on the sat or its holder: nothing is prepared, sent or resumed;
//              prepare and submit refuse INDEXES_DISAGREE) | "refused" (the recorded pair no longer
//              verifies, P9.18: nothing is sent; plan.commit and plan.ifRevealed say what broadcasting it would do)
// Or by hand: pass what an adapter read from the sat:
// Running max of header times (P9.15), reorg-aware. `prev` is Core's previousblockhash: give it.
const clock = new InscriptionClock(async (height) => ({ time, hash, prev: previousblockhash }));
// A server: batched headers, a durable store and budgets (see "Inscription time at scale" below).
const served = new InscriptionClock(header, { network: "mainnet", headers, store: fileClockStore(path), maxRequests: 1000 });
// One read per index used; the verifier compares their placement (P9.10, P9.11).
const evidence = await satEvidence(snapshot, { clock, ownerConfirmations, index: "ord@node-a" });
const view = await sdk.get(did, { bitcoin: [evidence] });                     // also load(zip, { bitcoin })
view.report.anchoring; // anchor, conflicting anchors, accepted, ignored and disputed inscriptions, indexes, copy, change, tip
view.report.ownership; // { status: "provisional", sat, output, confirmations, indexes: ["ord@node-a"] }
// Without any copy of the log: verifyOriginal({ bitcoin: [evidence], authors }) (P9.17, P9.18).
// Transferring the sat: hand the recipient what Bitcoin does not hold, through the head Bitcoin accepts
// ({ through: "committed" } for the committed head); the recipient checks it against the sat it received.
const handoff = await transferHandoff(sdk, did, read);       // { package (evidence package), offChain }
const received = await verifyHandoff(recipientSdk, handoff.package.bytes, { ...read, expectedSat: "did:btco:reg:5000000000" });
received.report.ownership?.output;                           // compare with the output the sat was received in
```

- Three heads are kept apart. The committed head is the stored log's last
  entry, signed locally. A prepared or pending publication is a pair in the
  recovery store, built or broadcast; it never advances anything (P9.4). The
  accepted head is the last entry Bitcoin shows on the sat under the
  1-confirmation policy, re-read every time. Entries between the accepted head
  and the committed head are published in order, each inscribed verbatim (the
  stored signed line, the same versionId and parent), never re-signed or
  rebased (P9.6). `catchUp` keeps one publication in flight: it resumes a
  recorded pair for the next entry rather than preparing another, waits while
  its reveal is unconfirmed or not yet indexed, skips records for entries
  Bitcoin already accepted, and prepares a replacement only when Bitcoin
  confirmed and ignored the earlier inscription for good (`replaces`; one the
  read shows unconfirmed or disputed is waited on, and so is one it reports
  `later-inscription-unverifiable`, whose signer DID version the writer has
  no verified copy of: `wait-for-evidence` names the signer and version, P9.12,
  P9.15, P5.6). A pair can still land
  only while the sat read shows the sat in its funding input or its own
  outputs, before the anchor is accepted as after; among several the one
  furthest along on the network wins, then the lowest recovery id. A
  broadcast pair the provider reports in neither its mempool nor the chain
  (`inMempool: false`, evicted or rejected) is resumed as the same pair on
  that read: resubmitting identical bytes is idempotent and spends nothing
  new. Before a resume the log is verified through the entry again (P9.18);
  a pair that no longer verifies is `refused`, never broadcast, with
  `commit: "not-observed" | "mempool" | "confirmed"` (a confirmed commit
  holds the sat until its reveal spends it, and that reveal would be
  `ifRevealed: "ignored-by-bitcoin"`, or `"unverified"` when only evidence is
  missing). Reads compare every index given (`indexes`); while they
  disagree on the sat (`unverified` or `disputed` inscriptions) or on the
  output holding it (`holders`), nothing is prepared, submitted or resumed:
  `catchUp` says `wait-for-bitcoin` before looking at any recorded pair (so a
  pair the sat may have left is never labelled `resume`), and
  `prepareEntryInscription` and `submitEntryInscription` refuse with
  `INDEXES_DISAGREE` (`incomplete-evidence`). Each recovery record is validated (its
  declared txids must be its bytes'); a damaged one is skipped and listed in
  `recoveryIssues`, so one bad file in a shared directory blocks nothing. So each accepted
  inscription lands in a later block than the one before (P9.13), and a
  reorganisation re-derives the queue from the head Bitcoin shows. A head
  Bitcoin shows that the store does not hold is refused
  (`BITCOIN_HEAD_NOT_STORED`); nothing is rebased onto it. `catchUp` reads
  the recorded pairs from the store's optional `list()`; for a store without
  one, the caller passes the recovery ids it saved (`RECOVERY_IDS_REQUIRED`
  otherwise). `fileRecoveryStore(dir)` (Node) keeps one file per pair, written
  to a temporary file, fsynced and renamed, so a record survives the process
  being killed and a write torn by a crash is never read. Its records hold
  signed spending transactions: keep the directory private. The regtest
  restart journey kills a writer between commit and reveal and resumes the
  identical pair in a fresh process (#975).
- **What is inscribed (P9.17).** Until Bitcoin shows the anchor, the next
  inscription is the whole stored log from genesis through the anchoring
  entry: the exact stored lines, in order, the anchoring entry last
  (`pair.carries`). After the anchor, each inscription is exactly one entry,
  the successor of Bitcoin's accepted head. Entries committed after the
  anchoring entry before the anchor is accepted are not in the anchoring
  inscription; they go one per later block once it is accepted. No metadata.
  A body over 350,000 bytes is refused (`ANCHORING_LOG_TOO_LARGE` for the
  anchoring inscription, also by `sdk.anchor` before it commits; a single
  later entry over it is `INSCRIPTION_TOO_LARGE`).
- **Verified before inscribing (P9.18).** `prepareEntryInscription` packages
  the stored log through the entry it publishes and verifies it as a fresh
  reader would: history, author binding, the identity evidence of every signer
  through it, the author and each editor, and the signing key still in its
  signer's latest DID state (Bitcoin would refuse it otherwise, P9.15). Any
  failure refuses to build the pair: `ANCHORING_NOT_VERIFIED` for the
  anchoring inscription, `ENTRY_NOT_VERIFIED` for a later one, with
  `details.problems` and the report; missing identity evidence is
  `incomplete-evidence`. Resource availability does not gate it: missing
  bytes are listed, never a reason to refuse (P7.4). Freshness is not gated
  either; it stays a reported policy. Time passes before the pair is sent, so
  `submitEntryInscription` checks again before the first broadcast: the entry
  is still the next one Bitcoin can accept (`HEAD_NOT_NEXT`), no other pair
  for it can still land (`PAIR_IN_FLIGHT`; the `replaces` the pair was
  prepared with still apply), the indexes agree (`INDEXES_DISAGREE`), the sat
  read still shows the sat in the pair's funding input (`SAT_MOVED`, or
  `SAT_HOLDER_UNKNOWN` when neither the read nor the funding output shows it;
  ord names no holder for a sat without an inscription, so the funding output
  is asked for its first sat), the pair inscribes the
  stored bytes (`PAIR_BODY_MISMATCH`) and the log still verifies through it.
  `submitPreparedInscriptionOnSat` and `resumeInscriptionOnSat` skip all of
  that: send a pair promptly through them only right after preparing it, or
  to force a rebroadcast deliberately.
- **Pending Bitcoin acceptance (P9.18).** Between broadcast and acceptance the
  anchor's checks depend on its position (P5.13, P9.15, P9.16), so the result
  is labelled `publication: "pending-bitcoin-acceptance"` on `readAnchored`,
  `nextPendingEntry` and every `catchUp` step, as long as the recovery store
  holds a pair of the anchoring body that can still land and that the node
  shows: its commit or reveal confirmed (a confirmed reveal not yet indexed
  included), or in its mempool where the provider reports `inMempool`
  (`RegtestProvider` does; `QuickNodeProvider` reports mempool entries). A
  pair submitted but not observed (rejected, evicted, or a provider without a
  mempool view) is `submitted-unobserved`, never pending acceptance.
  P9.18 as originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges: a submitted
  inscription the network is not observed to hold is "submitted, not
  observed", so a rejected or evicted anchor is not reported as on its way;
  master's P9.18 names only "pending Bitcoin acceptance". Once
  Bitcoin shows it the label is `anchored` and the Original verifies as
  anchored. Without a recovery store the label cannot see the pair and reads
  `not-anchored`; `unverified` means Bitcoin evidence is missing or
  disputed.
- **What Bitcoin will not hold (P9.18).** `pair.offChain` lists every resource
  version the log through the entry commits to (inscriptions carry only their
  descriptors) and every did:vh or did:webvh signer DID, author and editors,
  whose history a reader needs (did:btco signers are on Bitcoin and listed in
  `onBitcoin`). Each says whether this SDK holds it. The profile does not
  replicate them or guarantee their availability: keep them, publish them on
  the web layer, or give them to the sat's next holder. An author who wants
  Bitcoin to be all a reader needs uses a did:btco author DID and grants only
  did:btco editors (P5.15).
- **Transfer handoff (P9.18).** Selling or giving the Original is moving the
  sat; it needs nothing from the author. `transferHandoff(sdk, did, read)`
  returns an evidence package (the log, the off-chain signer DID histories and
  the resource bytes this SDK holds; did:btco histories are listed as missing,
  being on Bitcoin) with its `offChain` notice, for the sender to give the
  recipient. By default it runs through the head Bitcoin accepts, read from
  the sat: entries committed locally but not inscribed are not the
  recipient's Original (P9.12). `{ through: "committed" }` includes them, for
  a recipient who will inscribe them; `{ checkpoint }` names an exact entry.
  Before the anchor is on Bitcoin there is no accepted head
  (`NOT_ANCHORED_ON_BITCOIN`). Called without options it refuses
  (`SAT_READ_REQUIRED`) rather than guess which head to hand over. The recipient's SDK should verify it rather
  than trust it: `verifyHandoff(sdk, zip, { ...read, expectedSat })` reads
  the sat the recipient received and refuses a package anchored to any other
  (`HANDOFF_SAT_MISMATCH`), then verifies the package against it, reporting
  history, binding, identity evidence and resource availability separately,
  and stores nothing. Ownership is the sat's holder, reported separately:
  compare `report.ownership.output` with the output the sat was received in.
  Nothing guarantees the recipient ever gets the evidence.
- **Editor entries** are published like author entries: the sat's holder
  inscribes them, and the pre-inscription check covers the editor's identity
  evidence (P5.16, P9.12).
- The anchoring entry is an ordinary update that adds the sat's did:btco alias
  (`did:btco:<sat>` on mainnet, `:sig:`, `:test:`, `:reg:` elsewhere, P14.12;
  the did:btco method does not yet define the prefixes, proposed upstream as
  decentralized-identity/labs-ordinals-plus#4 [S30]; strict grammar: no sign,
  no leading zeros, below the total supply). From then on the alias never changes, and no did:webvh alias may be
  added, replaced or re-added; the one listed at anchoring may stay or go
  (P9.10, D7).
- The anchoring inscription carries the whole log, genesis through the
  anchoring entry; every later inscription exactly one entry, as
  `application/vnd.originals.vh+jsonl`, with no metadata and at most 350,000
  bytes (P9.17, P14.12; owner decisions, D6; spec PR #50 (open)). So the sat alone verifies the
  log: a stored or packaged copy is only compared (`anchoring.copy`), and one
  that differs is ignored. Entries before the anchoring entry are checked
  against the versions they name, with claimed ordering (P9.15). The writer
  inscribes exactly that (see "What is inscribed" above).
- Placement rests on the index (P9.10): an inscription counts for a sat only
  when every index read supplied reports it on that sat number on that
  network. Indexes that disagree leave it `disputed`
  (`bitcoin-placement-disputed`), and with it everything after it on the
  sat, and disagreement on the holder gives no owner
  (`ownership-indexes-disagree`). A disputed inscription that no index
  reports as an Originals inscription (by media type) cannot be an entry: it
  is ignored as `placement-disputed` and holds back nothing after it. On a
  did:btco DID's sat every disputed inscription holds back what follows.
  Without an anchor the report's head is the copy's last entry before its
  anchoring entry, as for `not-anchored`; with no Bitcoin evidence at all it
  is the local committed head, not current (`bitcoin-evidence-missing`).
- Bitcoin decides from the anchor on (P9.12, P9.13): an inscription counts
  from 1 confirmation on every network, mainnet included (P9.5; depth
  reported) when it extends the head at a strictly
  greater height and passes the author checks at its inscription time
  (P9.15). Entries only in a copy are not current, and a copy can neither fork
  nor make stale an anchored log. Only the anchor and accepted inscriptions
  have `anchored` ordering. The anchor is the first valid anchoring entry in
  chain order across the sats supplied; others, on the same sat or another,
  are conflicting anchors, never current (P9.16). Each anchoring inscription
  checks itself. The store keeps the anchor it reported (`getRetainedAnchor`,
  optional), so an earlier one learned later is reported in
  `anchoring.change` with the owner change (`anchor-changed`), once.
- Resource bytes are not on Bitcoin and not needed for the log: an anchored
  Original without them is reported `resources.status: "partial"` and stays
  current (P7.3, P7.4, P9.18); supplied bytes are still checked.
- The clock checks each inscription's block hash: it rewinds past a
  reorganisation and refuses a block no longer on the chain
  (`BLOCK_NOT_ON_CHAIN`), even one it read before the reorganisation. Before
  reading past the blocks it holds, it checks the highest one against the
  active chain, so an orphaned block's maximum never carries into the new
  chain (#971).
- The holder of the anchoring sat can inscribe anything on it, but cannot
  make reading it fail (P9.12). The sat reader (`getSatSnapshot`) reports a
  delegated or encoded inscription as observed but unsupported (with its own
  metadata, read on a full read: P5.13; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges), and a body
  or metadata past its byte budget or the transport's response cap (for
  example QuickNode's 1 MiB JSON cap) as observed but unread, and reads on;
  `satEvidence` passes them on flagged `unsupported` (PROVISIONAL). The
  verifier ignores a non-Originals one (`not-an-originals-inscription`) and
  rejects a delegated or encoded Originals one (`unsupported-encoding`;
  P9.14, P9.17). An Originals inscription the reader did not read fails the
  read (`SAT_READ_INCOMPLETE`, missing evidence, P9.17), unless what the
  index reports already rejects it: a length over 350,000 bytes
  (`too-large`) or metadata (`carries-metadata`). For an Original's asset
  read, pass `getSatSnapshot(sat, { bodies: 'originals' })`: only
  `application/vnd.originals.vh+jsonl` bodies of at most 350,000 bytes and
  their metadata are fetched, and every other inscription is reported
  `not-requested`, so the holder's other inscriptions cost no body reads (the
  Bitcoin writer's sat reads do this). The
  default, `bodies: 'all'`, reads every body and its metadata, as a did:btco
  read needs (P5.13). The reader's budget (`snapshotBudget` on
  `RegtestProvider` and `QuickNodeProvider`): `maxRequests` defaults to 7 + 5
  per inscription the index lists, so a sat with many entries reads in full;
  `maxListedInscriptions` (default 100,000; more is refused,
  `SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS`) bounds it. At most `maxInscriptions`
  (default 10,000) inscriptions have their body and metadata read, in listing
  order, counting only the ones the read would fetch (with `bodies:
  'originals'`, only Originals inscriptions); every later one is still listed
  and placed, but reported observed but unread (`over-budget`), so
  reinscribing the sat many times does not fail a read (PROVISIONAL).
  `timeoutMs` defaults to
  30 seconds plus 250 ms per listed inscription, at most `maxTimeoutMs`
  (default 10 minutes); an explicit `timeoutMs` is kept as given. Each
  request has its own `requestTimeoutMs` (default 15 seconds,
  `SAT_SNAPSHOT_REQUEST_TIMEOUT`), and at most `concurrency` (default 8)
  reads are in flight. Originals bodies within their size limit are read
  from their own `maxOriginalsBytes` (default 64 MiB), so other bodies,
  bounded by `maxContentBytes` (default 32 MiB), cannot spend it
  (PROVISIONAL). Every reader failure is an `OriginalsError` with a section 6
  category; running out of budget is `incomplete-evidence`
  (`SAT_SNAPSHOT_BUDGET_EXCEEDED`, `SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS`). A
  holder who floods the sat past these bounds still costs an explicit
  incomplete result, never a wrong one; raise the budget to read it.
  PROVISIONAL bound: an unread Originals inscription could be an entry, so
  Originals-typed junk the holder adds is read from the Originals budgets and
  fails the read closed once it exhausts them. About 192 Originals-typed
  inscriptions of 350,000 bytes (some 67 MB of witness data) exhaust the
  default `maxOriginalsBytes`, and more than 10,000 Originals-typed
  inscriptions of any size exhaust `maxInscriptions`. A reader raises them
  through `snapshotBudget` (`maxOriginalsBytes` up to 1 GiB,
  `maxInscriptions` up to 100,000) to read such a sat.
- Signer DID freshness for an anchored Original (originals-spec #47,
  P7.8, P9.15): each did:vh or did:webvh
  signer is checked against the newest version of its DID this verifier
  knows of: the newest it obtained from any source in this verification or
  retained from earlier (the SDK compares a package's or host's evidence
  with what it is configured with and keeps by verified versionIds, never by
  bytes, and uses the newest; evidence that diverges is an identity fork,
  incomplete). It need not show that no
  newer version exists. `validAsOf.signers` states, for each signer, the
  versionId relied on and when and where that history was obtained
  (`obtainedAt`, `source`: `package`, `host`, `fetched`, `retained` or
  `supplied`). An entry inscribed after the newest known version is checked
  against it and is not incomplete identity evidence. An entry before or at
  the anchor naming a version the verifier has no verified copy of is
  incomplete identity evidence (P5.6). After the anchor such an inscription
  never downgrades the accepted head (P9.12, P9.15; owner decision of 23
  October 2026; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges): one naming a version the signer's history shows is not that
  DID's is `invalid-entry` (`AUTHOR_VERSION_NOT_IN_HISTORY`, P5.13). For a
  did:vh or did:webvh that is a version numbered at or below the newest
  verified version but not in its history; for a did:btco whose sat was read
  in full through the inscription (or which is deactivated), any versionId
  that is not one of its versions. One naming a newer version, signed by a
  DID with no history here, or by a did:btco whose sat was not read in full
  through the inscription (an unread or disputed inscription before it, or a
  tip below it), is `later-inscription-unverifiable`, listed in
  `anchoring.unverifiable` with the signer DID and version it names, and the
  accepted head keeps its identity evidence and stays current. The holder of
  the sat decides what is inscribed but has no authority (P9.11, P9.12), so
  otherwise a hash-chained junk entry naming a version that does not exist
  would make the Original incomplete, never current, for good. A verifier
  that obtains the named version verifies the inscription, and reports the
  change of head rather than changing silently (P9.15, as P9.16 for an
  anchor): the retained anchor (`retain.anchor`, kept by the store with
  `putRetainedAnchor`) lists the inscriptions reported unverifiable, and
  when one of them is accepted later `anchoring.headChange` gives the head
  retained before, the head now and the inscriptions verified, with the
  reason `unverifiable-inscription-accepted`, once. A retained
  versionId the evidence falls short of is `stale`, and the result is not
  current. The cost, accepted by the owner: a host that withholds a key
  removal can get later inscriptions accepted by readers who do not know of
  it. did:btco signers are read from Bitcoin (P5.13). Anchoring does not
  require did:btco DIDs for the author or editors (owner decision of 21
  October 2026, #47; nothing in the SDK requires them); a did:btco author is
  how Bitcoin alone suffices (P9.18).
- After anchoring, deactivating the author DID leaves the accepted state
  current and refuses later inscriptions, editor entries included (P5.18); a
  key the author or an editor removes later does not unseat entries accepted
  before (P9.15). See Editors above for editor entries on the sat.
- An anchored log with no Bitcoin evidence is `unverified`, and one whose
  evidence holds no valid anchor is `not-anchored`; neither is current, and
  neither advances the retained versionId. A
  retained versionId that Bitcoin no longer includes is reported as
  `authoritative-source-changed`, and an author DID version that would reject
  an accepted inscription as `retroactive-revocation-conflict`.
- Ownership is the anchoring sat's holder, always provisional, never authority
  (P9.11, P9.12).
- **did:btco author DIDs** (P5.13; method v0.2.0): supply
  `{ did, bitcoin: [await satEvidence(snapshotOfTheDidSat, { index, … })] }`
  as the author evidence, one read per Bitcoin index; their placement is
  compared as for the anchoring sat (P9.10). A version is a confirmed
  inscription that every index reports on the sat number the DID names, on its
  network, whose CBOR metadata is the DID document (strictly decoded), in
  chain order; an inscription the index places on another sat is not a version
  (C12-105), and one the indexes disagree on stops the history there with
  `AUTHOR_PLACEMENT_DISPUTED` (missing evidence). A delegated or encoded
  inscription carries its own metadata, which delegation and body encoding do
  not affect: the sat reader reads it, and it is a version candidate like any
  other (P5.13, P14.12; originals-spec #51, open at `8d6326c1b`; PROVISIONAL until it merges). An inscription whose metadata the reader
  did not read (past its byte budget) stops the history there with
  `AUTHOR_SAT_READ_INCOMPLETE` (missing evidence); it is never skipped. An entry names its version
  by inscription id (PROVISIONAL); `deactivated: true` is terminal. For an
  anchored Original, the version an entry names must precede, in chain order,
  the inscription that carries it, or the anchoring inscription for an entry
  before the anchor: one mined later, even later in the same block, is
  rejected as `author-version-not-yet-in-effect` (C12-92, C12-93, C12-95), because
  its id can be known before it is mined. The author DID's state at the
  inscription is the latest version before it, and the key must hold there
  too (C12-96); there is no later-named-version exception for did:btco, unlike
  did:vh and did:webvh (C12-98). A state the author read cannot establish,
  past its tip or a disputed placement, is `author-version-unavailable`. An
  Original is never anchored to its author DID's own sat. A did:btco author's
  history is read from Bitcoin, not packaged: packages list it as missing
  identity evidence. Spending requires the
  owner's explicit approval, and release evidence comes from real Core/ord
  regtest.

### Inscription time at scale (#973)

The running maximum (P9.15) depends on every header from genesis, so a
reader derives it once and keeps it. `InscriptionClock` takes, besides the
single-header source:

- `headers(from, count, signal)`: a batched source, one request per `batch`
  (default 2000) headers, for example a JSON-RPC batch of `getblockhash` and
  `getblockheader`. Each block but genesis must carry `prev` (Core's
  `previousblockhash`), so the clock checks that each block extends the one
  before it and a reorganisation during a read cannot splice two chains
  together; a block without it is refused (`BLOCK_PARENT_REQUIRED`).
- `store`: a `ClockStore` (`load`/`save` of opaque bytes) with the `network`
  it follows. `fileClockStore(path)` from `@originals/sdk/originals/fs`
  writes one file atomically (Node only); a server can keep the same bytes in
  any blob store. The state holds the network, every block hash and running
  maximum, and a CRC-32. On restart the clock checks the network tag and the
  genesis hash (one request; another network or chain is refused with
  `CLOCK_STORE_NETWORK_MISMATCH` or `BLOCK_SOURCE_NETWORK_MISMATCH`), and
  discards a damaged state (`stats.discarded = "corrupt"`) and rebuilds.
  A saved boundary is then checked against the active chain like any other,
  rewinding to the fork point by galloping and bisection. The store saves
  after `saveEvery` (default 144) new blocks and on `flush()`; an older
  saved state is only slower, never wrong. The bytes are the reader's own
  derived state, not a checkpoint to download or share. The byte format
  and the defaults are PROVISIONAL.
- `maxRequests` (default 10,000 per `at` call) and `signal` (per clock, per
  call or through `satEvidence`): running out or being cancelled is
  `incomplete-evidence` (`BLOCK_TIME_BUDGET_EXCEEDED`, `BLOCK_TIME_ABORTED`),
  never a guessed time. What was derived is kept, so a retry continues.

A read of a block the clock holds costs one request, a probe that the active
chain still has it, so a block orphaned since it was read is refused by hash
(`BLOCK_NOT_ON_CHAIN`) as a fresh clock refuses it. Any other read costs one
boundary check plus the new or reorganised blocks. Each appended block must
extend the one before it: a batched `headers` source must give every block's
`prev` (Core's `previousblockhash`; `BLOCK_PARENT_REQUIRED` otherwise), and a
single-header source without `prev` costs a second request per new block,
re-reading the parent, so give `prev` there too. `bun run --cwd packages/sdk bench:clock` runs a
deterministic 900,000-header synthetic chain (204,786 blocks with a timestamp
earlier than their parent's) through a cold start, warm reads and restarts
with a file store, and checks every sampled time against an independently
rebuilt clock. On an Apple M4 (Bun 1.2.22, in-process source; `--rtt-ms 1`
adds a delay per request):

| Scenario | Requests | Headers | Latency | With 1 ms per request |
| --- | ---: | ---: | ---: | ---: |
| Cold start, batch 2000 | 450 | 900,000 | 422 ms | 959 ms |
| Save state (32.4 MB file) | 0 | 0 | 114 ms | 106 ms |
| Warm reads of known blocks, x10,000 (one probe each) | 10,000 | 10,000 | 25 ms | 12.7 s |
| Warm read, 1 new block | 2 | 2 | 0.3 ms | 3.6 ms |
| Restart, read a known block (load, check and probe) | 2 | 2 | 82 ms | 75 ms |
| Restart, then 6 new blocks | 2 | 7 | 0.1 ms | 3.6 ms |
| Restart across a 6-block reorganisation (+3) | 8 | 16 | 74 ms | 88 ms |
| Cold start, one request per header | 900,010 | 900,010 | 602 ms | about 15 min (projected, not run) |
| Cold start, default budget, one per header | 10,000, then refused | 10,000 | 7 ms | |

The counts are exact and asserted by `tests/unit/originals/clock-bench.test.ts`
on a 20,000-header chain; the latencies exclude a real node's own cost of
serving 900,000 headers, which bounds a production cold start.
