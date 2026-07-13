# Design: Bind asset identity to the anchored sat

> Closes the two verifier soundness residuals carried out of the CEL backbone
> work (design `2026-07-10-cel-backbone-did-cel-design.md` §7): **cross-sat
> fork** (Residual 1) and **witness-stripping** (Residual 2). Both close with a
> single rule — **asset identity = `did:cel` + the *signed* anchoring sat**.

## 0. Decision record

- **Trust anchor for the canonical sat:** self-certifying from the signed log.
  The canonical anchoring sat is a controller-signed commitment in the log's
  migrate-to-btco event, read at verification time from that signed body — not
  supplied out-of-band and not scraped from the unsigned witness proof. A
  verifier needs only the log + a Bitcoin provider.
- **`to` field form:** the migrate event's signed `data.to` becomes the full
  network-scoped resolvable DID `did:btco:<network>:<sat>` (e.g.
  `did:btco:reg:12345`, mainnet bare `did:btco:12345`), upgraded from today's
  bare `'did:btco'`. Consistent with how the webvh migrate already carries its
  full `to` id.
- **Backward compatibility:** hard cutover. A btco-anchored log whose migrate
  event does not sign its sat fails verification (`UNBOUND_ANCHOR`). This is
  safe *now*: nothing is released, there are no external consumers, and the
  only logs written by the merged Phases 1–4 code live in our own tests.
- **Scope boundary (honest):** this closes witness-*stripping* (dropping the
  witness while retaining the migrate event). Truncating the *entire* btco tail
  (migrate event included) remains the head-freshness / known-sat case —
  inherent to any self-describing log, and unchanged here. The signed migrate is
  what *supplies* the sat to the freshness check whenever the migrate is
  retained.

## 1. The hole today

`did:cel` is derived from the genesis event hash only, so it cannot name a sat
(the sat does not exist at creation). The anchoring sat enters the log **only**
through the Bitcoin witness proof, and `verifyEventLog` itself flags that proof
array as UNSIGNED. The fold reads the sat straight off the witness
(`satoshi: wp?.satoshi`), and the signed migrate body carries only
`{ layer: 'btco', migratedAt }` — no sat.

So `anchoredSat` is derived entirely from strippable, unsigned material. That
one fact enables both residuals:

- **Residual 1 — cross-sat fork.** Clone the whole log, rewrite the unsigned
  witness proofs to point at a sat the attacker controls. `did:cel` is
  unchanged (genesis-derived), so the fork reads as the *same asset*, now
  "anchored" on the attacker's sat — and the non-cooperative rotation arm lets
  the attacker (who controls that sat) extend the fork with self-signed
  reinscription-attested `rotateKey` events.
- **Residual 2 — witness-stripping.** Drop the witness proofs. The verifier now
  sees no anchor, so the anchoring/freshness gates never engage, and the log
  reads as a merely-genesis (never-anchored) asset that verifies.

## 2. Core rule

**Asset identity = (`did:cel`, canonical anchored sat).**

The canonical anchored sat is a controller-**signed** commitment in the
migrate-to-btco event. A btco-anchored log that does not sign its sat, or whose
signed sat disagrees with its witness or the chain, does not verify. A log that
shares a `did:cel` but names a *different* signed sat is a distinct
(non-canonical) object, not the same asset.

## 3. Writer — `LifecycleManager.inscribeOnBitcoin`

### The sequencing constraint and its existing resolution

The migrate event must be signed *before* the DID doc is inscribed, because the
inscribed DID doc's `#cel` anchor commits to the migrate event's digest. Today
the sat is unknown at that point, which is why it was left to the witness.

The `OrdinalsProvider` contract already resolves this. It pins the target sat at
commit and exposes it before the reveal:

```ts
// adapters/types.ts
/** Deferred content: called with the pinned satoshi between commit and
 *  reveal, so content that must embed its own sat (a did:btco DID
 *  document) can be built at the right moment. */
buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
```

The migrate event is exactly such content. **No Bitcoin plumbing or provider
contract change is required.**

### Change

Move the migrate-event append **into the `buildContent(satoshi)` window**, where
the sat is already pinned, and sign the sat into the body:

