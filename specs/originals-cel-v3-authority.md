# Originals CEL 3 authority and publication ordering

Status: normative contract, implemented in the SDK 3.0.0 candidate. On 2026-09-05 the owner answered **yes**
to retiring key A's authority after rotation to B. This resolves
[Define controller authority and inscription ordering in the new CEL fold](https://github.com/onionoriginals/sdk/issues/560)
together with the precise consequences below. The [wire/proof contract](originals-cel-v3-profile.md)
defines the signed values and proof algorithms. This document defines when those
values change the accepted asset state.

The earlier inscription record's term "creator-lineage key" means the **current
controller established by the accepted lineage**, not every key ever in it.
The no-holder-writes, raw-byte content, derived Bitcoin evidence, clean cut and
delta-publication decisions remain in force.

## Authority is evaluated at each entry

Creation establishes controller A. Every later operation must be signed by the
controller immediately before that entry. All supplied proofs must verify and
identify that same controller. A key's presence in historical entries, a cached
DID document, the current Bitcoin holder's wallet, or an unaccepted proposal
does not confer authority.

A rotation A → B is signed by A. The rotation itself does not require a B proof,
and a B-only proof cannot authorize it. After acceptance, B becomes current and
A is retired. Old A signatures remain valid evidence for entries authorized
while A was current; new A entries after the rotation are rejected. A cannot
restore itself by holding or reacquiring the sat. A later accepted rotation
signed by the then-current controller may explicitly authorize A again; history
alone never reauthorizes it. A rotation to the already current key is invalid.

This is a key policy, not an identification of people or organizations. Neither
Bitcoin nor CEL can prove that the same person controls two unrelated keys.

## Deterministic asset state and operation effects

The fold consumes validated entries in accepted order and has no network I/O.
It derives:

- genesis `did:cel`, current asset alias/layer, and the ordered migration aliases;
- current controller and historical controller intervals (history is not authority);
- name, metadata, creation time, ordered resource ids with their current
  descriptors and accepted version counts;
- active/deactivated state and the accepted event head;
- a separate publication-evidence result when chain observations are supplied.

Live Bitcoin ownership is separate from this state. It is not reconstructed
from controller history and is never written into a CEL operation. Proof-created
times do not decide event order or manufacture a unique `updatedAt` value:
proofs are outside event identity and may differ without changing the event.

Apply an operation to a temporary copy only after its schema, signature,
controller and previousEvent checks pass:

| Operation | State checks and effect |
| --- | --- |
| create | First entry only. Derive did:cel, initialize the controller, descriptors, version 1 for each resource, and active state. Never trust a declared asset DID. |
| update | Asset must be active. Replace supplied name/metadata in full. For every resource update, its id must already exist and previousDigestMultibase must equal that id's current digest. Replace that descriptor, retaining its original position, and increment its accepted version count. Reject the whole operation if any member fails. |
| rotateKey | Asset must be active. Current controller signs a different valid newController. Change the current controller after this entry; retain historical intervals for verification only. |
| deactivate | Asset must be active. Mark it deactivated. No later authorship operation is accepted, including reactivation, rotation or migration. Bitcoin possession and historical evidence remain meaningful; this does not burn the sat, delete bytes or prevent a sat transfer. |
| migrate | Asset must be active. `from` must equal the current alias. Permit cel → webvh, then webvh → btco, exactly once each. `layer` and the canonical destination DID must agree. Retain the prior aliases. Btco is terminal for migration. |

Use shared canonical DID parsing rather than a prefix check. A signed WebVH
alias is a locator/creator claim, not by itself proof that an HTTPS host serves
it or that its WebVH identifier is valid. SDK publication/resolution must check
that separate method binding. The deterministic fold must not resolve an alias
over the network to choose its controller. A btco migration commits the network
and exact decimal sat in `to`; it must match the queried publication sat and
configured chain before Bitcoin anchoring can be accepted.

Before the btco boundary, entries need current-controller proofs and the
authorized hash chain. After the boundary, **update, rotateKey and deactivate
also require an accepted publication on the anchoring sat**. A valid signed but
unpublished entry is a proposal, not the accepted btco head. Offline verification
can authenticate its signature and chain but cannot claim on-chain acceptance.

## What the signature-plus-sat rule proves

An accepted post-anchor publication demonstrates both authorization by the
current controller and inclusion on the correct sat. Holding the sat alone does
not allow holder-authored changes. Holding only the controller key does not
publish a change on someone else's sat.

The existing rule also permits cooperation: a holder can publish bytes already
signed by the current controller. Signatures have no automatic sale-time expiry,
and the format does not prove who possessed the sat when a signature was made.
"Freezes at sale" therefore means a holder cannot independently author changes;
it is not an absolute prohibition on publishing a creator-authorized proposal.
No holder statement, `data.author`, identity check or holder-key substitution is
introduced to disguise this distinction.

## Required publication observations

Before interpreting a sat's history, the resolver needs complete observations
for a stable, identified chain/index snapshot:

- configured Bitcoin network, best block height/hash and a healthy ord index
  synchronized to that block;
- complete enumeration of inscription ids on the queried sat, including every
  page; explicit completion, not a silently capped array;
- each inscription's reveal transaction, confirmed creation block hash/height,
  transaction position within that block, and numeric inscription suffix index;
- complete content bytes and metadata bytes or an explicit statement that
  metadata is absent; parsed metadata alone must preserve all profile values;
- the sat associated with that inscription, and separate current satpoint/output
  and ownership observations at the same snapshot.

Block transaction position comes from the confirmed block's transaction list;
validate membership of the reveal txid. Inscription `txidiN` uses the numeric
envelope index N across the reveal transaction's inputs, **not output vout**.
Do not substitute the sat's mining-birth height, its current-location transaction,
an inscription number, sequence number, local arrival time, proof timestamp or
provider array order for creation position. The
[primary-source/provider analysis](../docs/research/2026-09-05-cel-ordering-primary-sources.md)
pins Bitcoin Core 31.1 and ord 0.29.0 and records the adapter gaps.

Index/provider assertions remain part of the trust model. A sat-scoped index
does not prove no copy or competing creation exists on another sat. Report
`scope: sat` and cross-sat canonicality as unknown; never claim global uniqueness
from the current production adapters. Missing capabilities must produce an
unavailable/incomplete result, not fabricated ordering or an empty enumeration.

## One total order, then whole-publication acceptance

Sort confirmed publications by the numeric tuple:

```text
(creationBlockHeight, transactionIndexInBlock, inscriptionIndexInTransaction)
```

Within a document, its log array order defines entry order. Different ids cannot
occupy one identical position. Identical repeated records can be deduplicated;
conflicting observations for one id/position mean inconsistent evidence.
Unconfirmed publications are pending and do not participate in the accepted
history. Canonical block membership must agree with the chosen snapshot.

For initial did:btco resolution, choose the earliest valid **boundary publication**
on that sat: a complete authorized history from create through webvh migration,
ending exactly with its btco migration to this sat/network. Boundary content and
metadata follow the inscription decision. A bare create, an orphan delta or an
initial snapshot ending with unwitnessed post-anchor entries is not a boundary.
Select this boundary independently of any requested did:cel filter. After
selection, a requested did:cel identity must match its derived genesis or the
resolution fails with an identity mismatch. A later boundary matching the
request must not cause the same sat to resolve to a different Original. If no
boundary exists, the result is not-found; if an earlier candidate cannot be
inspected, the result is incomplete rather than selecting a later match.

After a boundary, inspect each subsequent publication once in this order:

1. Its first event must extend the current accepted head. A snapshot, duplicate
   of an accepted publication, or branch from an old head does not replace it.
2. Its **block height must be strictly greater than the previously accepted
   publication's block height**. Apply this height gate once to the publication,
   before evaluating its entries.
3. Every entry must chain internally, obey the operation schema and state rules,
   and carry the controller proof valid at that point in the temporary fold.
   A rotation in the document changes the required key for its following entries.
4. Commit all entries and the new publication head together only if every check
   succeeds. A bad second entry cannot leave a first rotation/update committed.

Multiple internally chained entries in one publication can therefore share a
block height. Two separate publications cannot evade the strict-height gate by
being in the same block, even if the later one extends the earlier one's head.
Two same-block forks from an older head are ordered by their transaction and
inscription positions; the earliest valid whole publication wins. A later
non-extending branch is ignored. A malformed earlier candidate does not win.

The same full-document verification is used at the boundary: malformed or
unauthorized suffixes cannot turn a valid prefix into an accepted boundary.
All-or-nothing here describes reader acceptance of one publication, not an
atomic guarantee across HTTPS writes, Bitcoin transactions or SDK side effects.

## Missing information versus ignorable publications

| Observation | Result |
| --- | --- |
| Complete bytes establish unrelated media, malformed profile data, disallowed shape/type/version, invalid signature/controller or a non-extending branch | Ignore that candidate, with a diagnostic reason. It does not poison an otherwise valid history. |
| A valid allowed profile/suite cannot be checked because the implementation lacks its required capability | Unsupported verification capability. Do not call it invalid or ignore a possibly valid continuation. |
| A valid internally linked delta arrives without its required prior accepted history | History required. Do not infer a genesis, controller or complete asset from it. During a complete sat walk an orphan/non-extending candidate can be ignored; without a valid boundary no asset is resolved. |
| Enumeration is incomplete, a page/inscription is unavailable, content/metadata completeness is unknown, or creation order is unavailable | Incomplete evidence. A verified prefix may be reported as such, but current head/freshness is unverified. Do not return a normal fully verified DID resolution or allow a writer to use the prefix as the sat head. |
| Provider observations conflict, tips change during the read, or an accepted publication's block leaves the active chain | Chain/evidence changed. Discard the inconsistent result and retry against a stable snapshot, with bounded retries. If it cannot stabilize, return unavailable. |
| Complete consistent enumeration contains no valid boundary for the requested sat/profile | Not found for this profile at this snapshot. This does not assert that no bytes or other protocol assets exist on the sat. |

Read failures are not equivalent to malformed bytes. In particular a body limit,
timeout, missing metadata field or a truncated provider response cannot prove a
candidate is junk. Conversely, a fully inspected invalid candidate must not
halt resolution solely because it was inscribed on the same sat.

Association mismatch has two different meanings. If the provider lists an
inscription under sat S but its observed assignment says another sat or network,
the collection is inconsistent evidence; do not ignore the record and assert
the remaining enumeration is complete. If a correctly observed inscription on
S contains a signed migration to a different sat/network, its proposed boundary
is invalid for S and can be ignored. One is a failed observation, the other is
a fully inspected invalid application claim.

The result exposes separate facts: authenticated history/prefix, whether the sat
enumeration was complete, the chain snapshot, current head at that snapshot,
and live ownership at that snapshot. An offline or incomplete result must not
collapse to an unconditional `verified: true`. A deactivated Original may still
return authenticated history and ownership metadata; ordinary DID resolution
must indicate deactivation rather than presenting an active authority document.

## Reorganizations, caching and writers

On every fresh btco read, re-establish the active chain/index snapshot and current
sat ownership. Reuse cached history only after checking its accepted publication
blocks against that snapshot and inspecting complete new sat observations.
Recompute from the earliest changed point (or from scratch) after a reorganization.
An orphaned rotation no longer retires a key on the new accepted chain; an
orphaned deactivation no longer makes the asset terminal there. Do not retain
the old head, current controller, resource version or owner as verified data.

Confirmation depth qualifies the observation; it is not absolute finality.
The earlier landing recovery horizon of six confirmations is an operational
transaction-retention policy, not this protocol's definition of immutable history.

Before a post-anchor write, resolve the accepted head from the sat and verify
the local proposal extends it. Unknown, stale or incomplete history blocks the
write. Serialize local operations per asset and sign against the resolved head;
verify the new entries before building/publishing their exact delta. Do not
fall back to a full snapshot or an in-memory inscription-boundary map. A fork
accepted while a competing transaction is in flight can leave a paid publication
unaccepted; report that result explicitly and re-resolve before a deliberate
new proposal. Do not silently declare the requested mutation successful or
automatically pay for a replacement publication.

## Decision examples and implementation gate

The [authority histories](../docs/research/cel-authority-vectors/README.md) record
expected heads, controllers, resources, aliases and separate ownership through
rotation, sale, reacquisition, batching, deactivation, competing publications,
missing evidence and reorganization. Their chain positions are declared
scenarios, not fabricated Bitcoin evidence. Public test keys supply actual
controller signatures for the event cases.

Production acceptance requires the new core to reproduce these outcomes through
its public verifier/fold and the SDK/DID consumers to share that result. Provider
evidence collection, real regtest publications/transfers/reorganizations and the
new-format end-to-end journey remain implementation work. Resolving this decision
does not establish those operational results or authorize public-chain activity.
