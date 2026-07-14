# Design: `did:cel` uniqueness via first-anchor-wins

> **Follow-up to** `2026-07-13-anchored-sat-identity-design.md` (the signed-sat
> binding), which is a hard prerequisite: uniqueness compares *signed* anchoring
> sats, so it is meaningless until the sat is a signed, verifier-trusted field.
> Ship the signed-sat spec first, then this.
>
> Closes the **malicious-controller duping** case: a key-holding controller signs
> one `did:cel` onto two different sats and sells both. The signed-sat binding
> makes each `(did:cel, sat)` pair internally sound but never says which pair is
> *the* canonical one — this spec does.

## 0. Decision record

- **Rule:** first-anchor-wins. The canonical sat for a `did:cel` is the sat of
  its **earliest on-chain anchoring** (lowest confirmed block height, grouped by
  sat). A btco-anchored log whose signed sat is not that canonical sat is a
  non-canonical dupe → `NON_CANONICAL_ANCHOR`.
- **Provider posture:** uniqueness is part of the btco verification contract, not
  an opt-in extra. A btco-anchored log already *requires* an ordinals provider to
  verify (witness proof, head-freshness). Extending that same provider to
  enumerate anchorings by `did:cel` is not a new dependency — so for a
  btco-anchored log, a provider that cannot enumerate fails closed
  (`UNIQUENESS_UNVERIFIABLE`), exactly as a missing provider already fails the
  anchoring checks. No basic-provider "skip" path.
- **Scope boundary (honest):** first-anchor-wins cannot break a same-block dupe
  tie between two different sats without a finer on-chain ordering signal
  (ordinals inscription number), which the provider contract does not expose
  today. Same-block ties between different sats fail closed
  (`AMBIGUOUS_CANONICAL`).

## 1. The attack

The genesis (`create`) event is signed once → fixed `did:cel`. The controller
then signs **two** migrate-to-btco events — one naming `did:btco:…:X`, one naming
`did:btco:…:Y` — and inscribes on both sats. Both branches share the identical
pre-btco prefix (same `did:cel`), are validly controller-signed, and pass
signed-sat verification independently. The controller sells the X-branch to Alice
and the Y-branch to Bob. Neither can detect the other — a verifier sees one log
at a time.

**Harm is bounded but real.** Under ownership-is-the-sat, Alice solely owns sat
`X` and Bob solely owns sat `Y` — different, genuinely unique sats; neither can
take the other's. The violation is of **provenance exclusivity** (the `did:cel`
lineage was minted 1-of-2, not 1-of-1), not of ownership. This spec restores
exclusivity: at most one `(did:cel, sat)` pair is canonical.

## 2. Rule

**The canonical sat for a `did:cel` is the sat of its earliest on-chain
anchoring.** "Earliest" = lowest confirmed block height across all anchorings,
**grouped by sat**.

- Multiple inscriptions on the *same* sat (the migrate plus each
  non-cooperative-rotation reinscription) are expected and do not compete — only
  a *different* sat with an earlier anchoring wins.
- A btco-anchored log whose signed sat ≠ the canonical sat →
  `NON_CANONICAL_ANCHOR`.
- Same-block tie between two *different* sats → `AMBIGUOUS_CANONICAL` (fail
  closed).

## 3. Writer change — indexable anchorings

The inscribed did:btco DID doc must reference its `did:cel` so anchorings are
enumerable. Today `migrateToDIDBTCO` sets `alsoKnownAs: [oldDid]` (the immediate
predecessor, `did:webvh`). Add the `did:cel` back-link:

```
alsoKnownAs: [ `did:cel:<Z>`, <did:webvh…> ]
```

This slots into the signed-sat spec's writer step 2c (building the DID doc inside
`buildContent(satoshi)`). No other writer change.

## 4. Provider capability

Add to `OrdinalsLookup` a method to enumerate anchorings by `did:cel`:

```ts
/**
 * Enumerate every on-chain btco DID-doc anchoring whose alsoKnownAs
 * references this did:cel. blockHeight is the canonical ordering signal.
 * Required for btco-anchored verification (a btco log already needs a
 * provider); a provider that cannot enumerate fails uniqueness closed.
 */
getAnchoringsForDidCel(didCel: string): Promise<Array<{
  satoshi: string;
  inscriptionId: string;
  blockHeight?: number;
}>>;
```

