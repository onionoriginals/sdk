# Design: Caller-selectable target sat for the genesis did:btco inscription

> **Release-critical gap for the 3.0.0 did:cel/did:btco work.** The satoshi
> number IS the permanent identity — `did:btco:<sat>`. Today
> `inscribeOnBitcoin(asset, feeRate?)` lets the ordinals provider pick whatever
> sat its UTXO selection lands on, and the DID is derived from that arbitrary
> choice (`LifecycleManager.ts:2287` → `migrateToDIDBTCO(asset.did, satoshi)`
> where `satoshi` comes from the inscription result, not the caller). The caller
> MUST control which sat the genesis inscription lands on. Reinscription already
> pins the sat (`targetSatoshi`); only the FIRST/genesis inscription lacks
> caller sat-selection.

## 0. Decision record

Settled during brainstorming:

- **Sourcing = caller provides the funding UTXO** (not a named sat the SDK hunts
  for, not wallet-address enumeration). The SDK is a library, not a wallet; the
  caller (or a wallet layer above) already controls the UTXO it wants to inscribe
  from. Named-sat→UTXO resolution is a future layer on top, out of scope here.
- **Granularity = first sat of the funding input.** The DID sat is the first sat
  of the caller's chosen funding UTXO — default ordinals behaviour, no pointer
  offset. The caller controls the sat by controlling which UTXO funds the
  inscription. Precise rare-sat-at-offset targeting is out of scope.
- **Sat source-of-truth = SDK derives it from the provider.** The caller passes
  only the funding outpoint; the SDK asks the provider's sat-index for that
  output's first sat. That derived value is authoritative and becomes the DID —
  the caller cannot assert a wrong sat.
- **Commit signing = external Bitcoin signer.** The caller passes a
  `BitcoinSigner`; the SDK hands it the commit PSBT to sign, then broadcasts. No
  raw keys transit the SDK. Mirrors the existing `ExternalSigner` production
  pattern (Turnkey/KMS). The reveal stays self-signed by the ephemeral key
  `createCommitTransaction` already generates.
- **Fail-closed on sat mismatch.** After reveal, the SDK verifies the actual
  inscription sat equals the derived sat; on any mismatch it rolls back and
  commits nothing. The DID can never silently be wrong.
- **Backward compat.** The legacy provider-picks-the-sat path stays for
  OrdMock/dev (no test churn). Production (QuickNode, which already refuses
  `createInscription`) requires the new sat-selected path.

## 1. API shape

`LifecycleManager.inscribeOnBitcoin` gains an options object. Supplying
`fundingUtxo` + `satSigner` switches onto the new sat-selected local-build path;
omitting them preserves the legacy path (§6).

```ts
inscribeOnBitcoin(
  asset: OriginalsAsset,
  opts?: number | {                 // number retained for back-compat = feeRate
    fundingUtxo?: Utxo;             // caller's outpoint; its FIRST sat becomes the DID
    satSigner?: BitcoinSigner;      // signs the commit PSBT (§3)
    changeAddress?: string;         // commit change destination
    feeRate?: number;
  }
): Promise<OriginalsAsset>
```

- `fundingUtxo` is the existing `Utxo` shape (`txid`, `vout`, `value`,
  `scriptPubKey`) — the caller owns it and supplies its details.
- When `fundingUtxo` is present, `satSigner` and `changeAddress` are REQUIRED
  (`INVALID_INPUT` otherwise).
- The legacy `feeRate`-only call (number or `{ feeRate }`) is unchanged.

`BatchLifecycleOperations.inscribeOnBitcoin` gains the same optional fields.

## 2. Provider contract addition

One new sat-index method on `OrdinalsProvider` (`adapters/types.ts`):

```ts
/**
 * The first (lowest-offset) satoshi contained in the given output, per the
 * provider's sat index. This is the sat an inscription funded by this output
 * lands on (no pointer). Used to derive the did:btco identity BEFORE building
 * the inscription. Providers without a sat index omit it; the genesis
 * sat-selected path then fails closed with SAT_INDEX_UNSUPPORTED.
 */
getFirstSatOfOutput?(outpoint: { txid: string; vout: number }): Promise<string>;
```

- `QuickNodeProvider` implements it via the Ordinals & Runes add-on.
- `OrdMockProvider` implements it deterministically (echoes a stable sat per
  outpoint so tests can assert the derived DID).
- `OrdHttpProvider` may implement it if its backend has a sat index; otherwise
  omit (callers get `SAT_INDEX_UNSUPPORTED`).
- Broadcast (`broadcastTransaction`) and post-hoc sat lookup
  (`getInscriptionById` / `getSatoshiFromInscription`) reuse existing methods.

## 3. Bitcoin external signer

A minimal new interface (`src/types/common.ts`, beside `ExternalSigner`):

```ts
interface BitcoinSigner {
  /** Sign the commit transaction's funding input(s). Returns the signed PSBT
   *  (base64) or a fully-signed tx hex ready to broadcast. */
  signCommitPsbt(psbtBase64: string): Promise<string>;
  /** The address funding the commit (used to validate the funding UTXO's
   *  scriptPubKey belongs to the signer, and as commit-change fallback). */
  getFundingAddress(): Promise<string> | string;
}
```

Only the commit needs the caller's authority (it spends the funding UTXO). The
reveal is self-signed by the ephemeral reveal key that
`createCommitTransaction` already returns (`revealPrivateKey`).

## 4. Flow (data path)

Inside a new sat-selected branch of `inscribeOnBitcoin` (delegating tx assembly
to a focused helper, e.g. `bitcoin/inscribe-on-sat.ts`, to keep
`LifecycleManager` from growing):

