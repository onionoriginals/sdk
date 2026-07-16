# Plan: Content-as-ordinal, provenance-in-metadata (#407 phase 2)

Implements `docs/superpowers/specs/2026-07-14-log-on-chain-phase2-design.md`.
Stacks on #409 (byte-light log). The anchoring inscription BECOMES the asset:
its **content** = the current media (most-recent resource bytes), its
**metadata** (CBOR) = `{ didDocument, celLog }`, and a new resolver rebuilds +
verifies the whole asset from a bare sat.

## Chunks (commit after each)

### 1. Provider metadata plumbing
- `OrdinalsProvider.createInscription` (adapters/types.ts): add static
  `metadata?: Record<string,unknown>` param; widen `buildContent` return to
  `Buffer | { content: Buffer; metadata?: Record<string,unknown> }`; add
  `metadata?` to the return shape.
- `getInscriptionById` return (adapters/types.ts AND cel/types.ts OrdinalsLookup):
  add `metadata?: Record<string,unknown>`.
- `OrdMockProvider`: normalize deferred `{content,metadata}`; static-metadata
  fallback; store metadata on the record; echo it from `getInscriptionById` and
  `createInscription`; `getAnchoringsForDidCel` reads `alsoKnownAs` from
  `metadata.didDocument` (fallback: content JSON).
- `BitcoinManager.inscribeData`: accept `options.metadata`; thread to
  `createInscription`; support the deferred builder returning `{content,metadata}`;
  return `metadata` on the `OrdinalsInscription`. `OrdinalsInscription` type gains
  `metadata?`.
- `commit.ts` already threads the metadata CBOR tag — no change.
- Tests: OrdMock round-trip; BitcoinManager deferred+metadata.

### 2. Writer
- Shared helper `mostRecentResourceHash(log)` (hex): last `update` event's toHash,
  else genesis primary resource[0] digest → hex. Used by writer AND verifier.
- `inscribeOnBitcoin`: before inscribe, resolve head resource
  (`asset.resources.find(hash === mostRecentResourceHash)`), its bytes + contentType
  (fail closed if missing/no inline content). Deferred builder now returns
  `{ content: mediaBytes, metadata: { didDocument: btcoDoc, celLog: <byte-light
  snapshot after migrate append> } }`; contentType arg = media type. Integrity
  cross-check reads `inscription.metadata.didDocument.id` (was `content`).
- `rotateBtcoKeys` / `authorizeSigner` (via `reinscribeRotatedDoc`): content =
  head media, static metadata `{ didDocument: rotatedDoc, celLog: snapshot }`.
- Tests: content == media bytes; metadata carries didDocument+celLog; celLog head
  == #cel anchor; point-in-time; most-recent selection.

### 3. Verifier
- Helper `didDocumentFromInscription(insc)`: prefer `metadata.didDocument`, fall
  back to parsing `content` as JSON (phase-1 back-compat).
- `verifyBitcoinWitnessProof` shape (b): read DID doc via helper (was content).
  Shape (a) standalone witness attestation (`content.digestMultibase`) unchanged.
- `verifyHeadFreshness` + `evaluateNonCooperativeRotation`: read the anchor DID
  doc via the helper.
- Content-hash gate: when the anchor inscription carries metadata (phase-2),
  `hashResource(content)` MUST equal `mostRecentResourceHash(log)` — new
  fail-closed error included in `verified`.
- Tests: metadata source; tampered metadata celLog rejected; content-hash mismatch
  rejected.

### 4. Resolver
- `LifecycleManager.resolveAssetFromSat(satoshi, opts?)`:
  1. `getInscriptionsBySatoshi` → newest by confirmed block height (fail closed on
     missing height / ties).
  2. `getInscriptionById` → metadata `{didDocument, celLog}` + content.
  3. Assert `metadata.celLog` head digest == `#cel` anchor headDigestMultibase.
  4. Reconstruct byte-light envelope: eventLog = celLog (with a reconstructed
     bitcoin witness proof attached to HEAD pointing at this inscription);
     resources rebuilt from genesis + update events, head resource gets the
     content blob (verify hash == head hash first); didDocuments {did:cel derived,
     did:btco = metadata.didDocument}; assetDid = deriveDidCel(celLog).
  5. `loadAsset(envelope, { ordinalsProvider })` → verified asset.
- Tests: bare-sat round-trip (create→addResourceVersion→publish→inscribe→resolve);
  tampered metadata; content mismatch; newest-selection fail-closed.

### 5. Changeset + docs
- `.changeset/log-on-chain-phase2.md` (minor).

## Security (fable review before PR)
Fail-closed invariants: celLog head ≠ #cel → reject; tampered metadata log →
verifyEventLog rejects; content ≠ most-recent hash → reject; newest pick fails
closed on missing height/ties; resolver path never weaker than envelope-load.
