# 012 — Bitcoin representation of an Original (proposal for plan 011, PRs 9–10)

Status: **accepted by the owner on 2026-10-20 (decisions A–D in section 5,
owner decision Q15).** Nothing here is implemented yet. It fills
what the pinned spec leaves open for the Bitcoin layer (D6, D7) and states the
choices this SDK would make, each marked PROVISIONAL where the spec is silent.
Pins: originals-spec `b8e8323`, VH-Log PRs 2 (`0d5eb134`), 9 (`5552a668`) and
10 (`1867a2b1`) treated as merged, did:vh PR 3 (`b3e7a56d`), did:btco method
v0.2.0 (`decentralized-identity/labs-ordinals-plus` `cff856ac`).

## 1. What the spec fixes

- **Anchoring (P9.10).** The author anchors an Original once, terminally, with a
  "migrate entry", an ordinary entry whose signed state names one sat,
  inscribed on that sat. Later entries naming another sat, removing it or
  migrating elsewhere are rejected. An Original anchored from the local layer
  never gains a web alias.
- **State after anchoring (P9.12, P9.13).** Only author-signed entries
  inscribed on the anchoring sat and extending the accepted head count. A
  resolver follows publications in inscription order, each at a strictly
  greater block height, the earliest winning among those extending the same
  head. Bitcoin is the log's authoritative source (VH-Log PR 2).
- **Author checks at inscription time (P9.15, P5.13).** Each anchored entry is
  checked against the author DID's state at its inscription time: the greatest
  block timestamp among its block and that block's ancestors. For a did:btco
  author DID, versions are ordered by chain order instead.
- **The anchor (P9.16).** The first valid anchoring entry in chain order on the
  sat it names. Others are conflicting anchors, never current, conferring no
  ownership. Uniqueness is never established; ownership is provisional.
- **Ownership (P9.11).** The current holder of the anchoring sat, under the
  adapter's confirmation policy, reported with the confirmation depth and how
  many independent indexes agreed.
- **Encoding (P9.14).** An inscription MAY carry a compact encoding such as a
  delta; it must decode deterministically, and hashes and proofs are computed
  over the decoded full entry.
- **Boundary (P9.4–P9.6).** A publication identifies its exact checkpoint and
  content commitment; a pending or failed transaction never advances the
  durable boundary; retries distinguish rebroadcast from replacement.

## 2. Gaps and contradictions in the spec (to report, rule IDs)

- **S10 — the migrate entry is undefined (P9.10).** P9.10 calls it "an ordinary
  entry under P5.10", but P5.10 is key rotation, and section 6 defines no
  migrate operation or sat field. *Proposed fix:* "an ordinary update entry
  (section 6) whose asset state adds the anchoring sat's did:btco alias".
- **S11 — the anchoring sat serves two readers (section 3, P3.8).** The
  Original's did:btco alias names the anchoring sat, but the did:btco method
  resolves a sat's newest inscription carrying CBOR DID-document metadata,
  while P3.8 forbids using a served DID document for the did:vh. *Proposed
  fix:* Originals inscriptions carry no did:btco metadata; the alias resolves
  only through the Originals extension (P3.5); a generic did:btco resolver
  finds no DID document on the sat.
- **S12 — two orders.** P9.13 says "inscription order on the sat"; P5.13 and
  P9.16 say block height, transaction index, inscription index. They agree in
  practice (P9.13's strictly-greater-height rule settles same-block cases), so
  *proposed fix:* define "chain order" once and use it in both.

## 3. Proposed representation (PROVISIONAL unless a decision below fixes it)

### 3.1 The anchoring entry

An ordinary `update` entry whose asset state adds `did:btco:<sat>` (with the
network prefix, §3.5) to `aliases`. The reserved `migrate` operation is
dropped. From then on every entry must keep that alias, and none may add a
did:webvh alias the anchoring entry did not list (P9.10). The verifier
recognises an entry as anchoring when it first lists a did:btco alias.

### 3.2 What an inscription carries

- **Content type:** `application/vnd.originals.vh+jsonl` (D6 leaves the MIME
  type open; this one is new and unambiguous).
- **Content:** UTF-8 JSON Lines of complete log entries, exactly as in
  `did.jsonl`. No ord metadata, no did:btco metadata (S11), no delegation, no
  compression (`content-encoding` refused, as the sat reader already does).
- **Every inscription carries exactly one entry** (decision A): the anchoring
  inscription carries the anchoring entry, and each later inscription one new
  entry that extends the head (P9.13). The history before the anchor comes
  from a copy of the log (an evidence package or the web host) and must chain
  to the anchoring entry by versionId; the anchoring block shows it existed no
  later than that block (P9.16) but Bitcoin does not carry it. Batching several
  entries in one inscription is not allowed: P9.13's height rule already
  forces one accepted publication per block.
- **Resources** are not inscribed. Each entry commits to its resources by
  digest (P9.4's content commitment is the entry's state); the bytes stay in
  evidence packages and on the web host.
- **Size:** one entry, so the profile's entry limit (64 KiB, P7.7) bounds every
  inscription, well below the standard transaction weight limit.

### 3.3 Compact encoding (P9.14, VH-Log PR 10)

Not in the first version (decision B). Entries are inscribed in full. The
encoding hook stays open: a later version can define a delta media type
without changing verification, because hashes and proofs are always over the
decoded entry.

### 3.4 Assembling the log from Bitcoin (VH-Log PR 2, PR 9; P9.13–P9.16)

The Originals extension defines a Bitcoin `src` kind (did:vh PR 3): the sat's
did:btco alias itself, so `src` is `did:btco:<sat>`. Retrieval reads every
inscription on the sat with the existing sat reader, which already bounds
counts (10,000), bytes (32 MiB) and time, and checks ord against Bitcoin Core.

Assembly:

1. Order the sat's inscriptions by chain order (height, transaction index,
   inscription index) and drop those below the confirmation depth (§3.6).
