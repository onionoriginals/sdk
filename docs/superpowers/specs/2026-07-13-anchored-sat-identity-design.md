# Design: Bind asset identity to the unique, first-anchored sat

> Closes the CEL verifier soundness gaps carried out of the backbone work
> (design `2026-07-10-cel-backbone-did-cel-design.md` §7) **and** the
> malicious-controller duping case, with one rule:
> **asset identity = `did:cel` + the *signed, first-anchored* sat.**
>
> Three attacks, one identity rule:
> 1. **Cross-sat fork** (Residual 1) — keyless cloner repoints the unsigned
>    witness to their own sat.
> 2. **Witness-stripping** (Residual 2) — keyless cloner drops the witness so an
>    anchored asset reads as never-anchored.
> 3. **Malicious-controller duping** — the *key-holding* controller signs the
>    same `did:cel` onto two different sats and sells both.
>
> Parts A (signed sat) closes 1 and 2; Part B (first-anchor-wins) closes 3.

## 0. Decision record

- **Trust anchor for the canonical sat:** self-certifying from the signed log.
  The anchoring sat is a controller-signed commitment in the migrate-to-btco
  event, read from that signed body — not out-of-band, not scraped from the
  unsigned witness.
- **`to` field form:** the migrate event's signed `data.to` becomes the full
  network-scoped resolvable DID `did:btco:<network>:<sat>` (mainnet bare,
  signet/regtest carry `sig`/`reg`), upgraded from today's bare `'did:btco'`.
- **Uniqueness rule:** first-anchor-wins. The canonical sat for a `did:cel` is
  the sat of its **earliest on-chain anchoring** (lowest confirmed block
  height). A log anchored on any later, different sat is a non-canonical dupe
  and fails verification.
- **Uniqueness is a gated, optional check.** It requires a provider that can
  enumerate anchorings by `did:cel` (a content index). Mirroring
  `checkHeadFreshness`: the check runs only when requested; when requested but
  the provider can't enumerate, it fails closed (`UNIQUENESS_UNVERIFIABLE`)
  rather than silently passing. A verifier with only a basic provider still
  gets the sat-binding guarantees (Part A); it just doesn't assert uniqueness.
- **Backward compatibility:** hard cutover. A btco-anchored log whose migrate
  event does not sign its sat fails verification (`UNBOUND_ANCHOR`). Safe now:
  nothing released, no external consumers, only test logs exist.
- **Scope boundary (honest):** Part A closes witness-*stripping* (witness
  dropped, migrate retained). Truncating the *entire* btco tail remains the
  head-freshness / known-sat case — inherent to any self-describing log. Part B
  cannot break a same-block dupe tie without a finer on-chain ordering signal;
  same-block ties fail closed (`AMBIGUOUS_CANONICAL`) — a documented residual.

---

# Part A — Bind the sat into the signed log

## A.1 The hole today

`did:cel` is derived from the genesis event hash only, so it cannot name a sat
(the sat does not exist at creation). The anchoring sat enters the log **only**
through the Bitcoin witness proof, which `verifyEventLog` itself flags as
UNSIGNED. The fold reads the sat straight off the witness
(`satoshi: wp?.satoshi`); the signed migrate body carries only
`{ layer: 'btco', migratedAt }`. So `anchoredSat` is derived entirely from
strippable, unsigned material — enabling Residuals 1 and 2.

## A.2 Core rule

**Asset identity = (`did:cel`, canonical anchored sat).** The canonical sat is a
controller-**signed** commitment in the migrate-to-btco event. A btco-anchored
log that does not sign its sat, or whose signed sat disagrees with its witness
or the chain, does not verify.

## A.3 Writer — `LifecycleManager.inscribeOnBitcoin`

**Sequencing constraint & its existing resolution.** The migrate event must be
signed *before* the DID doc is inscribed, because the inscribed doc's `#cel`
anchor commits to the migrate event's digest. The `OrdinalsProvider` contract
already pins the target sat at commit and exposes it before the reveal:

```ts
// adapters/types.ts
/** Deferred content: called with the pinned satoshi between commit and
 *  reveal, so content that must embed its own sat (a did:btco DID
 *  document) can be built at the right moment. */
buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
```

The migrate event is exactly such content — **no Bitcoin plumbing or provider
contract change is required.**

**Change.** Move the migrate-event append **into the `buildContent(satoshi)`
window** and sign the sat into the body:

```
data = { layer: 'btco', to: `did:btco:<network>:<sat>`, migratedAt }
```

New sequence:

