# Upgrading to `@originals/sdk` 3.0

3.0 exists because of one report: the SDK's recommended path could not be used by any custody that never exports a private key — Turnkey, KMS, HSMs, passkeys — and several code paths produced signed artifacts that the SDK's own verifier then rejected, with no error at the point of signing.

Fixing that meant making things fail loudly that previously failed silently. **Most of the breaking changes below will surface as code that used to "work" now throwing.** In every case, that code was producing something broken; the throw is telling you where.

Work through the sections that apply. Each one states what breaks, what to do, and why.

---

## 1. `createAsset` now requires custody

**Breaks:** `createAsset` / `createDraft` throw `NO_CUSTODY`.

Previously, with no `keyStore` and no signer, the SDK generated the asset's controller key and immediately discarded it. The asset minted fine and could never author another event — `publishToWeb` and `inscribeOnBitcoin` would still report success while silently omitting their provenance events. That was the default, and the shape of the documented quickstart.

```ts
// before — worked, produced an asset that could never be published
const sdk = OriginalsSDK.create({ network: 'mainnet' });
const asset = await sdk.lifecycle.createAsset(resources);

// after — pick one
const sdk = OriginalsSDK.create({ network: 'mainnet', keyStore });        // local keys
const sdk = OriginalsSDK.create({ network: 'mainnet', signer });          // remote custody
const asset = await sdk.lifecycle.createAsset(resources, { signer });     // or per call
```

If you genuinely want a throwaway asset that can never author again, say so:

```ts
await sdk.lifecycle.createAsset(resources, { controller: 'ephemeral' });
```

`'ephemeral'` is honoured even when a keyStore is configured — the key is not persisted. Passing both `options.signer` and `controller: 'ephemeral'` throws `CONTRADICTORY_CUSTODY`, because those are opposite instructions and guessing between them is what 3.0 removes.

## 2. Lifecycle operations throw when they cannot sign their provenance event

**Breaks:** `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys` — and the asset-level `update` appends — throw `CEL_APPEND_FAILED`.

An operation has not succeeded if the log is missing the migration it just performed. Previously these emitted `cel:append-skipped` and continued, so you could hold a published asset whose provenance log had a hole in it.

```ts
// restore the old behaviour explicitly, per call or globally
await sdk.lifecycle.publishToWeb(asset, 'example.com', { onAppendFailure: 'skip' });
OriginalsSDK.create({ ..., onAppendFailure: 'skip' });
```

One exception is unchanged: a legacy asset with no CEL log still degrades rather than throwing, because no configuration could give it one.

## 3. Remote custody: use `OriginalsSigner`

**New, and the reason for the release.** One interface, three members:

```ts
interface OriginalsSigner {
  readonly verificationMethodId: string;   // "did:key:z6Mk…#z6Mk…"
  readonly publicKeyMultibase: string;
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;
}
```

The SDK canonicalizes and hashes; your signer only ever signs opaque bytes. Accept it on the config or per call. Adapters convert in both directions — `signerFromKeyPair`, `signerFromKeyStore`, `signerFromExternalSigner`, `toCelSigner`, `toExternalSigner`.

Before shipping an implementation, run the conformance harness:

```ts
import { assertSignerConformance } from '@originals/sdk';
await assertSignerConformance(mySigner);
```

`KeyStore` is now key **persistence**, not a signing authority. It still works for local-key flows.

**Turnkey users:** `@originals/auth`'s signers already sign bytes — they are `ExternalSigner`-shaped (`signBytes` resolves `{ signature }`), so wrap once and pass the result anywhere:

```ts
import { signerFromExternalSigner } from '@originals/sdk';
const signer = signerFromExternalSigner(turnkeySigner);
```

If the signer's verification method is not a `did:key`, pass `{ publicKeyMultibase }` — otherwise it throws `SIGNER_PUBLIC_KEY_REQUIRED`. Turnkey's Ed25519 accounts use `ADDRESS_FORMAT_SOLANA`, whose address is base58 of the raw key with **no multicodec header** — so `did:key:${account.address}` is not a valid did:key. Convert it:

```ts
import { base58AddressToEd25519Multikey } from '@originals/sdk';
const publicKeyMultibase = base58AddressToEd25519Multikey(account.address);
```

## 4. `ExternalSigner` must implement `signBytes`

**Breaks:** `signCredentialWithExternalSigner` throws `EXTERNAL_SIGNER_SIGNBYTES_REQUIRED` for a `sign()`-only signer.

