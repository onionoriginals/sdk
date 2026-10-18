# Originals

An Original is a digital asset with a verifiable, signed history of named
resources. Its author and its owner are separate roles, and neither role
implies the other. Terms follow the pinned
[Originals Protocol](specs/README.md); rule IDs refer to it.

## Language

**Original**:
A logical asset with a stable `did:vh:<SCID>` identifier, a verifiable state history and a fixed set of named resources.
_Avoid_: DID document, inscription, envelope (as synonyms for the asset)

**Asset log**:
The Original's did:vh log under the Originals extension (`originals:1.0`). It is the Original's only history.

**Asset state**:
The full state in every asset log entry: name, metadata, lifecycle status, resource descriptors and aliases. It is never a delta and never a DID document.
_Avoid_: DID document (the DID document is derived from the log, never stored, P3.8)

**Resource**:
A named file belonging to an Original, identified by a resourceID fixed at genesis (P4.1).

**Resource version**:
An exact byte sequence bound to a mediaType and a SHA-256 digest in verified history. Version numbers are derived from history and advance only when the digest changes (P4.4).

**Author**:
The DID that signs every change for the Original's whole life. It is fixed at genesis, and authorship never transfers (P5.8).
_Avoid_: controller key, owner (when discussing who may sign)

**Originals declaration**:
The part of the author DID document that lists the keys allowed to sign the author's Originals and the author's witness list and threshold (P9.9).

**Originals key**:
A verification method of the author DID, listed in its Originals declaration and used only for Originals entries. It is never an update key of the author DID's own log (P5.11).

**Key rotation**:
A change to the author DID that adds or removes an Originals key. Nothing is appended to the asset log (P5.10).

**Witness**:
A VH witness that approves asset log entries after checking the author DID's latest state. Hosted Originals require at least three (P9.8).

**Owner**:
The current holder of an anchored Original's anchoring sat. Ownership confers no authority to change the Original. An Original that is not anchored has no owner (P9.11).
_Avoid_: controller, author

**Anchoring**:
The single, terminal migrate entry that binds an Original to one sat. From then on, a change counts only if the author signs it and it is inscribed on that sat (P9.10, P9.12).

**Alias**:
A did:webvh (web publication) or did:btco (anchoring) identifier listed in the asset state. A did:webvh alias must also point back to the did:vh (P3.6).

**Checkpoint**:
An exact verified prefix of the asset log, identified by its last `versionId`.
_Avoid_: head, when the history has not been verified

**Draft**:
A local, unsigned candidate change. It is never a resource version and is never packaged or published as history (P6.3).

**Evidence package**:
A ZIP holding an asset log prefix, the author identity evidence and the resource bytes. It declares itself complete or partial, and verifies offline without a private key (section 7).

**Fork**:
Two or more valid branches from the same accepted entry. A fork is always reported, and no branch is chosen by timestamp (P6.6).
