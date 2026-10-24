# 012 — Bitcoin representation of an Original (proposal for plan 011, PRs 9–10)

Status: **accepted by the owner on 2026-10-20 (decisions A–D in section 5,
owner decision Q15); decision A replaced the same day by full-log anchoring
(P9.17, spec `a432aa67`).** The verifier now follows originals-spec master
`1039c471c` (with #47 and #48 merged) and open PR #50 (head `555ce24d3`),
whose Bitcoin values the owner has decided; the writer is plan 011 PR 10. It fills
what the pinned spec leaves open for the Bitcoin layer (D6, D7) and states the
choices this SDK would make, each marked PROVISIONAL where the spec is silent.
Pins: originals-spec `1039c471c` (`master`; see `specs/README.md`), VH-Log PRs 2 (`0d5eb134`), 9 (`5552a668`) and
10 (`1867a2b1`) treated as merged, did:vh PR 3 (`b3e7a56d`), did:btco method
v0.2.0 (`decentralized-identity/labs-ordinals-plus` `cff856ac`).

## 1. What the spec fixes

- **Anchoring (P9.10).** The author anchors an Original once, terminally, with a
  "migrate entry" (now: an anchoring entry, an ordinary update; there is no
  migrate operation, §3.1), whose signed state names one sat,
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
did:webvh alias the anchoring entry did not list, replace one (even within its
SCID), or add one again after removing it; the one the anchoring state lists
may stay or go (P9.10, D7). The verifier
recognises an entry as anchoring when it first lists a did:btco alias.

### 3.2 What an inscription carries

- **Content type:** `application/vnd.originals.vh+jsonl` (P9.17, P14.12;
  decided by the owner on 21 October 2026, D6; spec PR #50 (open)).
- **Content:** UTF-8 JSON Lines of complete log entries, exactly as in
  `did.jsonl`. No ord metadata, no did:btco metadata (S11), no delegation, no
  compression. The sat reader does not refuse a delegated or
  `content-encoding` inscription: it reports it observed but unsupported, and
  the verifier ignores an Originals-typed one with the reason
  `unsupported-encoding` (P9.12, P9.14, P9.17); the holder cannot make the
  read fail.
- **The anchoring inscription carries the whole log** (P9.17, replacing
  decision A): genesis through the anchoring entry, which is its last entry.
  Every later inscription carries exactly one new entry that extends the head
  (P9.13). The anchoring sat therefore carries the Original's complete log:
  no copy is needed, and a copy that differs from the sat's entries is
  ignored. An anchoring inscription that does not start at genesis, does not
  verify as one log, or whose last entry is not an anchoring entry naming
  that sat is not an anchor. Any other inscription with more than one entry
  is rejected. The anchoring block shows the earlier entries existed no later
  than that block (P9.16); their ordering stays claimed.
- **Resources** are not inscribed. Each entry commits to its resources by
  digest (P9.4's content commitment is the entry's state); the bytes stay in
  evidence packages and on the web host.
- **Size:** a body is at most 350,000 bytes (P9.17, P14.12; decided, D6; spec
  PR #50 (open)), which keeps
  a full anchoring inscription within Bitcoin's standard transaction size. The
  SDK refuses to anchor a log through the anchoring entry over it (writer, PR
  10); a verifier rejects a larger inscription.
- **Metadata:** an inscription of this media type carrying any metadata is
  rejected (P9.17).

### 3.3 Compact encoding (P9.14, VH-Log PR 10)

Not in the first version (decision B). Entries are inscribed in full. The
encoding hook stays open: a later version can define a delta media type
without changing verification, because hashes and proofs are always over the
decoded entry.

### 3.4 Assembling the log from Bitcoin (VH-Log PR 2, PR 9; P9.13–P9.16)

**Not implemented: a Bitcoin `src` kind.** The did:vh resolver
(`packages/vh/src/didvh`) retrieves from no `src` reference: every `src`,
`did:btco:<sat>` included, gets `featureNotSupported`. Sat evidence reaches the
verifier as `verifyOriginal({ bitcoin: SatEvidence[] })` (SDK: `get`/`load`
with `{ bitcoin }`, from `satEvidence(getSatSnapshot(...))`). Deferred; a
Bitcoin `src` kind (did:vh PR 3) would need: the Originals extension to
register `did:btco:<sat>` as a `src` kind, a sat-reader adapter injected into
the resolver (it holds no network code), one read per index used with the
placement and confirmation rules below, the inscription clock, and a
resolution result that carries the anchoring report and ownership rather
than a bare DID document.

Retrieval reads the sat with the SDK's sat reader (`getSatSnapshot`), which
checks ord against Bitcoin Core and is bounded (PROVISIONAL defaults,
`snapshotBudget`, `packages/sdk/src/adapters/providers/sat-snapshot.ts`):

- `maxListedInscriptions` 100,000 (at most 1,000,000): a sat listing more is
  refused (`SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS`, incomplete evidence).
- `maxInscriptions` 10,000 (at most 100,000) is a read cap, not a refusal: at
  most this many bodies and metadata are read, in listing order, counting
  only those the read fetches; later inscriptions are still listed and
  placed but reported observed and unread (`over-budget`).
- Bytes come from two pools: `maxOriginalsBytes` 64 MiB (at most 1 GiB) for
  Originals bodies of at most 350,000 bytes, and `maxContentBytes` 32 MiB (at
  most 512 MiB) for everything else. Past a pool an item is reported unread,
  not a failed read; an unread Originals inscription then fails the
  Originals read closed (P9.17).
- Time scales with the listing: 30 s plus 250 ms per listed inscription, at
  most `maxTimeoutMs` (10 minutes; at most 1 hour); an explicit `timeoutMs`
  is used as given (up to 1 hour). Each request has `requestTimeoutMs` (15 s;
  at most 10 minutes). Requests: 7 plus 5 per listed inscription unless
  `maxRequests` is set.
- `bodies: 'all' | 'originals'`: `'originals'` fetches only
  `application/vnd.originals.vh+jsonl` bodies of at most 350,000 bytes and
  their metadata, and reports every other inscription `not-requested`;
  `'all'` (the default) reads every body, as a did:btco read needs (P5.13).
  `satEvidence` passes unread non-Originals inscriptions on, flagged, and
  fails only on an unread Originals one.

Assembly:

1. Merge the reads of each sat, one per index used (P9.10, P9.11). An
   inscription is on a did:btco alias's sat only when every index reports it
   on that sat number on that network; the label a read was supplied under
   does not count. Where indexes disagree, that inscription and everything
   after it on the sat are undecided: missing evidence until they agree.
2. Order the sat's inscriptions by chain order (height, transaction index,
   inscription index) and drop those below the confirmation depth (§3.6).
3. The first inscription of our media type, with no metadata and within the
   size limit, that decodes to a log verifying from genesis whose last entry
   is the first anchoring entry, naming this sat and passing P9.15 at its
   inscription time, is the anchor (P9.16, P9.17). Entries before the
   anchoring entry are checked against the versions they name, with claimed
   ordering (P9.15). Every anchoring inscription checks itself, so there is no
   unresolved earlier anchor.
4. Each later inscription of our media type is accepted when it decodes to
   exactly one entry that extends the head, sits at a strictly greater height
   than the last accepted one, passes the profile, and passes P9.15 at its
   inscription time. Everything else is ignored and reported (P9.13).
5. A supplied copy is compared and otherwise ignored (P9.17).
6. If the sat cannot be read in full, resolution fails (VH-Log PR 2: a copy is
   no substitute).
7. A verifier that retained the anchor it reported and now finds an earlier
   valid one reports the change of anchor and owner, never silently (P9.16).

Bitcoin never decides between branches before the anchor except through the
anchor itself, which settles a fork (owner decision Q5).

### 3.5 Network and identifiers

`did:btco:<sat>` on mainnet; `did:btco:sig:`, `did:btco:test:` and
`did:btco:reg:` elsewhere, as the SDK already does (P9.10, P14.12; decided by
the owner on 21 October 2026, D6; spec PR #50 (open)). The did:btco method
spec names no network prefixes yet; they are proposed upstream as
decentralized-identity/labs-ordinals-plus#4 [S30].
The grammar is strict (P9.10): an optional prefix, then the sat number in
decimal with no sign and no leading zeros, below the total supply
(2,099,999,997,690,000). An inscription read from another network, or placed
by the index on another sat number, is not on the alias's sat.

### 3.6 Confirmation policy and reorganisations (P9.5, P9.11)

- An inscription counts once it has **1 confirmation**, on every network,
  mainnet included (decision D; P9.5, owner decision of 21 October 2026, spec
  PR #50 (open)); there is no per-network policy. An
  unconfirmed one is reported as observed, never as part of the accepted log.
  Every accepted inscription is reported with its confirmation depth, so the
  reader judges the risk.
- Every report states the tip height and hash it relied on, the confirmation
  depth of the head and of the sat's current output, and which indexes it
  used (P9.11); indexes that disagree on placement or on the holder give no
  accepted placement or owner.
- A reorganisation that removes an accepted inscription is reported as
  `authoritative-source-changed` (VH-Log PR 2), never silently.

### 3.7 Inscription time (P9.15)

Inscription time is the running maximum of block timestamps from genesis to
the inscription's block. `satEvidence` takes it from an `InscriptionClock`
(`packages/sdk/src/originals/bitcoin.ts`), not from the times the sat reader
records: the clock reads headers (in batches where the source allows),
follows reorganisations by block hash and refuses a block no longer on the
chain (`BLOCK_NOT_ON_CHAIN`), has a per-call request budget, and can persist
its state through a `ClockStore` to restart cheaply (#971, #973). A time the
clock cannot establish fails the whole read (`BLOCK_TIME_UNAVAILABLE`,
unavailable-bytes; a spent budget or abort, incomplete-evidence): no report
is produced from it.

Against that time, a did:vh or did:webvh signer is checked at the later of
the version the entry names and the newest version the verifier knows of whose
versionTime is no later than the inscription time (originals-spec #47, P7.8, P9.15). The verifier need not show that no newer
version exists, and the report states the version relied on and when it was
obtained (`validAsOf.signers`). An entry naming a version the verifier has
no verified copy of is incomplete identity evidence (P5.6).

### 3.8 did:btco author DIDs (P5.13)

Read from Bitcoin with the sat reader, following the did:btco method v0.2.0:
the newest inscription carrying CBOR DID-document metadata whose `id` is the
DID is the current version; earlier ones are versions in chain order;
deactivation is terminal. The SDK's existing resolver reads the document from
inscription content and a 🔥 marker instead (decision C). An anchoring entry
naming the author DID's own sat is rejected (P5.13).

### 3.9 Ownership report (P9.11)

The owner is the holder of the anchoring sat at the reported tip:
`{ status: "provisional", sat, output, address?, confirmations, indexes: [ids] }`.
Ownership is never established, only provisional (P9.11, P9.16), and never
authority (P9.12). An Original that is not anchored has no
owner. A copy of the same evidence on another sat confers none (C12-33).

## 4. Delivery

- **PR 9a — verifier on fixtures.** Anchoring entry and alias rules;
  assembly over sat snapshots supplied as evidence (no Bitcoin `src`, §3.4); chain order; inscription time;
  P9.15 checks for did:vh and did:webvh author DIDs; anchors and conflicting
  anchors; ownership report; reorg reporting. Section 12 rows 8 (anchored),
  27–47 and 62, on recorded fixtures.
- **PR 9b — did:btco author DIDs.** Rows 58–61. A did:btco author or editor
  is how Bitcoin alone suffices for identity (P9.18); anchoring does not
  require one (owner decision of 21 October 2026, originals-spec #47).
- **PR 10 — writer.** Anchor and reinscribe through the existing sat
  inscription builder and recovery store; the landing server's refusal of
  inscribed inputs becomes reinscription of the Original's own sat; durable
  boundary and retries (P9.4–P9.6). **Real Bitcoin Core 31.1 / ord 0.29.0
  regtest** journey including reorg and retry faults. No mainnet or testnet
  spending.

## 5. Owner decisions (2026-10-20, Q15)

- **A. Anchoring inscription content: the anchoring entry only.**
  *Replaced on 2026-10-20 by owner decision (spec `a432aa67`, P9.17):* the
  anchoring inscription carries the whole log from genesis through the
  anchoring entry, and each later inscription one entry. Copies of the log
  are not needed; one that differs from the sat's entries is ignored.
- **B. Compact deltas: not now.** Full entries only; the P9.14 hook stays open.
- **C. did:btco author DID documents: the method spec v0.2.0.** CBOR
  DID-document metadata on the inscription. The SDK's content-based resolver
  is replaced.
- **D. Confirmations: accept at 1, report the depth.** Ownership is reported
  with its depth too, always provisional (P9.16). *Confirmed on 2026-10-21 by
  owner decision (spec PR #50 (open), P9.5, D6):* one confirmation on every
  network, mainnet included; with it the media type, the 350,000-byte limit
  and the did:btco network prefixes are decided, not provisional.
