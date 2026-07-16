# Design: Bind asset identity to the signed anchored sat

> Closes the two keyless CEL verifier soundness residuals carried out of the
> backbone work (design `2026-07-10-cel-backbone-did-cel-design.md` §7):
> **cross-sat fork** (Residual 1) and **witness-stripping** (Residual 2). Both
> close with one rule — **asset identity = `did:cel` + the *signed* anchoring
> sat**.
>
> **Follow-up:** the malicious-controller *duping* case (a key-holder signs one
> `did:cel` onto two sats) is a distinct threat closed by first-anchor-wins
> uniqueness, specified separately in
> `2026-07-13-did-cel-uniqueness-first-anchor-wins-design.md`. This spec is a
> prerequisite for it (uniqueness compares *signed* sats) and ships first.

## 0. Decision record

- **Trust anchor for the canonical sat:** self-certifying from the signed log.
  The anchoring sat is a controller-signed commitment in the migrate-to-btco
  event, read from that signed body — not supplied out-of-band, not scraped from
  the unsigned witness. A verifier needs only the log + a Bitcoin provider.
- **`to` field form:** the migrate event's signed `data.to` becomes the full
  network-scoped resolvable DID `did:btco:<network>:<sat>` (e.g.
  `did:btco:reg:12345`; mainnet bare `did:btco:12345`), upgraded from today's
  bare `'did:btco'`. Consistent with how the webvh migrate already carries its
  full `to` id.
- **Backward compatibility:** hard cutover. A btco-anchored log whose migrate
  event does not sign its sat fails verification (`UNBOUND_ANCHOR`). Safe now:
  nothing released, no external consumers, only test logs exist.
- **Scope boundary (honest):** this closes witness-*stripping* (witness dropped,
  migrate retained). Truncating the *entire* btco tail (migrate included) remains
  the head-freshness / known-sat case — inherent to any self-describing log, and
  unchanged here. The signed migrate is what *supplies* the sat to the freshness
  check whenever the migrate is retained.

## 1. The hole today

`did:cel` is derived from the genesis event hash only, so it cannot name a sat
(the sat does not exist at creation). The anchoring sat enters the log **only**
through the Bitcoin witness proof, and `verifyEventLog` itself flags that proof
array as UNSIGNED. The fold reads the sat straight off the witness
(`satoshi: wp?.satoshi`), and the signed migrate body carries only
`{ layer: 'btco', migratedAt }` — no sat.

So `anchoredSat` is derived entirely from strippable, unsigned material, which
enables both residuals:

- **Residual 1 — cross-sat fork.** Clone the whole log, rewrite the unsigned
  witness proofs to point at a sat the attacker controls. `did:cel` is unchanged
  (genesis-derived), so the fork reads as the *same asset*, now "anchored" on the
  attacker's sat — and the non-cooperative rotation arm lets the attacker (who
  controls that sat) extend the fork with self-signed reinscription-attested
  `rotateKey` events.
- **Residual 2 — witness-stripping.** Drop the witness proofs. The verifier sees
  no anchor, so the anchoring/freshness gates never engage, and the log reads as
  a merely-genesis (never-anchored) asset that verifies.

## 2. Core rule

**Asset identity = (`did:cel`, canonical anchored sat).** The canonical anchored
sat is a controller-**signed** commitment in the migrate-to-btco event. A
btco-anchored log that does not sign its sat, or whose signed sat disagrees with
its witness or the chain, does not verify.

## 3. Writer — `LifecycleManager.inscribeOnBitcoin`

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
window**, where the sat is pinned, and sign the sat into the body:

```
data = { layer: 'btco', to: `did:btco:<network>:<sat>`, migratedAt }
```

New sequence:

1. `commit` — pins sat `S`.
2. `buildContent(S)`: (a) sign the migrate event with `to: did:btco:<network>:S`;
   (b) compute its digest; (c) build the DID doc, committing to that migrate
   digest and embedding `#cel` (as today).
3. `reveal` — inscribe the DID doc on `S`.
4. splice the unsigned Bitcoin witness proof onto the migrate event, now
   **required to carry `S`**.