```
data = {
  layer: 'btco',
  to: `did:btco:<network>:<sat>`,   // full network-scoped resolvable DID
  migratedAt,
}
```

New sequence:

1. `commit` — pins sat `S`.
2. `buildContent(S)`:
   a. sign the migrate event with `to: did:btco:<network>:S`;
   b. compute its digest;
   c. build the DID doc, committing to that migrate digest and embedding `#cel`
      (as today).
3. `reveal` — inscribe the DID doc on `S`.
4. splice the (unsigned) Bitcoin witness proof onto the migrate event, now
   **required to carry `S`**.

`network` is derived from the SDK's configured Bitcoin network via the existing
`btcoDidFromSatoshi(satoshi, network)` helper (`src/cel/btcoDid.ts`), so mainnet
is bare and signet/regtest carry `sig`/`reg`.

## 4. Verifier — `verifyEventLog`

- **Derive `anchoredSat` from the signed migrate body** (`parseSatoshiIdentifier(data.to)`),
  not from the witness array. A migrate whose signed `data.to` is the bare
  `'did:btco'` (or otherwise carries no parseable sat) on a btco-layer migration
  is an `UNBOUND_ANCHOR` failure.
- **The Bitcoin witness proof MUST carry that same sat.** A witness on any other
  sat → reject (`bitcoin witness inscription … is carried by satoshi … not the
  claimed …`, now checked against the *signed* source of truth).
- **A signed btco migrate means the log is anchored.** Witness verification,
  head-freshness, and non-cooperative rotation ordering all key off the signed
  sat. If no provider is available to confirm the on-chain state, **fail closed**
  (STALE / unconfirmable) — never downgrade to never-anchored.
- **Non-cooperative rotation ordering:** unchanged in mechanism, but the anchored
  sat is now the *signed* one, so a fork cannot relocate authority to a sat it
  controls.
- **Retire the "poisoned anchor (>1 witness)" ambiguity rule.** The signed `to`
  disambiguates the canonical sat; extra witnesses on other sats are simply
  invalid (must match the signed sat), not a poison condition. The
  `sawBtcoAnchorAttempt` / multi-witness `anchoredSat = undefined` branch is
  replaced by "the signed sat is the anchor; witnesses must match it."

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
  `X`. The verifier must confirm `X` on-chain; without a provider it fails
  closed. It cannot read as never-anchored. Full-tail truncation (migrate event
  removed) remains the head-freshness / known-sat case per §0.

## 6. Unchanged

`did:cel` derivation, forward resolution (`did:cel → did:webvh → did:btco`),
and the ownership-is-the-sat model (ownership = live sat control, read via
`getCurrentOwner`). The btco binding simply becomes signed-and-verified instead
of witness-scraped.

## 7. Testing spine

- **Cross-sat fork:** clone a valid log, repoint the witness to an attacker sat
  → REJECT (witness ≠ signed sat); clone and rewrite the signed `to` to the
  attacker sat → REJECT (migrate controller signature no longer verifies).
- **Witness-stripping:** drop the witness, keep the signed migrate; no provider
  → fail closed (`STALE_LOG` / unconfirmable, NOT never-anchored); with a
  provider → verify against the signed sat `X`.
- **Honest round-trip:** a new signed-sat migrate verifies end to end through the
  Phase-3 creator→buyer hand-off; head-freshness and non-cooperative rotation
  stay green keyed off the signed sat.
- **Hard-cutover guard:** an old-shape btco migrate (bare `to: 'did:btco'`, sat
  only in the witness) → `UNBOUND_ANCHOR`.
- **Boundary (documented, not newly solved):** full-tail truncation still
  requires a caller-supplied sat/provider — asserted via the existing
  `STALE_LOG` path.

## 8. Out of scope / deferred

- Full-tail truncation without any external reference (inherent; §0).
- A canonical-sat *registry* or resolver mapping `did:cel → sat` (unnecessary
  under self-certification; the signed migrate is the source of truth).
- Migrating already-released logs (none exist).
- Cooperative rotate-then-transfer and cross-sat "move the asset to a new sat"
  semantics (a legitimate re-anchoring would be a new signed migrate; not
  designed here).
