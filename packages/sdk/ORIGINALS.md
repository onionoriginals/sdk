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
  authors: [authorDidEvidence],                 // or (did) => Promise<AuthorDidEvidence | undefined>
  freshness: "asserted",                        // only when the caller vouches its evidence is the latest (P7.8)
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
  resources: [{ id: "photo", bytes, expectedDigest }], // same resourceIDs as genesis (P4.1)
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
`originals verify harbor.zip [--json] [--now <time>] [--freshness asserted]`.

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
- **Versions (P4.4).** Resource versions are derived from history. A caller's
  counter is rejected, and an unchanged digest does not advance a version.
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
| `identityEvidence` | complete · incomplete, with the latest author DID versionId used and its freshness: asserted · retrieved (PROVISIONAL, P5.14) · not-established · stale against the retained versionId (P7.8). `editors` lists the same for each editor DID relied on (P7.8, P5.18); `status` is incomplete when any signer's evidence is |
| `assetFreshness` | asserted · not-established · stale against the retained versionId, with every compared copy of the asset log (P7.6) |
| `resources` | available · partial (resource and checkpoint missing) · digest failure. Content availability is reported here and nowhere else: missing bytes, current or historical, leave the log verified and are never a verification failure (P7.3, P7.4, P9.18); bytes that are supplied are always checked, and a mismatch fails |
| `ordering` | claimed · anchored (P7.6). Asset logs have no witnesses (Q14), so an unanchored Original's ordering is claimed only |
| `fork` | the version at which known branches diverge and each branch's entry there. A fork not on Bitcoin is an unresolved conflict with no current branch (owner decision Q5); only an anchor settles one (P9.16) |
| `anchors` | every anchoring entry (phase 4) |
| `ownership` | none · provisional · established, with confirmation depth and index agreement (P9.11) |
| `current` | true only when every part above passes under the selected policy, except content availability (section 7): an application that needs the content also checks `resources` |
| `reasons`, `retain` | why the result is not current; the highest versionIds to keep for the Original and each author DID, never lower than those supplied |