`network` comes from the SDK's configured Bitcoin network via the existing
`btcoDidFromSatoshi(satoshi, network)` helper (`src/cel/btcoDid.ts`).

> The follow-up uniqueness spec adds `did:cel` to this DID doc's `alsoKnownAs` in
> the same step 2c. It is called out there, not required by this spec.

## 4. Verifier — `verifyEventLog`

- **Derive `anchoredSat` from the signed migrate body**
  (`parseSatoshiIdentifier(data.to)`), not the witness array. A btco-layer
  migrate whose signed `data.to` is the bare `'did:btco'` (or otherwise carries
  no parseable sat) → `UNBOUND_ANCHOR`.
- **The Bitcoin witness proof MUST carry that same sat.** A witness on any other
  sat → reject (now checked against the *signed* source of truth).
- **A signed btco migrate means the log is anchored.** Witness verification,
  head-freshness, and non-cooperative rotation ordering all key off the signed
  sat. No provider to confirm → **fail closed** (STALE / unconfirmable), never
  downgrade to never-anchored.
- **Non-cooperative rotation ordering:** unchanged in mechanism, but the anchored
  sat is now the *signed* one, so a fork cannot relocate authority to a sat it
  controls.
- **Retire the "poisoned anchor (>1 witness)" ambiguity rule.** The signed `to`
  disambiguates the canonical sat; extra witnesses on other sats are simply
  invalid (must match the signed sat), not a poison condition. The
  `sawBtcoAnchorAttempt` / multi-witness `anchoredSat = undefined` branch becomes
  "the signed sat is the anchor; witnesses must match it."

## 5. Why both residuals close

- **Cross-sat fork.** Relocating the asset to sat `Y` requires a
  controller-signed migrate naming `did:btco:<network>:Y`. The attacker lacks the
  original controller key. Re-signing the genesis event to substitute their own
  key changes the genesis digest → a *different* `did:cel` → a different asset
  (correct outcome). Swapping only the unsigned witness now contradicts the
  signed `to` → reject. The fork is inert: it verifies at most as the *same*
  asset anchored on the *original* sat `X` (which the attacker does not control,
  so live ownership — read from `X` — is not theirs).
- **Witness-stripping.** The signed migrate still declares btco anchoring on sat
  `X`. The verifier must confirm `X` on-chain; without a provider it fails closed.
  It cannot read as never-anchored. Full-tail truncation (migrate event removed)
  remains the head-freshness / known-sat case per §0.

## 6. Unchanged

`did:cel` derivation, forward resolution (`did:cel → did:webvh → did:btco`), and
the ownership-is-the-sat model (ownership = live sat control, read via
`getCurrentOwner`). The btco binding simply becomes signed-and-verified instead
of witness-scraped.

## 7. Testing spine

- **Cross-sat fork:** clone a valid log, repoint the witness to an attacker sat →
  REJECT (witness ≠ signed sat); clone and rewrite the signed `to` to the
  attacker sat → REJECT (migrate controller signature no longer verifies).
- **Witness-stripping:** drop the witness, keep the signed migrate; no provider →
  fail closed (`STALE_LOG` / unconfirmable, NOT never-anchored); with a provider →
  verify against the signed sat `X`.
- **Honest round-trip:** a new signed-sat migrate verifies end to end through the
  Phase-3 creator→buyer hand-off; head-freshness and non-cooperative rotation
  stay green keyed off the signed sat.
- **Hard-cutover guard:** an old-shape btco migrate (bare `to: 'did:btco'`, sat
  only in the witness) → `UNBOUND_ANCHOR`.
- **Boundary (documented, not newly solved):** full-tail truncation still
  requires a caller-supplied sat/provider — asserted via the existing `STALE_LOG`
  path.

## 8. Out of scope / deferred

- Malicious-controller duping / `did:cel` uniqueness — the follow-up
  first-anchor-wins spec.
- Full-tail truncation without any external reference (inherent; §0).
- Migrating already-released logs (none exist).
- Legitimate cross-sat re-anchoring (moving an asset to a new sat) — a new signed
  migrate; not designed here.