1. `commit` — pins sat `S`.
2. `buildContent(S)`: (a) sign the migrate event with `to: did:btco:<network>:S`;
   (b) compute its digest; (c) build the DID doc committing to that digest and
   embedding `#cel`, **and adding `did:cel:<Z>` to the doc's `alsoKnownAs`** (see
   Part B — makes the on-chain artifact indexable by `did:cel`).
3. `reveal` — inscribe the DID doc on `S`.
4. splice the unsigned Bitcoin witness proof onto the migrate event, now
   **required to carry `S`**.

`network` comes from the SDK's configured Bitcoin network via the existing
`btcoDidFromSatoshi(satoshi, network)` helper (`src/cel/btcoDid.ts`).

## A.4 Verifier — `verifyEventLog`

- **Derive `anchoredSat` from the signed migrate body**
  (`parseSatoshiIdentifier(data.to)`), not the witness array. A btco-layer
  migrate whose signed `data.to` carries no parseable sat → `UNBOUND_ANCHOR`.
- **The Bitcoin witness proof MUST carry that same sat.** A witness on any other
  sat → reject.
- **A signed btco migrate means the log is anchored.** Witness verification,
  head-freshness, and non-cooperative rotation ordering all key off the signed
  sat. No provider to confirm → **fail closed**, never downgrade to
  never-anchored.
- **Retire the "poisoned anchor (>1 witness)" ambiguity rule.** The signed `to`
  disambiguates; extra witnesses on other sats are simply invalid (must match
  the signed sat), not a poison condition.

## A.5 Why Residuals 1 & 2 close

- **Cross-sat fork.** Relocating to sat `Y` requires a controller-signed migrate
  naming `did:btco:<network>:Y`. The attacker lacks the original controller key;
  re-signing genesis changes the `did:cel` (→ a different asset). Swapping only
  the unsigned witness now contradicts the signed `to` → reject. The fork is
  inert: it verifies at most as the same asset on the *original* sat `X` (which
  the attacker does not control, so live ownership is not theirs).
- **Witness-stripping.** The signed migrate still declares anchoring on `X` →
  the verifier must confirm `X` on-chain, failing closed without a provider. It
  cannot read as never-anchored. Full-tail truncation remains the head-freshness
  / known-sat case per §0.

---

# Part B — First-anchor-wins uniqueness (malicious-controller duping)

## B.1 The attack

The genesis (`create`) event is signed once → fixed `did:cel`. The controller
then signs **two** migrate-to-btco events — one naming `did:btco:…:X`, one
naming `did:btco:…:Y` — and inscribes on both sats. Both branches share the
identical pre-btco prefix (same `did:cel`), are validly controller-signed, and
pass Part A verification independently. The controller sells the X-branch to
Alice and the Y-branch to Bob. Neither can detect the other — a verifier sees
one log at a time. Part A binds each branch to its own sat but never says which
`(did:cel, sat)` pair is *the* canonical one.

Note the harm is bounded: under ownership-is-the-sat, Alice solely owns sat `X`
and Bob solely owns sat `Y` — different, genuinely-unique sats, neither can take
the other's. The violation is of **provenance exclusivity** (the `did:cel`
lineage was minted 1-of-2, not 1-of-1), not of ownership.

## B.2 Rule

**The canonical sat for a `did:cel` is the sat of its earliest on-chain
anchoring.** A btco-anchored log whose signed sat is not the earliest anchoring
of its `did:cel` is a non-canonical dupe → `NON_CANONICAL_ANCHOR`.

"Earliest" = lowest confirmed block height across all anchorings, **grouped by
sat**. Multiple inscriptions on the *same* sat (the migrate plus each
non-cooperative-rotation reinscription) are expected and do not compete — only a
*different* sat with an earlier anchoring wins. Same-block ties between
different sats fail closed (`AMBIGUOUS_CANONICAL`).

## B.3 Writer change

The inscribed did:btco DID doc must reference its `did:cel` so the anchoring is
indexable. Today `migrateToDIDBTCO` sets `alsoKnownAs: [oldDid]` (the immediate
predecessor, `did:webvh`). Add the `did:cel` to that array:
`alsoKnownAs: [did:cel:<Z>, <did:webvh...>]`. This is the change already
referenced in A.3 step 2b.

## B.4 Provider capability (new, optional)

Add to `OrdinalsLookup` an optional method, mirroring the optional
`getInscriptionsBySatoshi`:

```ts
/**
 * Enumerate every on-chain btco DID-doc anchoring whose alsoKnownAs
 * references this did:cel. Optional: providers without a content index
 * omit it, and uniqueness cannot then be asserted (fails closed when the
 * check is requested). blockHeight is the canonical ordering signal.
 */
getAnchoringsForDidCel?(didCel: string): Promise<Array<{
  satoshi: string;
  inscriptionId: string;
  blockHeight?: number;
}>>;
```

