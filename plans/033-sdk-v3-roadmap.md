# Plan 033: SDK v3 roadmap — signer abstraction, fail-loud, packaging

> **Status**: roadmap. Spawns plans 034–045 (one per work item below). Read this
> before any of them; it carries the design decisions the individual plans assume.
>
> **Planned at**: commit `b63b1f4`, 2026-07-31, in response to first-implementer
> feedback from the `boop` team (first serious remote-custody consumer).

## Status

- **Priority**: P0 (the SDK's recommended path is unusable for remote custody)
- **Effort**: XL (spans 2.1 → 3.0)
- **Risk**: HIGH (breaking API + a cryptosuite relabel)
- **Category**: architecture / correctness / DX

---

## Verification of the feedback

Every claim below was checked against `packages/sdk/src` at `b63b1f4`. All of the
substantive ones are **confirmed**. Notes where reality differs.

| Claim | Verdict | Evidence |
|---|---|---|
| `KeyStore` is export-key-only, so non-exportable custody can't use the recommended tier | CONFIRMED | `types/common.ts:108-111` — `getPrivateKey(vmId): Promise<string \| null>` |
| `createAsset` generates the controller key itself; drops it with no keyStore | CONFIRMED | `lifecycle/LifecycleManager.ts:340` generates, `:366-379` drops + emits `key:unpersisted`. `createAsset(resources)` takes **no options at all** (`:293`) — there is no way to supply custody |
| README quickstart configures no keyStore | CONFIRMED | `packages/sdk/README.md:28-34` |
| Five signer-shaped types, no sign-bytes adapter | CONFIRMED | `KeyStore`, `ExternalSigner`, `BitcoinSigner` (`types/common.ts`), `CelSigner` (`cel/layers/PeerCelManager.ts:75`), `Signer`/`Ed25519Signer` (`crypto/Signer.ts:4,104`), plus `did/WebVHManager.ts:107`. Only adapters are `celSignerFromKeyPair` / `createKeyStoreCelSigner` — both raw-key-inward |
| `signCredentialWithExternalSigner` hardcodes `eddsa-rdfc-2022` but delegates canonicalization | CONFIRMED | `vc/CredentialManager.ts:293` (`// Or derive from signer type`), `:304-307` calls `signer.sign({document, proof})`. Verified by `Verifier` over RDFC → JCS signers produce 0% verifiable credentials, no error at sign time |
| The correct machinery exists and is used in exactly one place | CONFIRMED | `vc/MultiSigManager.ts:666-700` — requires `signBytes`, uses `EdDSACryptosuiteManager.computeSigningInput`, and its own comment describes precisely the bug `signCredentialWithExternalSigner` still has |
| `createEventLog` never verifies the proof it seals | CONFIRMED | `cel/algorithms/createEventLog.ts:49-52` — presence check only. Same in `appendEvent.ts:61-64` |
| CEL structural check admits a suite `dispatchVerify` fails closed | CONFIRMED | `verifyEventLog.ts:74` whitelists `eddsa-rdfc-2022`; `:169-171` rejects everything but `eddsa-jcs-2022` |
| `CredentialManager` without a `DIDManager` silently fails DI proofs | CONFIRMED | constructor `didManager?` (`:171`); `verifyCredential` falls to the legacy digest path (`:351+`) which no DI proof can satisfy → returns `false`. `OriginalsSDK` always passes one (`core/OriginalsSDK.ts:213`), so this only bites direct constructors |
| CEL's `eddsa-jcs-2022` is not the W3C construction | CONFIRMED | `cel/signerAdapter.ts:27-37` signs `canonicalizeEvent(data)` — no hashing step, proof config excluded (`cel/canonicalize.ts:66-101` documents the exclusion as deliberate) |
| Export-surface asymmetries | CONFIRMED | `index.ts:212` exports `witnessSigningBytes` but not `canonicalizeEvent`; `:262-266` exports `celSignerFromKeyPair`/`createKeyStoreCelSigner` but not `currentControllerVm`. No `EdDSACryptosuiteManager`, `createDocumentLoader`, or `Verifier`. Test mocks (`OrdMockProvider`, `FeeOracleMock`) and generic infra (`retry`, `circuit-breaker`) **are** exported |
| No `sideEffects`, despite a deliberate side-effect import | CONFIRMED | `index.ts:3` `import './crypto/noble-init.js'`; `package.json` has no `sideEffects` key |
| `exports` map wildcards internals, omits `adapters`/`events`/`kinds` | CONFIRMED | `package.json` — 11 `/*` wildcards; `verify/` also missing |
| `Buffer` in public signatures | CONFIRMED (worse than reported) | 51 dist files, not 32. Root-exported `crypto/Signer.ts` is the worst offender: `sign(data: Buffer, …): Promise<Buffer>` on all four signer classes |
| `@originals/auth` root drags server deps into browser bundles | CONFIRMED | `packages/auth/src/index.ts:27` `export * from './server/index.js'` → `jsonwebtoken`, `@turnkey/sdk-server`, `express` types |
| Turnkey `signBytes` is a small extraction | CONFIRMED | `auth/src/server/turnkey-signer.ts:75-114` is already byte-level: hex-encode, `HASH_FUNCTION_NO_OP`, r‖s, 64-byte check. Only `:68` (canonicalize) and `:117` (multibase-encode) sit outside it |

### One finding the feedback didn't name, and it's the biggest

`publishToWeb(asset, publisherDidOrSigner, …)` **does** accept an `ExternalSigner`
(`LifecycleManager.ts:1470`) — but that signer only authorizes the did:webvh log
(`:1533`). The asset's own CEL `migrate` event is appended by
`appendCelEventOrSkip` (`:2278-2305`), which is **keyStore-only**: no keyStore, no
key → emit `cel:append-skipped` and continue. So a remote-custody caller who does
everything right gets a published did:webvh asset whose provenance log is *missing
the migration event*, and the operation reports success.

That is the SDK's worst failure mode: silent provenance loss on the documented
happy path. It is the concrete reason a Turnkey consumer must route around all
three headline abstractions.

### Corrections to the feedback

- The `did:peer` references are not merely stale wording — the protocol moved to
  `did:cel` (see `CLAUDE.md`), so the docs described a creation layer the SDK no
  longer mints. Narrowed while executing 038: the ROOT `README.md` was already
  current, and the `did:peer` mentions in `docs/LLM_AGENT_GUIDE.md` and
  `docs/API_REFERENCE.md` are deliberate legacy-read-path notes. The rot was
  confined to `packages/sdk/README.md` — i.e. **the published package README, the
  one npm consumers actually read**, which is the worse place for it.
- `Verifier`'s issuer↔VM binding (`vc/Verifier.ts:123-136`, `:215`) is correct and
  deliberate; the boop-side breakage is a consumer bug, not an SDK one. But the SDK
  offers no helper to bind an external key into a did:webvh document, which is what
  makes consumers get it wrong.

---

## The design

### One root signer interface

```ts
// src/crypto/OriginalsSigner.ts — new, root-exported
export interface OriginalsSigner {
  /** Absolute verification method id, e.g. "did:key:z6Mk…#z6Mk…". */
  readonly verificationMethodId: string;
  /** Multikey-encoded public key — lets the SDK pick the suite and self-verify offline. */
  readonly publicKeyMultibase: string;
  /** Sign exactly these bytes. The SDK owns canonicalization; the signer owns the key. */
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;
}
```

Three members, no algorithm field — the algorithm is decoded from
`publicKeyMultibase` via the existing `multikey` codec. This is the smallest thing
a Turnkey/KMS/HSM/passkey backend can implement, and it is a ~10-line wrapper over
what `auth/src/server/turnkey-signer.ts` already does.

**The invariant**: the SDK canonicalizes and hashes; the signer only ever signs
opaque bytes. Delegating canonicalization to the signer was the layering mistake —
`ExternalSigner.signBytes?`'s own docstring (`types/common.ts:126-140`) already
says so.

### One signing-input namespace

```ts
// src/crypto/signingInput.ts — new, root-exported as `signingInput`
signingInput.celEvent(entry)                                  // JCS over {type,data,previousEvent?}
signingInput.witness(digestMultibase)                         // existing witnessSigningBytes
signingInput.didWebvh(document, proof)                        // JCS over {document, proof}
signingInput.credential(document, proofConfig, {documentLoader}) // RDFC-2022 hashData
```

There are exactly four signing preimages in the SDK today and they are scattered
across four modules with one of them exported. Consolidating them is what makes
"which bytes do I sign?" answerable, and routing **every** internal signing path
through this namespace is what stops the four from drifting again. `witnessSigningBytes`'
docstring ("produces a proof that fails verification with no hint why") is the
argument for all four.

### Adapters, both directions

```ts
signerFromKeyPair(keyPair): OriginalsSigner
signerFromKeyStore(keyStore, vmId): OriginalsSigner   // lazy per-sign lookup, as today
signerFromExternalSigner(s): OriginalsSigner          // throws if s.signBytes is absent
toCelSigner(s: OriginalsSigner): CelSigner            // legacy bridge
toExternalSigner(s: OriginalsSigner): ExternalSigner  // correct-by-construction: sign() = signingInput.didWebvh + signBytes
```

`KeyStore` survives as a **key-persistence** interface. It stops being a signing
authority.

### Custody is a first-class argument

```ts
OriginalsSDK.create({ signer })                        // default authorship signer
sdk.lifecycle.createAsset(resources, { signer })       // per-call override
sdk.lifecycle.publishToWeb(asset, publisher, { signer })
```

`createAsset` with a signer does not generate a key and never emits
`key:unpersisted`. `createAsset` with neither a signer nor a keyStore throws
`NO_CUSTODY` — unless the caller explicitly opts into
`{ controller: 'ephemeral' }`, which is honest about minting a write-once asset.

### Degradation becomes opt-in, not default

`appendCelEventOrSkip`'s skip contract becomes `onAppendFailure: 'throw' | 'skip'`,
defaulting to `'throw'` in 3.0. A lifecycle operation that cannot write its own
provenance event has failed, and should say so.

---

## Work items

### Phase 0 — stop the bleeding (2.1, additive, no API break)

**Status: DONE** (2026-08-13). tsc 0; 3795 tests pass / 0 fail across unit,
integration, security and stress; `verify:browser` and `verify:esm` gates green.

| # | Item | Effort |
|---|---|---|
| 034 | ✅ **CEL self-verify at seal time.** `createEventLog`/`appendEvent` verify the proof they just produced before returning; default on, `{ verifyOnSign: false }` escape hatch. For `did:key` + `eddsa-jcs-2022` the key is in the VM, so it is free and offline. Turns "seals a genesis that can never verify" into a throw at the call site. | S |
| 035 | ✅ **Align the CEL suite whitelist with the dispatcher.** Drop `eddsa-rdfc-2022` from `structuralCheck` (`verifyEventLog.ts:74`), or return a typed `UNSUPPORTED_CRYPTOSUITE` reason. A suite the validator admits must be verifiable. | S |
| 036 | ✅ **Fix `signCredentialWithExternalSigner`.** Route through `EdDSACryptosuiteManager.computeSigningInput` + `signer.signBytes`, exactly as `MultiSigManager.signWithExternalSigner` already does; throw the same loud error for `sign()`-only signers. Delete the `// Or derive from signer type` comment by actually deriving it. | S |
| 037 | ✅ **Make `CredentialManager`'s `didManager` required**, and have DI-proof verification without a resolver throw `VERIFIER_UNAVAILABLE` rather than return `false`. | S |
| 038 | ✅ **De-rot the docs.** `packages/sdk/README.md`: `did:peer` → `did:cel`; a new **Custody** section makes `keyStore` step zero and names both degrade signals (`key:unpersisted`, `cel:append-skipped`); the Turnkey/KMS/HSM claim is narrowed to what is now true — credentials yes (036), authorship not yet — with a pointer here. | S |


**What Phase 0 turned up that the plan didn't predict:** the CEL test suite was
built almost entirely on signers returning structurally-valid but
cryptographically garbage proofs (~200 call sites across 14 files). Turning on
seal-time verification failed 273 tests — the suite had encoded the bug as
normal, which is exactly why it shipped. The same was true of
`CredentialManager.externalSigner.test.ts`, whose "succeeds" case asserted that
`'zFakeValidProofValue'` was an acceptable proof. All of these now sign for real
via `tests/fixtures/celSigner.ts`; `verifyOnSign: false` is reserved for the two
places that deliberately build legacy/invalid fixtures. Twelve test files were
also failing to LOAD (silently reducing the suite) — fixed, which is why the
count rose from 3587 to 3795.

Phase 0 converts the four worst silent failures into loud ones.
Ship as 2.1 before starting phase 1.

### Phase 1 — the signer core (2.2, additive)

| # | Item | Effort |
|---|---|---|
| 039 | `OriginalsSigner` + `signingInput` namespace + the five adapters. Every internal signing path routed through them (`celSignerFromKeyPair`, `createKeyStoreCelSigner`, `WebVHManager`, `Issuer`, `MultiSigManager`, `witnessEvent`). `signer` accepted on `OriginalsConfig` and on `createAsset`/`publishToWeb`/`inscribeOnBitcoin`/`rotateBtcoKeys`/`authorizeSigner`/`addResourceVersion`. `ExternalSigner`/`CelSigner`/`KeyStore`-as-signer marked `@deprecated`. | L |
| 040 | **`assertSignerConformance(signer)` + `MockRemoteSigner`.** A published conformance harness any custody backend can run, plus an in-repo signer that implements **only** `signBytes` — no key export, no `sign()`. Rule: every documented end-to-end flow gets a test that runs it under `MockRemoteSigner`. | M |

**040 is the durable fix.** The reason this class of bug shipped is that no test in
76k lines of test code exercises a non-exporting custody backend, so every
remote-custody path could rot undetected. The interface redesign fixes today's bug;
the conformance harness is what stops the next one.

### Phase 2 — 3.0, defaults flip

| # | Item | Effort |
|---|---|---|
| 041 | Remove `ExternalSigner`/`CelSigner` from public API (adapters remain). `createAsset` requires custody. `onAppendFailure` defaults to `'throw'`. `KeyStore` documented as persistence-only. | M |
| 042 | **CEL cryptosuite: rename *and* bind the proof configuration**, in one breaking change. Emit a bespoke id (`originals-cel-ed25519-jcs-v1`); the verifier dispatches on the label and keeps a legacy read path for `eddsa-jcs-2022` logs forever. Two notes that make this cheaper than it looks: (a) because the proof config is currently excluded from the preimage, relabelling alone does not invalidate a single existing signature; (b) binding the config closes a real gap — `created` and `proofPurpose` are presently unattested. Do both at once or pay the migration twice. | M |

### Phase 3 — packaging (3.0)

| # | Item | Effort |
|---|---|---|
| 043 | Remove the side-effect import from `index.ts` (make `noble-init` explicit at point of use), set `"sideEffects": false`. Replace the 11 `/*` wildcards with a curated subpath list; add the missing `verify`, and move `OrdMockProvider`/`FeeOracleMock` to `@originals/sdk/testing`; drop `retry`/`circuit-breaker` from root. Add the missing remote-signer toolkit to root: `signingInput`, `canonicalizeEvent`, `currentControllerVm`, `createDocumentLoader`, `Verifier`, `EdDSACryptosuiteManager`. | M |
| 044 | **Purge `Buffer` from public signatures** → `Uint8Array` (51 dist files; `crypto/Signer.ts` first, it's root-exported). Then split `@originals/cel` — zero Bitcoin, zero `jsonld`, browser-safe. The `/cel` entry and `scripts/check-browser-safety.mjs` gate already exist, so the seam is half-built. | L |

### Phase 4 — `@originals/auth`

| # | Item | Effort |
|---|---|---|
| 045 | Root exports types only (`export * from './types.js'`) — server stays behind `/server`. Extract one `turnkeySignBytes()` primitive; both Turnkey signers become thin `OriginalsSigner` wrappers over it, deleting the "kept in sync by comment" duplication. Move `turnkeyAddressToMultikey` upstream into the SDK (Turnkey Ed25519 accounts are `ADDRESS_FORMAT_SOLANA`, so the address is base58 of the raw key — **not** a Multikey, and consumers keep re-deriving this wrong). | M |

---

## Sequencing and compatibility

- **2.1** = phase 0. No API change; four silent failures become throws. Some
  consumers' currently-"working" code will start failing — that is the point, and
  the release notes must say so plainly.
- **2.2** = phase 1. Purely additive; the old paths still work with deprecation
  warnings. Publish a migration guide here, not at 3.0.
- **3.0** = phases 2–4. One breaking release, one migration.

## Done criteria for the roadmap

1. A consumer holding only a `signBytes` capability can run the entire documented
   flow — create → publish → inscribe → rotate — with no deep subpath imports and
   no locally reinvented canonicalization.
2. `assertSignerConformance(MockRemoteSigner)` is green, and every documented flow
   has a test that runs under it.
3. No SDK path can emit a signed artifact that the SDK's own verifier rejects
   (enforced by 034's self-verify and 036/039's shared preimages).
4. `bun run verify:browser` passes for `@originals/cel` with no Bitcoin, `jsonld`,
   or `Buffer` in the graph.

## STOP conditions

- **Do not start 042 (cryptosuite rename) before 034 ships.** Self-verify at seal
  time is what will catch a mistake in the rename; without it the rename can
  silently mint unverifiable genesis events at scale.
- **Do not start phase 3 packaging before 039 lands.** The curated export list is
  determined by what the signer toolkit needs; curating first means curating twice.
- If 039 exceeds ~2 weeks, ship the `signingInput` namespace and adapters alone
  (they are independently valuable and unblock consumers today) and split the
  config/lifecycle threading into its own plan.
