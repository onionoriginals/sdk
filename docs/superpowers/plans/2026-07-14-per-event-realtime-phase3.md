# Plan: Per-event real-time chain-recoverability (#407 phase 3)

Stacks on #410 (phase 2). Spec: `docs/superpowers/specs/2026-07-14-per-event-realtime-phase3-design.md`.

## Key facts established by reading the code

- `verifyEventLog` enforces a STRICT contiguous hash chain: `event[i].previousEvent
  == digest(event[i-1])`. Any gap → "Hash chain broken". So a reconstructed log
  must be the exact contiguous event sequence.
- After every btco inscription (migrate/rotation) a NON-inscribed witness-ack
  `update` event is appended to the hosted log. So the inscribed snapshot is a
  PREFIX of the hosted log; the trailing ack lands only in the next inscription's
  delta. Pure per-op deltas must therefore include those interleaved acks or
  continuity breaks.
- `addResourceVersion` (OriginalsAsset) drives appends via the bound
  `#celAppender` → `appendCelEventOrSkip(asset, type, data)`. It is the ONLY
  caller of `#celAppender`. Witness-acks call `appendCelEventOrSkip` DIRECTLY, so
  re-binding the appender does not make acks inscribe.
- Migrate (`inscribeOnBitcoin`) and rotation (`rotateBtcoKeys`/`authorizeSigner`
  → `reinscribeRotatedDoc`) already inscribe, embedding FULL `metadata.celLog`
  snapshot + `metadata.didDocument` (with `#cel` head anchor). Content = current
  media (or DID-doc fallback for pure-reference heads).
- Phase-2 resolver `resolveAssetFromSat` reads ONLY the newest anchor
  inscription's full `celLog`.
- Provider metadata: `OrdMockProvider` already round-trips `metadata`.
  `QuickNodeProvider`/`OrdHttpProvider` `getInscriptionById` do NOT decode CBOR
  metadata yet. `utils/cbor.ts` `decode()` + `OrdinalsClient.getMetadata`
  (`/r/metadata/<id>`) are the references.

## Design decisions

### Metadata shape (hybrid snapshot + delta)
- **migrate / rotation**: UNCHANGED — carry FULL `metadata.celLog` (checkpoint).
- **resource-update on btco (NEW)**: carry `metadata.events` = the DELTA of log
  events appended since the last on-chain-committed head, plus
  `metadata.didDocument` = the current btco doc rebuilt with fresh `#resources`
  manifest + `#cel` head anchor. Content = the new media bytes (or DID-doc
  fallback).
- Delta boundary tracked in a manager `WeakMap<asset, headDigest>` set after each
  inscription (migrate/rotation/resource-update). When the boundary is unknown,
  FALL BACK to a FULL `celLog` snapshot (safe checkpoint) — correctness never
  depends on the WeakMap; it is a byte-cost optimization.

### Resolver — walk the chain (hybrid REPLACE/APPEND)
1. `getInscriptionsBySatoshi(sat)` → fetch each, order by `(blockHeight asc,
   listIdx asc)`. Missing block height on ANY anchoring inscription → fail closed.
   Same-height ties fall back to provider list order (oldest-first contract, same
   residual as `selectNewestAnchorInscription`); a wrong tie order yields a broken
   chain that `verifyEventLog` rejects — fail-closed in effect.
2. Filter to OUR anchoring inscriptions (have `metadata.celLog` OR
   `metadata.events`).
3. Walk oldest→newest: `metadata.celLog` → REPLACE reconstructed events
   (checkpoint); `metadata.events` → APPEND (delta). Result = full current log.
4. Current media = the newest inscription content that hashes to the log's
   most-recent-resource head hash.
5. Reattach head witness proof, build envelope, `loadAsset(env, { provider })` —
   same full gate (verifyEventLog + resource binding + head freshness).

### Provider metadata (§2b)
- `OrdHttpProvider` / `QuickNodeProvider` `getInscriptionById`: fetch + CBOR-decode
  inscription metadata. Decode failure on present bytes → clear fail-closed
  error (`*_METADATA_UNDECODABLE`). Absent/404 metadata → `undefined` (a
  legitimately metadata-less inscription; the resolver rejects it clearly).

### Cost surfacing (§0/§5)
- Before a btco resource-update inscription, estimate cost (fee rate × est. vsize)
  and emit a `cel:inscribe-cost` manager event. When on btco but NO provider is
  configured, degrade to a hosted append and emit a clear
  `cel:append-inscribe-skipped` signal (reason `NO_ORDINALS_PROVIDER`) — matches
  spec §1 "provider-absent → hosted append (degrade)". Not silent.

## Commits (grep→read-window→edit→commit each)
1. Plan (this file). ✅
2. Provider CBOR metadata decode (OrdHttp + QuickNode) + fail-closed. Tests.
3. Writer: `appendCelEventAndMaybeInscribe` + rebind + WeakMap boundary + set in
   migrate/rotation.
4. Resolver chain-walk.
5. Cost surfacing + provider-absent degrade signal + new event types.
6. Fixtures/tests (round-trip, immediacy, ordering, gap/tamper, cost, degrade) +
   changeset (minor).
7. fable security review → fixes → build/test/tsc → PR → babysit CI + Greptile.

## Security invariants (fable review targets)
- Cross-inscription continuity verified by `verifyEventLog` on the concatenated
  log (gap/inconsistent previousEvent → reject).
- Block-height ordering fails closed on missing height; tie mis-order → broken
  chain → reject.
- Tampered metadata event → verifyEventLog rejects (chain digest / signature).
- Provider that cannot decode metadata → clear error, never silent partial
  reconstruction.
- Media hash-bound to signed head hash by loadAsset (tampered media → reject).
