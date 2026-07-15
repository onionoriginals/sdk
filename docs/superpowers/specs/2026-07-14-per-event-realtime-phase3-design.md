# Design: Per-event real-time chain-recoverability (epic #407, phase 3)

> Third increment of epic #407 ("The CEL lives on the sat"). Phase 2 (#410) put
> a point-in-time log snapshot on-chain (recoverable as-of-last-inscription).
> Phase 3 makes it **real-time**: once an asset is on did:btco, **every
> authorship append inscribes as it happens**, so the sat's inscription chain
> IS the always-current log. Every btco append becomes a paid Bitcoin op.
>
> **Stacks on #410** (phase 2's resolver + content-as-ordinal + metadata
> plumbing). Branch off the phase-2 branch / main-after-#410.

## 0. Decision record

- **Mandatory per-event inscription.** For a did:btco asset, every authorship
  append (`addResourceVersion`, `rotateKey`, any CEL append) is inscribed on the
  anchoring sat as it happens. The on-chain log is always current — no
  point-in-time staleness. This is deliberate: it removes the free-webvh append
  benefit for btco assets (every append costs an inscription + confirmation).
- **Each append inscribes a delta, not a full re-snapshot.** Content = any NEW
  content the append introduces (a resource update → the new primary media; a
  rotation → no new content). Metadata = the new event(s) + the updated
  did:btco DID doc / `#cel` head.
- **The sat's inscription chain = the log.** The phase-2 inscription is the base
  snapshot (all pre-btco events + genesis media); each subsequent append adds one
  inscription. Reconstruction concatenates them in block order.
- **Cost is surfaced, not hidden.** Append ops report a cost estimate and require
  explicit intent (they are paid Bitcoin ops). The full tier/who-pays UX is a
  later phase; per-event just forces cost-awareness.

## 1. Append path — btco appends become Bitcoin ops

Today (post phase 2): a did:btco asset's `addResourceVersion`/CEL appends write
the signed event to the hosted log; only `rotateBtcoKeys` re-inscribes.
Phase 3: for a did:btco asset, the CEL-append path (`appendCelEventOrSkip`-driven
appends: `addResourceVersion`, and rotation) **also inscribes** the new event:
1. Sign + append the event to the log (as today).
2. Inscribe on the anchoring sat via `bitcoinManager.inscribeData({ buildContent })`:
   content = new media (resource update) or none (rotation); metadata =
   `{ event(s): [<new event>], didDocument: <updated did:btco doc with #cel head> }`.
3. Attach the bitcoin witness proof (as the existing inscribe/rotate paths do).
- Requires the ordinalsProvider; off-btco or provider-absent → hosted append as
  today (degrade unchanged).
- Async + confirmation-bearing: the append now returns after inscription (mirrors
  `inscribeOnBitcoin`/`rotateBtcoKeys` sequencing, incl. the `buildContent`
  sat-pinning window and lock).

## 2. Reconstruction — resolver walks the chain

Extends the phase-2 resolver (which read one snapshot inscription):
1. `getInscriptionsBySatoshi(sat)` → all inscriptions, ordered by confirmed block
   height (fail-closed on missing height / ambiguous ties).
2. For each, `getInscriptionById` → read `metadata.event(s)` and (newest
   content-bearing) `content`.
3. **Concatenate** the events across inscriptions in order → the full current
   log. Current media = the newest content-bearing inscription's content.
4. Run `verifyEventLog` on the concatenated log (all anchored-sat / uniqueness /
   continuity / witness checks apply — chain origin never relaxes verification),
   and confirm the current media hashes to the log's most-recent-resource hash.
Returns the verified, **always-current** asset from the bare sat.

## 2b. Provider metadata plumbing (carry-over)

Phase 2 plumbed `metadata` through `OrdMockProvider`. Phase 3 requires it on the
**production** providers used to read/reconstruct a real chain — ensure
`QuickNodeProvider` / `OrdHttpProvider` `getInscriptionById` decode inscription
metadata (a provider that cannot read metadata cannot reconstruct → fail closed
with a clear error). (Finish the metadata read-decode that phase 2 began.)

## 3. Integrity / security

- Each inscription's event(s) chain from the prior (`previousEvent` hash) and
  commit to the new `#cel` head; a gap or inconsistent chain across inscriptions
  → reject.
- Ordering strictly by confirmed block height; same-block ambiguity fails closed.
- `verifyEventLog` gates the full concatenated log identically to any log.
- Media hash-check unchanged (content ≠ most-recent-resource hash → reject).

## 4. Boundaries / deferred (later #407 phases)

- Checkpoint/squash tier + the full fee / who-pays / tier-selection UX.
- Secondary / older-version content as separate `did:btco`-addressed ordinals.
- Batching/debounce of appends (this phase inscribes each append immediately).

## 5. Testing spine

- **Real-time round-trip:** create → publish → inscribe → `addResourceVersion`
  (inscribes) → `rotateKey` (inscribes); a resolver with ONLY the sat + provider
  rebuilds the FULL current log (all events, in order) + current media, verified,
  no envelope/host.
- **Immediacy:** an append is on-chain immediately (recoverable before any later
  rotation), unlike phase 2's point-in-time.
- **Ordering:** the inscription chain reconstructs events in correct order across
  several appends.
- **Gap/tamper:** a missing or chain-inconsistent inscription → reject; tampered
  event metadata → `verifyEventLog` rejects.
- **Cost surfacing:** a btco append reports a cost estimate and requires the
  provider (fails clearly without one).
- **Degrade:** off-btco / no-provider append behaves as the hosted append (phase
  ≤2) — unchanged.

## 6. Changeset

`@originals/sdk` **minor** — did:btco authorship appends (`addResourceVersion`,
`rotateKey`) now inscribe each event on the anchoring sat, making the on-chain
log always current; the resolver reconstructs the full log from the sat's
inscription chain. Provenance is now **real-time** recoverable from Bitcoin
alone (#407). btco appends are now paid Bitcoin operations.
