# Originals SDK: the Originals Protocol contract

**Status: target contract, not yet implemented.** This document describes what
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
  did:webvh and did:btco. Every entry carries exactly one proof, by an Originals
  key of the author DID at the author DID version the entry names. Accepted
  cryptosuites are `eddsa-jcs-2022` and `bip340-jcs-2025`.
- Keys rotate in the author DID only. The asset log has no update keys.
- The DID document of the did:vh is derived from the log. It is never stored or
  taken from a host.

## Local use — phase 1

```ts
const sdk = OriginalsSDK.create({ store, authorDids });

const created = await sdk.create({ name, metadata, resources, signer });
// created.kind === "original" | "draft"; a draft is unsigned and is never history (P6.3)

const edited = await sdk.edit(original, {
  parent: original.checkpoint,   // required; a moved parent is a StaleParent conflict (P4.5)
  name,                          // omitted keeps the value; null is rejected (P4.6)
  metadata,                      // omitted keeps the value; null removes it (P4.6)
  resources,                     // same resourceIDs as genesis (P4.1)
  signer,
});

await sdk.deactivate(original, { parent, signer }); // terminal (P6.5)

const pkg = await sdk.package(original);  // evidence package, complete or partial (P7.1)
const view = await sdk.load(pkg);         // read-only; needs no key and no network (P7.3)
```

- **Durable commit (P6.2).** The current checkpoint advances only after the
  signed entry and the new bytes are durably stored. An interrupted commit
  recovers to either the prior checkpoint or the fully committed one. A signer
  rejection leaves the prior checkpoint unchanged (P6.1).
- **Retries (P6.4).** Retrying an accepted, identical candidate returns its
  existing checkpoint. Any other retry needs a new preparation step.
- **Versions (P4.4).** Resource versions are derived from history. A caller's
  counter is ignored, and an unchanged digest does not advance a version.
- **Signing (P5.11).** The SDK hands the signer the parsed entry together with
  a summary of the Original, the operation and the resource changes.

## Verification report — phase 1, extended in later phases

`load`, `verify` and `resolve` return a report that keeps its parts separate:

| Part | Values |
|---|---|
| `history` | valid · invalid (with the first failing entry) · limit-exceeded |
| `authorBinding` | valid · failed (per entry) |
| `identityEvidence` | complete · incomplete, with the latest author DID versionId used and whether its freshness was established (P7.8) |
| `resources` | available · partial (resource and checkpoint missing) · digest failure |
| `ordering` | claimed · witnessed · anchored (P7.6) |
| `forks`, `anchors` | every known branch and anchoring entry (P6.6, P9.16) |
| `ownership` | none · provisional · established, with confirmation depth and index agreement (P9.11) |
| `current` | true only when every part above passes under the selected policy |

Errors are `OriginalsError` (a `StructuredError`) in one of these categories:
`invalid-evidence`, `incomplete-evidence`, `unsupported-profile`,
`unauthorized-key`, `author-binding`, `stale-parent`, `fork`, `deactivated`,
`unavailable-bytes` or `limit-exceeded`.

## Evidence package — phase 1 (PROVISIONAL format, D4)

The package is an uncompressed ZIP containing `originals-evidence.json` (the
manifest), `asset/did.jsonl`, `asset/did-witness.json`, the author DID
histories under `authors/`, and the resource bytes under `resources/<digest>`.
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
branches are reported as a fork. How the author resolves a fork (P6.6) waits
on spec finding S1.

## Hosted publication and witnesses — phase 3

Publishing to the web requires an explicit domain. The publish entry activates
the witnesses declared in the author DID (at least three, P9.8) and adds a
did:webvh alias. The alias is its own small log, bound in both directions with
the did:vh (P3.6). The public reader verifies one exact snapshot (P9.1).
Fetches apply the VH-Log retrieval rules (P8.5), and active content is served
isolated (P9.7). Rules for the witness parameter wait on spec finding S2.

## Bitcoin anchoring and ownership — phase 4

An Original can be anchored from the local or the web layer, once, terminally,
to one sat (P9.10). After that, the inscriptions on the sat decide the log
(P9.13), each checked against the author DID's state at its inscription time
(P9.15). The inscription encoding (D6) will be proposed before any writer code
is written. Ownership is reported as provisional unless more than half of the
witnesses approved the anchor (P9.16). Spending requires the owner's explicit
approval, and release evidence comes from real Core/ord regtest.