2. The prefix before the anchor comes from a copy of the log. The first
   inscription of our media type that decodes to a valid anchoring entry naming
   this sat and extending that prefix is the anchor (P9.16). Earlier or
   malformed inscriptions are reported, not used. Without a prefix that the
   anchoring entry extends, the result is incomplete evidence, not success.
3. Each later inscription of our media type is accepted when it decodes to one
   entry that extends the head, sits at a strictly greater height than the last
   accepted one, passes the profile, and passes P9.15 at its inscription time.
   Everything else is ignored and reported (P9.13).
4. A copy's entries after the anchor are compared against the assembled log:
   entries Bitcoin includes win, and a copy that diverges after the anchor is
   superseded (VH-Log PR 2). Entries before the anchor are governed by Bitcoin
   through the anchoring entry's hash chain: a prefix the anchoring entry does
   not extend is not this Original's history.
5. If the sat cannot be read in full, resolution fails (VH-Log PR 2: a copy is
   no substitute).

Bitcoin never decides between branches before the anchor except through the
anchor itself, which settles a fork (owner decision Q5).

### 3.5 Network and identifiers

`did:btco:<sat>` on mainnet; `did:btco:sig:`, `did:btco:test:` and
`did:btco:reg:` elsewhere, as the SDK already does. The did:btco method spec
names no network prefixes, so this stays PROVISIONAL and is reported upstream.
A verifier refuses an alias whose network differs from its adapter's.

### 3.6 Confirmation policy and reorganisations (P9.5, P9.11)

- An inscription counts once it has **1 confirmation** (decision D); an
  unconfirmed one is reported as observed, never as part of the accepted log.
  Every accepted inscription is reported with its confirmation depth, so the
  reader judges the risk.
- Every report states the tip height and hash it relied on, the confirmation
  depth of the head and of the sat's current output, and how many independent
  indexes agreed (1 in this version: ord checked against Bitcoin Core).
- A reorganisation that removes an accepted inscription is reported as
  `authoritative-source-changed` (VH-Log PR 2), never silently.

### 3.7 Inscription time (P9.15)

Inscription time is the running maximum of block timestamps from genesis to
the inscription's block. The sat reader already calls `getblock`; it will
record each block's `time`, and the adapter computes the running maximum from
block headers, caching it per height (a one-time header walk, then
incremental). A verifier that cannot establish it reports incomplete identity
evidence.

### 3.8 did:btco author DIDs (P5.13)

Read from Bitcoin with the sat reader, following the did:btco method v0.2.0:
the newest inscription carrying CBOR DID-document metadata whose `id` is the
DID is the current version; earlier ones are versions in chain order;
deactivation is terminal. The SDK's existing resolver reads the document from
inscription content and a 🔥 marker instead (decision C). An anchoring entry
naming the author DID's own sat is rejected (P5.13).

### 3.9 Ownership report (P9.11)

The owner is the holder of the anchoring sat at the reported tip:
`{ status: "provisional", output, address?, confirmations, indexes: 1 }`.
Ownership is never authority (P9.12). An Original that is not anchored has no
owner. A copy of the same evidence on another sat confers none (C12-33).

## 4. Delivery

- **PR 9a — verifier on fixtures.** Anchoring entry and alias rules; Bitcoin
  `src` and assembly over a sat snapshot; chain order; inscription time;
  P9.15 checks for did:vh and did:webvh author DIDs; anchors and conflicting
  anchors; ownership report; reorg reporting. Section 12 rows 8 (anchored),
  27–47 and 62, on recorded fixtures.
- **PR 9b — did:btco author DIDs.** Rows 58–61.
- **PR 10 — writer.** Anchor and reinscribe through the existing sat
  inscription builder and recovery store; the landing server's refusal of
  inscribed inputs becomes reinscription of the Original's own sat; durable
  boundary and retries (P9.4–P9.6). **Real Bitcoin Core 31.1 / ord 0.29.0
  regtest** journey including reorg and retry faults. No mainnet or testnet
  spending.

## 5. Owner decisions (2026-10-20, Q15)

- **A. Anchoring inscription content: the anchoring entry only.** Earlier
  history comes from evidence packages or the web host and must chain to it.
  (The alternative, the whole log in the anchoring inscription, was declined.)
- **B. Compact deltas: not now.** Full entries only; the P9.14 hook stays open.
- **C. did:btco author DID documents: the method spec v0.2.0.** CBOR
  DID-document metadata on the inscription. The SDK's content-based resolver
  is replaced.
- **D. Confirmations: accept at 1, report the depth.** Ownership is reported
  with its depth too, always provisional (P9.16).