1. **Derive the sat.** `X = await provider.getFirstSatOfOutput(fundingUtxo)`. If
   the provider lacks the method → `SAT_INDEX_UNSUPPORTED` (fail closed). Validate
   `X` with `validateSatoshiNumber`.
2. **Build content.** `buildContent(X)` constructs the did:btco document (with
   `#cel` anchor) + byte-light CEL log embedding `to: did:btco:<network>:<X>` —
   the existing #407-phase-2 builder, now fed the caller-derived sat.
3. **Build commit.** `createCommitTransaction({ content, contentType, metadata,
   utxos: [fundingUtxo], changeAddress, feeRate, network, pointer: undefined })`.
   Single funding input + commit output at vout 0 ⇒ `X` (the funding UTXO's first
   sat) flows funding → commit output → reveal output as the first sat, so no
   pointer is needed. Returns the unsigned commit PSBT + reveal key + inscription
   script.
4. **Sign + broadcast commit.** `signed = await satSigner.signCommitPsbt(
   commitPsbtBase64)`; `await provider.broadcastTransaction(signed)`.
5. **Build + broadcast reveal.** Assemble the reveal spending the commit output
   using the ephemeral reveal key + inscription script/control block; self-sign;
   `broadcastTransaction`.
6. **Fail-closed verify (§5).**
7. **Commit identity.** Only after verification: `migrateToDIDBTCO(asset.did, X)`
   and the CEL append/anchor land exactly as today.

## 5. Fail-closed sat verification

After the reveal is broadcast (and, where the provider supports confirmation
lookup, confirmed), the SDK reads the actual inscription's sat back from the
provider (`getInscriptionById(id).satoshi` / `getSatoshiFromInscription`) and
asserts it equals the derived `X`.

- On mismatch, unconfirmable sat, or missing inscription → throw `SAT_MISMATCH`
  (a `StructuredError`), roll back the in-memory CEL append using
  `inscribeOnBitcoin`'s EXISTING rollback (`celLogBefore` restore), and commit
  nothing. The asset's layer/DID is not advanced.
- This is the load-bearing safety net: even if the funding UTXO's real first sat
  differed from what the provider reported, or the tx did not land as modelled,
  the DID is never silently bound to the wrong sat.

## 6. Backward compatibility

- **Legacy path (no `fundingUtxo`).** `inscribeOnBitcoin(asset)` /
  `inscribeOnBitcoin(asset, feeRate)` continues to delegate to
  `provider.createInscription`, which picks the sat. Kept so OrdMock/dev tests do
  not churn. **DECIDED:** keep this path for mock/dev; document that PRODUCTION
  must use the sat-selected path (QuickNode/OrdHttp already refuse
  `createInscription`, so production genesis has no working legacy path anyway).
- **Reinscription unchanged.** `rotateBtcoKeys` / `authorizeSigner` already pin
  `targetSatoshi` (the asset's existing anchoring sat) and are untouched.

## 7. Relationship to #369

This design **wires `createCommitTransaction`** into a real production path,
which is precisely what #369 flagged as missing (the builder was present but
uninvoked). #369 therefore collapses into: ship this feature, then delete the
genuinely-dead `BitcoinManager.preventFrontRunning` (a naive uninvoked counter),
and correct the whitepaper/spec wording so "front-running protection" describes
the actual guarantee — **first-anchor-wins uniqueness, verified fail-closed at
resolution** (`verifyEventLog` / `getAnchoringsForDidCel`) — rather than the
never-shipped "unique satoshi assignment via commit pointer". No separate #369
effort is needed beyond that cleanup.

## 8. Testing spine

- **Derived-sat drives the DID.** With OrdMock's deterministic
  `getFirstSatOfOutput`, a sat-selected inscribe produces `did:btco:<that sat>`.
- **Commit signed via external signer.** A mock `BitcoinSigner` receives the
  commit PSBT and returns a signed tx; the SDK broadcasts it (assert the signer
  was called with the commit, not the reveal).
- **End-to-end lands on the intended sat.** create → publish → sat-selected
  inscribe → resolve/verify → the asset's anchoring sat == the derived sat.
- **Sat mismatch → fail closed.** A provider whose post-hoc inscription sat
  differs from the derived sat → `SAT_MISMATCH`, in-memory log rolled back,
  layer/DID not advanced, no partial state.
- **Provider without sat index → `SAT_INDEX_UNSUPPORTED`** on the sat-selected
  path (fail closed, nothing broadcast).
- **Missing signer/changeAddress with `fundingUtxo` → `INVALID_INPUT`.**
- **Legacy path preserved.** `inscribeOnBitcoin(asset)` / `(asset, feeRate)` with
  OrdMock behaves exactly as before.
- **Reinscription unchanged.** `rotateBtcoKeys` still pins the same sat.

## 9. Boundaries / deferred

- Named-sat → UTXO resolution (caller says "sat X", SDK finds the containing
  UTXO via sat index) — a convenience layer on top of this primitive.
- Rare-sat pointer-offset targeting (an exact sat at offset N inside a larger
  UTXO) — needs sat-range data + pointer computation.
- Wallet UTXO enumeration / coin selection across many UTXOs — the caller
  supplies the single funding UTXO.
- Payment/fee funding beyond the single provided UTXO (multi-input funding).

## 10. Changeset

`@originals/sdk` **minor** — `inscribeOnBitcoin` can now inscribe the genesis
did:btco onto a caller-chosen funding UTXO whose first sat becomes the DID: the
sat is derived from the provider's sat index, the commit is signed by a caller
`BitcoinSigner`, and the result is verified fail-closed against the intended sat
(`SAT_MISMATCH` rolls back). Callers control the permanent `did:btco:<sat>`
identity instead of accepting an arbitrary provider-selected sat (#369).