`OrdMockProvider` implements it for tests. Production providers implement it via
their content index (an `ord` instance with metadata indexing, or a service such
as the QuickNode Ordinals add-on).

## B.5 Verifier — gated uniqueness check

A new option `checkAnchorUniqueness` (peer of `checkHeadFreshness`). When set and
the log is btco-anchored on signed sat `X` for `did:cel` `Z`:

1. If the provider has no `getAnchoringsForDidCel` → `UNIQUENESS_UNVERIFIABLE`
   (fail closed).
2. `anchorings = getAnchoringsForDidCel(Z)`.
3. Group by satoshi; take the group whose earliest inscription has the lowest
   `blockHeight`. Any anchoring missing a `blockHeight` → fail closed
   (`UNIQUENESS_UNVERIFIABLE`, consistent with the ordering-fix posture).
4. If two *different* sats tie on the lowest block height →
   `AMBIGUOUS_CANONICAL` (fail closed).
5. `canonicalSat` = that group's satoshi. If `X !== canonicalSat` →
   `NON_CANONICAL_ANCHOR`.

**Wiring.** `loadAsset` / `verifyAsset` set `checkAnchorUniqueness` when the
configured `ordinalsProvider` advertises `getAnchoringsForDidCel` — same pattern
as `checkHeadFreshness`. The verification result surfaces whether uniqueness was
checked, so a caller on a basic provider can see it was not asserted.

## B.6 Why duping closes

Controller anchors `X` at block 100, then `Y` at block 200 (same `did:cel` `Z`).
Both pass Part A. Bob (holding the `Y`-branch) runs the uniqueness check:
`getAnchoringsForDidCel(Z)` → `[{X, 100}, {Y, 200}]` → canonical `= X` →
`Y !== X` → `NON_CANONICAL_ANCHOR`. Bob's log fails; he is protected. Alice's
`X`-branch verifies as canonical. The controller cannot reorder history — the
first anchor is immutable — and cannot sell the single canonical sat twice
(a sat is owned by one UTXO holder). A non-controller cannot pre-empt with an
earlier anchor because anchoring requires the controller key.

## B.7 Uniqueness residuals

- **Same-block dupe:** two different sats anchored in the same block →
  `AMBIGUOUS_CANONICAL` fail-closed. A finer total order (ordinals inscription
  number) would break it; not exposed by the provider contract today. Deferred.
- **Basic provider:** without `getAnchoringsForDidCel`, uniqueness is
  unverifiable; the verifier still delivers Part A guarantees and reports
  uniqueness as unchecked.

---

## 5. Unchanged

`did:cel` derivation, forward resolution (`did:cel → did:webvh → did:btco`), and
the ownership-is-the-sat model. The btco binding becomes signed-and-verified
instead of witness-scraped; the DID doc gains a `did:cel` back-link.

## 6. Testing spine

- **Cross-sat fork:** clone a valid log, repoint the witness to an attacker sat →
  REJECT (witness ≠ signed sat); rewrite the signed `to` to the attacker sat →
  REJECT (migrate signature invalid).
- **Witness-stripping:** drop the witness, keep the signed migrate; no provider →
  fail closed (not never-anchored); with provider → verify against signed `X`.
- **Duping / first-anchor-wins:** two controller-signed branches of one `did:cel`
  on sats `X`(block 100) and `Y`(block 200); the `Y`-branch →
  `NON_CANONICAL_ANCHOR`; the `X`-branch verifies. Same-block `X`/`Y` →
  `AMBIGUOUS_CANONICAL`. Multiple inscriptions on the canonical sat (migrate +
  rotation reinscriptions) do NOT trip the check.
- **Provider posture:** `checkAnchorUniqueness` with a provider lacking
  `getAnchoringsForDidCel` → `UNIQUENESS_UNVERIFIABLE`; with a basic provider and
  the check off, Part A still verifies and the result marks uniqueness unchecked.
- **Honest round-trip:** a new signed-sat migrate verifies end to end through the
  Phase-3 creator→buyer hand-off; head-freshness and non-cooperative rotation
  stay green keyed off the signed sat.
- **Hard-cutover guard:** an old-shape btco migrate (bare `to: 'did:btco'`) →
  `UNBOUND_ANCHOR`.

## 7. Out of scope / deferred

- Full-tail truncation without any external reference (inherent; §0).
- Same-block dupe tiebreak via ordinals inscription number (needs a finer
  provider ordering signal; B.7).
- Legitimate cross-sat re-anchoring (moving an asset to a new sat) — would be a
  new signed migrate with its own canonicality question; not designed here.
- Migrating already-released logs (none exist).