Errors are `OriginalsError` (a `StructuredError`) in one of these categories:
`invalid-evidence`, `incomplete-evidence`, `unsupported-profile`,
`unauthorized-key`, `author-binding`, `outside-grant` (a change outside an
editor's grant, or one only the author may make), `stale-parent`, `fork`,
`deactivated`, `unavailable-bytes` or `limit-exceeded`.

## Evidence package — phase 1, implemented (PROVISIONAL format, D4)

The package is an uncompressed ZIP containing `originals-evidence.json` (the
manifest), `asset/did.jsonl` through the checkpoint, `asset/did-witness.json`,
the DID histories of every signer (the author and each editor that signed an
entry, P7.1) under `authors/<sha256(did)>/`, and the resource bytes
under `resources/<digest>`. The manifest records the packager's head, so a
package of an earlier checkpoint is never reported as the latest state (P7.6).
The manifest names the Original, the profile and the target checkpoint, and
declares the package complete or partial, listing any missing items (a
missing DID history is `{ kind: "identity", did, role: "author" | "editor" }`).

Import bounds sizes and counts before extracting anything. It rejects absolute
paths, `..` segments, symbolic links and duplicate entries. It never replaces a
newer local history with an older prefix (P7.5). Loading a package never
confers signing authority (P8.4).

The SDK and resolvers do not encrypt. Plaintext metadata and base64 are not
confidentiality (P8.2).

## Author DID rotation, freshness and forks — phase 2 (implemented)

Rotation is an author DID update. Entries naming the new author DID version
can use the new key without any asset log entry (P5.10). An unwitnessed entry
signed by a key the latest author DID no longer lists is reported as
historically authorized with unproven ordering, never as current, whatever
time it claims (P7.9).

A valid log is a historical result unless the freshness policy holds (P7.6,
P7.8). `freshness: "asserted"` is for a caller that vouches its evidence is
the latest, as an author's own SDK can. Whatever the policy, the store retains
the highest versionId it has verified for each Original and each author DID.
Evidence that falls short of a retained versionId is `stale` and not current.
Evidence that diverges from it is a fork (for the Original) or incomplete
identity evidence (for an author DID). Reads, commits and imports advance the
retained versionIds; `load` only compares against them.

Divergent valid branches are an unresolved fork with no branch current. An
import that diverges from the local log returns `conflict` and the store keeps
the other branch, so every later read reports the fork with both branches
(P6.6). Edits continue on the local branch and stay non-current. Only
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
  `resources` are resourceIDs of the Original's resource set. At most
  `ORIGINALS_LIMITS.editors` (32, PROVISIONAL) grants (P7.7). An empty list is
  not used: no editors means no `editors` member (PROVISIONAL).
- An editor entry carries `editor: { did, verificationMethod, versionId }` in
  its signed state. It is checked against the grant in its parent's state, so
  a grant, a change to it and a revocation take effect from the next entry
  (P5.17). Its author reference is its parent's, its operation is update, its
  parameters are empty, and only the name, metadata and resources the grant
  allows change. Only author entries change grants, aliases, lifecycle or
  parameters, start an Original, anchor it or deactivate it. A change outside
  the grant is refused before anything is signed (`outside-grant`); an editor
  with no grant is `unauthorized-key` (`EDITOR_NOT_GRANTED`).
- Editor keys follow the author key rules against the editor DID (P5.3,
  P5.10–P5.14, P7.8, P7.9): a key the latest editor DID no longer lists makes
  the head not current; versionIds never go backwards per signer identity
  (P5.8). Once the author DID is deactivated no entry, editor's included, is
  current. Editors rotate, remove keys or move only in their own DIDs.
- An editor entry and a revoking author entry with the same parent are a fork,
  unresolved until anchoring (P6.6). Branch length and the number of signers
  decide nothing; an entry bringing content from another branch is an ordinary
  single-parent entry and the fork remains.
- PROVISIONAL: editor authority is an Originals profile rule. No VH-Log hook
  carries it yet (VH-Log PR 11 and plan 011 PR 6 pending). Anchored editor
  entries (P9.15 at inscription time, P9.12 inscription by the owner) arrive
  with Bitcoin anchoring. No signer is required to use did:btco.

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
  (PROVISIONAL): it first asks the location named by the earliest chained
  entry the identity signed (for the author, the genesis entry, which is
  bound to the Original's SCID), and the latest chained entry's location
  only when that gives no usable log. A log found first verifies the
  entries, and the latest verified entry's location is then asked. An
  unverified line can choose a request, never the result. A log retrieved
  from the latest verified entry's location that verifies and extends
  the other evidence is used, and its freshness is `retrieved` (PROVISIONAL:
  retrieval from that location is how this SDK establishes a moved
  identity's freshness). Otherwise the identity's freshness is not
  established and the Original is not reported as current. Editor entries
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
parameter to anything but `{}` is rejected (`WITNESS_NOT_PERMITTED`). On the
local and web layers an Original is author-signed with claimed ordering.
Accepted consequences: a stolen author key can make a branch before its
removal, which is never current once the key is removed (P7.9) but stays an
unresolved fork until anchoring; the first valid anchor wins (P9.16), so
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
r.report.current; // whether it is the latest, under the freshness policy
```

Retrieval is bounded as a whole, not only per file (issue #970). These are
implementation limits (PROVISIONAL), set with the SDK's `retrievalLimits`:

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxRequests` | 1,024 | requests in one call, failed and optional ones included |
| `maxTotalBytes` | `archiveLimits.maxTotalBytes` (512 MiB) | bytes accepted in one call, counted as they arrive, alias log included |
| `maxFileBytes` | `FETCH_LIMITS.maxBytes` (16 MiB) | one response (P7.7) |
| `requestTimeoutMs` | `FETCH_LIMITS.timeoutMs` (15 s) | one request |
| `timeoutMs` | 120 s | the whole call, so slow or absent optional files cannot multiply the per-request timeout |

The snapshot's own files are also held to `archiveLimits`, the bounds `load`
applies to one package: at most `maxEntries` files and `maxTotalBytes` bytes.
The manifest is checked first. The asset log is unverified, so before anything
it asks for is requested, every line must carry a well-formed author reference
and asset state (else `SNAPSHOT_LOG_INVALID`, in the category of the rule it
breaks), and the whole plan (asset witness, each author's log and witness, each
resource) must fit the request and file limits. Each request gets
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

## Bitcoin anchoring and ownership — phase 4

An Original can be anchored from the local or the web layer, once, terminally,
to one sat (P9.10). After that, the inscriptions on the sat decide the log
(P9.13), each checked against the author DID's state at its inscription time
(P9.15). The inscription encoding (D6) will be proposed before any writer code
is written. With no witnesses (Q14), the anchor is the first valid anchoring
entry in chain order, and ownership is reported as provisional (P9.16). Spending requires the owner's explicit
approval, and release evidence comes from real Core/ord regtest.
