# Plan 031: Fix server `TurnkeyWebVHSigner` corrupting signature on r+s hex concat

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Make the minimal correct change plus a regression test that
> fails before the fix and passes after.

## Status

- **Priority**: P0 (critical correctness)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: origin/main commit `8881c1d`, 2026-06-23

## Why this matters

`packages/auth/src/server/turnkey-signer.ts` (`TurnkeyWebVHSigner.sign`)
builds the Ed25519 signature by concatenating the Turnkey `r` and `s` hex
strings first, then strips a single leading `0x` from the concatenation:

```typescript
const signature = signRawResult.r + signRawResult.s;
const cleanSig = signature.startsWith('0x') ? signature.slice(2) : signature;
const signatureBytes = Buffer.from(cleanSig, 'hex');
```

Turnkey's `signRawPayload` API may return `r` and `s` with or without a `0x`
prefix depending on the response format. When **both** `r` and `s` carry a
`0x` prefix (e.g. `r = '0xaaaa...'`, `s = '0xbbbb...'`), the concatenation
produces `'0xaaaa...0xbbbb...'`. Stripping only the single leading `0x`
leaves an embedded `'0x'` in the middle of the string:
`'aaaa...0xbbbb...'`.

`Buffer.from(cleanSig, 'hex')` then stops/garbles at the non-hex `x`,
producing wrong bytes. This corrupts the proofValue for every server-signed
did:webvh update, breaking the hash chain and causing all such DID updates to
fail later verification.

The client signer (`packages/auth/src/client/turnkey-did-signer.ts`) already
does this correctly: it strips `0x` from each of `r` and `s` **separately**
before concatenating. The server signer must match that behaviour.

## The fix

In `packages/auth/src/server/turnkey-signer.ts`, strip the `0x` prefix from
`r` and `s` independently before concatenating, mirroring the client signer:

```typescript
const r = signRawResult.r;
const s = signRawResult.s;
const cleanR = r.startsWith('0x') ? r.slice(2) : r;
const cleanS = s.startsWith('0x') ? s.slice(2) : s;
const cleanSig = cleanR + cleanS;
const signatureBytes = Buffer.from(cleanSig, 'hex');
```

The existing 64-byte length guard remains unchanged and now also defends
against any malformed concatenation.

## Regression test

Add a test to `packages/auth/tests/turnkey-signer.test.ts` that mocks Turnkey
returning `r` and `s` **both prefixed with `0x`**, signs, decodes the
resulting multibase proofValue, and asserts the 64 signature bytes equal the
expected `r`/`s` bytes. This fails before the fix (embedded `0x` corrupts the
bytes / produces wrong length) and passes after.

## Verification

```bash
cd /Users/brian/Projects/onionoriginals/sdk
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```
