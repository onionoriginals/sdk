# Originals SDK: the Originals Protocol contract

**Status: target contract, partly implemented.** Phase 1 (local use) is in
`@originals/sdk/originals`. This document describes what
`@originals/sdk` provides once the phases of
[plan 011](../../plans/011-originals-vh-replacement.md) land. Each section
names the phase that delivers it. API names are provisional until that phase's
PR merges. Choices the spec leaves open are marked PROVISIONAL. The governing
documents are listed in [`specs/README.md`](../../specs/README.md), and rule
IDs (P5.3) refer to the Originals Protocol.

This contract replaces the CEL 3 guide in [`V3.md`](V3.md). Nothing written
under CEL 3 is read, converted or migrated.

## Model

- An Original is `did:vh:<SCID>`. Its asset log is a did:vh log under the
  `originals:1.0` extension (PROVISIONAL method value). Each entry holds the
  full asset state: name, metadata, lifecycle status, resource descriptors and
  aliases.
- The author is a DID fixed at genesis. The baseline profile lists did:vh,
  did:webvh and did:btco. Every entry carries exactly one proof, by an
  `assertionMethod` key of the author DID at the author DID version the entry
  names. That key must not also be an update key of the author DID's own log.
  A hosted author declares its witnesses in a DID service (plan 011, S8). Accepted
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
| `identityEvidence` | complete · incomplete, with the latest author DID versionId used and whether its freshness was established (P7.8) |
| `resources` | available · partial (resource and checkpoint missing) · digest failure |
| `ordering` | claimed · witnessed · anchored (P7.6) |
| `forks`, `anchors` | every known branch and anchoring entry. A fork not on Bitcoin is an unresolved conflict with no current branch (plan 011, S1); only an anchor settles one (P9.16) |
| `ownership` | none · provisional · established, with confirmation depth and index agreement (P9.11) |
| `current` | true only when every part above passes under the selected policy |

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

## Author DID rotation and forks — phase 2

Rotation is an author DID update. Entries naming the new author DID version
can use the new key without any asset log entry. An unwitnessed entry signed
by a key the latest author DID no longer lists is reported as historically
authorized with unproven ordering, never as current (P7.9). Divergent valid
branches are reported as an unresolved fork, with no branch current. Only
anchoring on Bitcoin settles a fork (plan 011, S1).

## Hosted publication and witnesses — phase 3

Publishing to the web requires an explicit domain. The publish entry activates
the witnesses declared in the author DID (at least three, P9.8) and adds a
did:webvh alias. The alias is its own small log, bound in both directions with
the did:vh (P3.6). The public reader verifies one exact snapshot (P9.1).
Fetches apply the VH-Log retrieval rules (P8.5), and active content is served
isolated (P9.7). The witness parameter follows the reworded P9.9 (plan 011, S2).

## Bitcoin anchoring and ownership — phase 4

An Original can be anchored from the local or the web layer, once, terminally,
to one sat (P9.10). After that, the inscriptions on the sat decide the log
(P9.13), each checked against the author DID's state at its inscription time
(P9.15). The inscription encoding (D6) will be proposed before any writer code
is written. Ownership is reported as provisional unless more than half of the
witnesses approved the anchor (P9.16). Spending requires the owner's explicit
approval, and release evidence comes from real Core/ord regtest.