`OrdMockProvider` implements it for tests. Production providers implement it via
their content index (an `ord` instance with metadata indexing, or a service such
as the QuickNode Ordinals add-on). Because it is part of the btco verification
contract, it is a required (not optional) method for any provider used to verify
btco-anchored logs.

## 5. Verifier — the uniqueness check

For a log verified with a provider and btco-anchored on signed sat `X` for
`did:cel` `Z`:

1. If the provider has no `getAnchoringsForDidCel` → `UNIQUENESS_UNVERIFIABLE`
   (fail closed — same posture as a missing provider on the anchoring checks).
2. `anchorings = getAnchoringsForDidCel(Z)`.
3. Any anchoring missing a `blockHeight` → `UNIQUENESS_UNVERIFIABLE` (fail closed,
   consistent with the ordering-fix posture).
4. Group by satoshi; take the group whose earliest inscription has the lowest
   `blockHeight`. Two *different* sats tied on the lowest height →
   `AMBIGUOUS_CANONICAL` (fail closed).
5. `canonicalSat` = that group's satoshi. If `X !== canonicalSat` →
   `NON_CANONICAL_ANCHOR`.

The check runs whenever a btco-anchored log is verified with a provider (the
same trigger as head-freshness); it is not a separately toggled opt-in.

## 6. Why duping closes

Controller anchors `X` at block 100, then `Y` at block 200 (same `did:cel` `Z`).
Both pass signed-sat verification. Bob (holding the `Y`-branch) verifies with a
provider: `getAnchoringsForDidCel(Z)` → `[{X, 100}, {Y, 200}]` → canonical `= X`
→ `Y !== X` → `NON_CANONICAL_ANCHOR`. Bob's log fails; he is protected. Alice's
`X`-branch verifies as canonical. The controller cannot reorder history — the
first anchor is immutable — and cannot sell the single canonical sat twice (a sat
is owned by one UTXO holder). A non-controller cannot pre-empt with an earlier
anchor because anchoring requires the controller key.

## 7. Residuals

- **Same-block dupe:** two different sats anchored in the same block →
  `AMBIGUOUS_CANONICAL` fail-closed. A finer total order (ordinals inscription
  number) would break it deterministically; not exposed by the provider contract
  today. Deferred — would extend `getAnchoringsForDidCel` to return an inscription
  number and use `(blockHeight, inscriptionNumber)` as the order.
- **Provider trust:** the canonicality verdict is only as complete as the
  provider's content index. A provider that fails to return an existing earlier
  anchoring could wrongly bless a dupe. This is the same trust already placed in
  the provider for witness/ownership reads; out of scope to eliminate here.

## 8. Testing spine

- **First-anchor-wins:** two controller-signed branches of one `did:cel` on sats
  `X`(block 100) and `Y`(block 200); the `Y`-branch → `NON_CANONICAL_ANCHOR`; the
  `X`-branch verifies.
- **Rotation not a competitor:** a canonical log with migrate + N rotation
  reinscriptions on sat `X` (all referencing `Z`) verifies — multiple
  same-sat anchorings do NOT trip the check.
- **Same-block ambiguity:** `X` and `Y` both at block 100 → `AMBIGUOUS_CANONICAL`.
- **Provider posture:** btco-anchored log + provider lacking
  `getAnchoringsForDidCel` → `UNIQUENESS_UNVERIFIABLE`; anchoring missing a
  `blockHeight` → `UNIQUENESS_UNVERIFIABLE`.
- **Writer:** the inscribed btco doc's `alsoKnownAs` includes `did:cel:<Z>`;
  round-trip via `getAnchoringsForDidCel` finds it.

## 9. Out of scope / deferred

- Same-block dupe tiebreak via ordinals inscription number (§7).
- Eliminating provider-index trust (§7).
- Legitimate cross-sat re-anchoring (moving an asset to a new sat) — would be a
  new signed migrate with its own canonicality question.