The old path hardcoded `cryptosuite: 'eddsa-rdfc-2022'` and then let the signer choose its own canonicalization. Every didwebvh-shaped signer chooses JCS, so the proof was labelled RDFC and signed over JCS bytes: **no credential signed that way ever verified.** Nothing depended on this working, because it didn't.

It also now throws `ISSUER_BINDING_MISMATCH` if the credential's `issuer` is not controlled by the signing key — matching the local-key path, and matching what the verifier checks.

## 5. The CEL cryptosuite is renamed, and the proof configuration is signed

**Breaks:** anything matching the literal `'eddsa-jcs-2022'`.

New proofs carry `originals-cel-ed25519-jcs-v1`. The old label was never that suite — there was no hashing step and the proof configuration was excluded from the signature, so `created`, `verificationMethod` and `proofPurpose` were editable after signing.

**Logs sealed before 3.0 keep verifying.** `eddsa-jcs-2022` is accepted on read, permanently, and never written again. Use the exported constants rather than string literals:

```ts
import { CEL_CRYPTOSUITE, CEL_CRYPTOSUITE_LEGACY } from '@originals/sdk';
```

If you sign CEL events yourself, the preimage changed — `signingInput.celEvent(entry, proofConfig)` now takes the proof configuration as a second argument. A signer that ignores it fails at seal time rather than silently later.

## 6. Imports: curated subpaths, and test doubles moved

**Breaks:** deep subpath imports.

The `exports` map wildcarded eleven internal directories, making every internal file a permanent API commitment. Supported entry points are now `.`, `./cel`, `./testing`, `./types`.

```ts
// before
import { OrdMockProvider } from '@originals/sdk';
import { multikey } from '@originals/sdk/crypto/Multikey';

// after
import { OrdMockProvider } from '@originals/sdk/testing';
import { multikey } from '@originals/sdk';
```

`retry` and `circuit-breaker` are no longer root exports. If you need something that moved, it is almost certainly on the root — open an issue if not.

## 7. `Buffer` → `Uint8Array`

**Breaks:** anything passing or expecting `Buffer` across the public API — `Signer` and its subclasses, `OrdinalsProvider`, `StorageAdapter`, `OrdinalsInscription.content`, `ResourceManager`, `KeyManager`.

`Buffer` is a Node global; a browser consumer without a shim gets a `ReferenceError`. `Buffer` *is* a `Uint8Array`, so passing one still works — it is reading the return values that changes:

```ts
// before
const hex = sig.toString('hex');

// after, on Node — Buffer still exists, it just isn't handed to you
const hex = Buffer.from(sig).toString('hex');

// after, portable — no dependency, works in a browser
const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
```

Going the other way, the SDK exports `encoding.hexToBytes`.

## 8. `@originals/auth`: the root no longer re-exports server code

**Breaks:** importing server utilities from the package root. The root now carries types plus the isomorphic `turnkeySignBytes`; everything else moved behind `./server` and `./client`.

```ts
// before — pulled jsonwebtoken, @turnkey/sdk-server and Express into browser bundles
import { createAuthMiddleware } from '@originals/auth';

// after
import { createAuthMiddleware } from '@originals/auth/server';
import { initOtp } from '@originals/auth/client';
```

If you were reaching into `@originals/auth` for Turnkey key encoding, see §3 — `base58AddressToEd25519Multikey` lives on `@originals/sdk`.

## 9. New package: `@originals/cel`

The CEL core — create, append, verify event logs — is now its own package with no Bitcoin stack, no `jsonld`, and no Node builtins. If you only create and verify logs, depend on it directly and skip the rest.

**No existing import breaks.** `@originals/sdk/cel` re-exports the *entire* `@originals/cel` surface — that subpath and the standalone package are now interchangeable. The `@originals/sdk` root carries most of it but not all: eleven symbols (`appendEvent`, `committedFields`, `canonicalizeEntryForChain`, `cbor`, `btcoDidFromSatoshi`, …) live only on `./cel`. If a CEL import fails from the root, take it from `@originals/sdk/cel`.

---

## Recommended upgrade order

1. Configure custody (§1) — everything else depends on it.
2. Run your test suite and fix the throws. Each one marks a place that was previously failing silently.
3. Fix imports (§6, §8) — the compiler finds these for you.
4. Only then look at `Buffer` (§7); most call sites need no change.

If something that used to work now throws and the message doesn't make the fix obvious, that's a bug in the message — please open an issue with it.
