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
- Keys rotate in the author DID only. The asset log has no update keys.
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
- **Retries (P6.4).** Committing an accepted, identical draft returns its
  existing checkpoint with status `duplicate`. Any other retry needs a new
  preparation step.
- **Versions (P4.4).** Resource versions are derived from history. A caller's
  counter is rejected, and an unchanged digest does not advance a version.
- **Signing (P5.11).** The signer receives the unsigned entry, the proof options
  and a summary of the Original, the operation and the resource changes.
  `keySigner` refuses anything that is not an Originals entry for its own key,
  and it computes the signed bytes itself rather than taking the caller's.

## Verification report — phase 1, extended in later phases

`load`, `verify` and `resolve` return a report that keeps its parts separate:

| Part | Values |
|---|---|
| `history` | valid · invalid (with the first failing entry) · limit-exceeded |
| `authorBinding` | valid · failed (per entry) |
| `identityEvidence` | complete · incomplete, with the latest author DID versionId used and its freshness: asserted · not-established · stale against the retained versionId (P7.8) |
| `assetFreshness` | asserted · not-established · stale against the retained versionId, with every compared copy of the asset log (P7.6) |
| `resources` | available · partial (resource and checkpoint missing) · digest failure |
| `ordering` | claimed · anchored (P7.6). Asset logs have no witnesses (Q14), so an unanchored Original's ordering is claimed only |
| `fork` | the version at which known branches diverge and each branch's entry there. A fork not on Bitcoin is an unresolved conflict with no current branch (owner decision Q5); only an anchor settles one (P9.16) |
| `anchors` | every anchoring entry (phase 4) |
| `ownership` | none · provisional · established, with confirmation depth and index agreement (P9.11) |
| `current` | true only when every part above passes under the selected policy |
| `reasons`, `retain` | why the result is not current; the highest versionIds to keep for the Original and each author DID, never lower than those supplied |

Errors are `OriginalsError` (a `StructuredError`) in one of these categories:
`invalid-evidence`, `incomplete-evidence`, `unsupported-profile`,
`unauthorized-key`, `author-binding`, `stale-parent`, `fork`, `deactivated`,
`unavailable-bytes` or `limit-exceeded`.

## Evidence package — phase 1, implemented (PROVISIONAL format, D4)

The package is an uncompressed ZIP containing `originals-evidence.json` (the
manifest), `asset/did.jsonl` through the checkpoint, `asset/did-witness.json`,
the author DID histories under `authors/<sha256(did)>/`, and the resource bytes
under `resources/<digest>`. The manifest records the packager's head, so a
package of an earlier checkpoint is never reported as the latest state (P7.6).
The manifest names the Original, the profile and the target checkpoint, and
declares the package complete or partial, listing any missing items.

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
const r = await reader.loadPublished(aliasDid, async (url) => (await safeFetch(url)).bytes);
r.verified; // the exact snapshot: history ending at its checkpoint, binding, identity, every byte, the alias
r.report.current; // whether it is the latest, under the freshness policy
```

`@originals/vh/fetch` retrieves HTTPS only, with no credentials, no redirects,
no private or special-use address before or after DNS (connecting to the
vetted address), and caps on size and time; every refusal is
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
