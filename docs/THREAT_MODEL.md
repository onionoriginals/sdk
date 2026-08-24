# Originals SDK — Security Audit & Threat Model

**Last re-audited:** 2026-08-24, against `@originals/sdk` 3.0.0-next.1.
**Previous audit:** 2026-03-06 against v1.9.0.
**Scope:** crypto operations, key handling, input validation, Bitcoin transactions.
**Overall Risk:** MEDIUM — solid fundamentals; the open items below are the honest remainder.

> **Every status in this document was re-checked against the code at the date
> above, not carried forward.** Rows that had drifted are corrected below, and
> one finding (the old T13/F11, "EdDSA proof hash collision via missing domain
> separation", carried as an open **High**) was a **false positive** and has been
> withdrawn — see "Withdrawn findings" for the reasoning, which is recorded
> rather than deleted so nobody re-files it.
>
> A public threat model carrying a stale open High is worse than no threat
> model: it misdirects a reader's attention and misrepresents the code. If you
> change security-relevant code, update the row here in the same change.

---

## Threat Model

### Attack Surface Overview

```
External Input          SDK Boundary              Internal Operations
─────────────────────   ──────────────────────    ────────────────────────
User resources    ───→  Validation layer     ───→  DID creation (did:cel genesis)
DID strings       ───→  DID parsing          ───→  WebVH publication
Bitcoin addresses ───→  Address validation   ───→  Bitcoin inscription
Fee rates         ───→  Bounds checking      ───→  Transaction construction
UTXO sets         ───→  Selection/filtering  ───→  Commit-reveal signing
External signers  ───→  Interface contract   ───→  Credential issuance
```

### Threat Categories

| # | Threat | Component | Severity | Status |
|---|--------|-----------|----------|--------|
| T1 | Malformed Bitcoin address causes fund loss | `commit.ts`, `transfer.ts` | High | **Mitigated (2026-08)** — `validateBitcoinAddress()` now runs at both entry points (`transfer.ts:98,102`, `commit.ts:219`) |
| T2 | Fee rate manipulation drains wallet | `BitcoinManager`, `fee-calculation.ts` | High | Mitigated — max fee rate enforced in BitcoinManager |
| T3 | UTXO double-spend via concurrent selection | `utxo-selection.ts` | High | Known limitation — wallet-level locking required |
| T4 | Private key leakage via logging/errors | `Signer.ts`, `commit.ts`, `eddsa.ts` | Medium | Mitigated — no keys in logs/errors currently |
| T5 | Reveal-tx front-running (mempool precomputes reveal address) | `commit.ts` | Medium | Mitigated — random keypair per reveal tx. Protocol-level did:cel sat uniqueness is a separate mechanism: first-anchor-wins, verified fail-closed in `verifyEventLog` |
| T6 | Spending inscription-bearing UTXOs | `utxo-selection.ts` | High | Mitigated — `hasResource` flag filtering |
| T7 | Integer overflow in satoshi math | `satoshi-validation.ts` | Medium | Mitigated — BigInt used, max supply enforced |
| T8 | DID document injection | `DIDManager`, `validation.ts` | Low | Partially mitigated — see F5 |
| T9 | Memory storage in production | `MemoryStorageAdapter.ts` | Low | Dev-only adapter, no production guard |
| T10 | Dust output creation | `commit.ts`, `utxo-selection.ts` | Medium | Mitigated — dust added to fee, 546 sat minimum |
| T11 | SSRF via malicious inscription URL | `BtcoDidResolver.ts` | Medium | **Partially mitigated (2026-08)** — see F9 |
| T12 | Silent multi-proof bypass | `Verifier.ts` | Low | **Open (re-confirmed 2026-08)** — see F10 |
| ~~T13~~ | ~~EdDSA proof hash collision via missing domain separation~~ | `eddsa.ts` | — | **Withdrawn (2026-08): false positive.** See "Withdrawn findings" |
| ~~T14~~ | ~~Incorrect multibase encoding in Ed25519Verifier~~ | `Ed25519Verifier.ts` | — | **Fixed (2026-08)** — uses `multikey.encodePublicKey()`, plus a 32-byte length guard |
| ~~T15~~ | ~~Malicious external signer injecting invalid proofs~~ | `WebVHManager.ts` | — | **Fixed (2026-08)** — an `externalVerifier` is REQUIRED when the signer has no `verify()` (`WebVHManager.ts:404-413`) |
| T16 | Silent signature corruption via format fallback | `Signer.ts` | Medium | **Open (re-confirmed 2026-08)** — see F14 |
| T17 | Provider MiTM via HTTP (no HTTPS enforcement) | `OrdHttpProvider.ts` | High | **Partially mitigated (2026-08)** — see F15 |
| T18 | No inscription data size limit | `BitcoinManager.ts` | Medium | **Open (re-confirmed 2026-08)** — see F16 |
| T19 | Provider retry storm (no backoff/circuit breaker) | `OrdinalsProvider.ts` | Medium | **Largely mitigated (2026-08)** — see F17 |

---

## Findings

### High Priority

**F1 — Missing address validation in transfer/commit paths — RESOLVED (2026-08)**
- **Files:** `src/bitcoin/transfer.ts`, `src/bitcoin/transactions/commit.ts`
- **Was:** Change and recipient addresses were checked for presence but not format.
- **Now:** `validateBitcoinAddress(address, network)` runs at both entry points
  (`transfer.ts:98` recipient, `transfer.ts:102` change, `commit.ts:219`
  destination), network-aware, with `signet`/`regtest` mapped explicitly.

**F2 — No maximum transaction input limit**
- **File:** `src/bitcoin/utxo-selection.ts`
- **Issue:** `selectUtxos()` has optional `maxNumUtxos` but no default upper bound.
- **Impact:** Could construct transactions with hundreds of inputs, hitting node relay limits or causing excessive fees.
- **Recommendation:** Default `maxInputs` to 100.

**F3 — Concurrent UTXO selection race condition**
- **File:** `src/bitcoin/utxo-selection.ts`
- **Issue:** No locking mechanism — concurrent calls can select overlapping UTXOs.
- **Impact:** Double-spend attempts (rejected by network but wastes fees on commit tx).
- **Status:** Documented in security tests (`bitcoin-penetration-tests.test.ts:443-468`). This is a wallet-level concern, not SDK-level.
- **Recommendation:** Document that integrators must implement UTXO locking at the wallet layer.

### Medium Priority

**F4 — Private key string conversions**
- **Files:** `src/vc/cryptosuites/eddsa.ts:91`, `src/bitcoin/transactions/commit.ts:457`
- **Issue:** Private keys converted to hex strings during signing and returned in `CommitTransactionResult`.
- **Impact:** Multiple representations of key material in memory increases exposure window.
- **Recommendation:** Minimize string conversions; keep keys as `Uint8Array`. Document secure handling of `CommitTransactionResult.revealPrivateKey`.

**F5 — DID document validation not called in creation paths**
- **File:** `src/utils/validation.ts:78-115`
- **Issue:** `validateDIDDocument()` exists but isn't invoked during `createDIDWebVH()` or the did:cel genesis (`createAsset`) path.
- **Impact:** Malformed DID documents could be created in edge cases.
- **Recommendation:** Call `validateDIDDocument()` in DID creation methods.

**F6 — Fee calculation accepts unbounded rates**
- **File:** `src/bitcoin/fee-calculation.ts:19-36`
- **Issue:** `calculateFee()` doesn't validate the `feeRate` parameter. Protection exists in `BitcoinManager` (max 10,000 sat/vB) but not in the utility function.
- **Recommendation:** Add bounds checking in `calculateFee()` for defense-in-depth.

**F9 — SSRF via unvalidated inscription content URL — PARTIALLY MITIGATED (2026-08)**
- **Files:** `src/did/BtcoDidResolver.ts:150`, `src/adapters/providers/OrdHttpProvider.ts:42-53`
- **Mitigated:** `OrdHttpProvider.assertSameOrigin()` rejects any `content_url`
  whose origin differs from the configured `baseUrl`, which closes the
  attacker-controlled-destination vector (`http://169.254.169.254/…`,
  `file:///…`) for the shipped HTTP provider. The fetch also carries a 10s
  timeout covering the body read.
- **Still open:** the guard lives in the provider, not in the resolver.
  `BtcoDidResolver` fetches whatever `content_url` its provider hands it, so a
  custom `OrdinalsProvider` reintroduces the vector. And **the response body is
  unbounded** — `await response.text()` has no size cap, so a hostile or broken
  content host can drive a resolver into memory exhaustion. The timeout does not
  bound a fast, large response.
- **Recommendation:** move a scheme/private-IP check into the resolver so it does
  not depend on provider behaviour, and cap the read (stream with a byte budget,
  or reject on `content-length` above a limit).

**F10 — Silent multi-proof bypass in credential verification**
- **File:** `src/vc/Verifier.ts:21,45`
- **Issue:** When a credential has multiple proofs, only the first is verified: `Array.isArray(proofValue) ? proofValue[0] : proofValue`. Additional proofs are silently ignored.
- **Impact:** Low — an attacker cannot exploit this to bypass verification, but valid additional proofs go unverified.
- **Status (2026-08):** re-confirmed open. Still `proofValue[0]` at
  `Verifier.ts:121` (credentials) and `Verifier.ts:613` (presentations).
- **Recommendation:** Document single-proof-only behavior or implement multi-proof verification.

**F12 — Incorrect multibase encoding in Ed25519Verifier — RESOLVED (2026-08)**
- **File:** `src/did/Ed25519Verifier.ts:63-73`
- **Was:** base64 behind a `z` prefix, which per multibase means base58-btc.
- **Now:** `multikey.encodePublicKey(this.publicKey, 'Ed25519')`, with an explicit
  32-byte length guard that throws rather than silently slicing a wrong-length key
  into a well-formed-looking but wrong multikey (issue #352).

**F13 — External signer proofValue not validated after signing — RESOLVED (2026-08)**
- **File:** `src/did/WebVHManager.ts:404-413`
- **Was:** an external signer's `proofValue` was stored without ever being checked.
- **Now:** the signer is only accepted as a verifier if it actually implements
  `verify()`; otherwise an `externalVerifier` is **required** and its absence
  throws at construction. Silently casting a signer to a verifier is no longer
  possible.

**F14 — Signature format detection with silent fallback**
- **File:** `src/crypto/Signer.ts:40-50`
- **Issue:** When noble crypto returns an unrecognized signature format, the code falls back to `new Uint8Array(sigAny)` which could produce a corrupted signature without error.
- **Impact:** If noble changes its return type, signatures could silently become invalid rather than throwing.
- **Status (2026-08):** re-confirmed open. `Signer.ts:65-71` still ends its
  format ladder in `new Uint8Array(sigAny)`.
- **Recommendation:** Throw an explicit error if the signature format is unrecognized instead of silent conversion.

**F15 — Provider MiTM via HTTP (no HTTPS enforcement)**
- **File:** `src/adapters/providers/OrdHttpProvider.ts:13-21`
- **Issue:** `OrdHttpProvider` fetches from `baseUrl` using `globalThis.fetch()` without enforcing HTTPS. Provider responses (inscription data, satoshi info) are trusted without independent verification.
- **Impact:** A network attacker could intercept HTTP provider responses to return false inscription ownership, potentially enabling theft during transfers.
- **Status (2026-08):** partially mitigated. `assertSameOrigin()` now pins every
  candidate URL to `baseUrl`'s origin, so a compromised response cannot redirect
  the client elsewhere. **`baseUrl` itself is still not required to be
  `https://`**, so a plaintext-configured provider remains interceptable.
- **Recommendation:** reject a non-`https:` `baseUrl` at construction (with an
  explicit escape for localhost/regtest development).

**F16 — No inscription data size limit**
- **File:** `src/bitcoin/BitcoinManager.ts:99-107`
- **Issue:** `inscribeData()` accepts any data with only a non-null check. No size limit is enforced before serialization.
- **Impact:** DoS via resource exhaustion — caller could attempt to inscribe gigabytes, consuming memory before the provider rejects it.
- **Status (2026-08):** re-confirmed open. `BitcoinManager` bounds the fee rate
  (`MAX_REASONABLE_FEE_RATE`) but nothing bounds the payload. Note the separate
  10MB-per-resource cap does apply on the `LifecycleManager` path; `inscribeData()`
  called directly has no cap.
- **Recommendation:** Add configurable max inscription size (e.g., 4MB default).

**F17 — Provider retry storm (no backoff or circuit breaker)**
- **File:** `src/bitcoin/providers/OrdinalsProvider.ts:14-55`
- **Issue:** All provider calls use `withRetry()` with `isRetriable: () => true`, meaning any error triggers retries.
- **Status (2026-08):** the backoff half of this is **wrong and is corrected
  here**: `src/utils/retry.ts` does exponential backoff (base 300ms, factor 2,
  10s ceiling) with ±10% jitter, and caps at 2–3 attempts. There is no retry
  storm. What remains true is narrower: `isRetriable: () => true` still retries
  **permanent** errors (a 404 is retried like a timeout), and there is no
  circuit breaker.
- **Impact (revised):** wasted latency and a few redundant calls on permanent
  errors. Not a DoS vector against provider infrastructure.
- **Recommendation:** distinguish retriable (network/5xx) from permanent (4xx)
  errors. A circuit breaker is optional at these retry counts.

### Low Priority

**F7 — TypeScript `any` in crypto layer**
- **File:** `src/crypto/Signer.ts:40, 106, 164`
- **Issue:** `@typescript-eslint/no-explicit-any` overrides bypass type safety on noble crypto returns.
- **Recommendation:** Create typed wrappers for noble crypto methods.

**F8 — MemoryStorageAdapter production guard**
- **File:** `src/storage/MemoryStorageAdapter.ts`
- **Issue:** No warning when used outside test/dev context.
- **Recommendation:** Log a warning if `network === 'mainnet'` and storage is `MemoryStorageAdapter`.

---

## Withdrawn findings

Recorded rather than deleted, so the same analysis is not re-filed.

### T13 / F11 — "EdDSA proof hash collision via missing domain separation" (was High)

**Withdrawn 2026-08-24: false positive.**

The finding claimed that concatenating `proofConfigHash` and `documentHash`
without a domain separator or length prefix admits a collision, because
different `(proofConfig, document)` pairs might produce the same 64-byte
preimage.

That reasoning applies to concatenating **variable-length** values, where
`a‖b` is genuinely ambiguous. It does not apply here. The current preimage is
built in `src/crypto/signingInput.ts` (`signingInput.credential`):

```
sha256(RDFC(proofConfig)) ‖ sha256(RDFC(document))
```

Both halves are SHA-256 outputs, so both are **exactly 32 bytes**. The 64-byte
result therefore has exactly one parse — split at offset 32 — and no
`(proofConfig, document)` pair can be reinterpreted as another. Producing a
collision would require colliding SHA-256 itself on one half, which is the
hash function's own security assumption, not a framing weakness. A domain
separator would add nothing.

This is also precisely what the W3C `eddsa-rdfc-2022` cryptosuite specifies for
its hashing step (proof-configuration hash first, transformed-document hash
second), so changing it would break interoperability while improving nothing.

Verified against `src/crypto/signingInput.ts` and
`src/vc/cryptosuites/eddsa.ts` (the sign and verify paths call the same helper,
so the two sides cannot drift).

**Do not re-open without a concrete collision argument that survives the
fixed-length observation above.**

---

## Security Strengths

The SDK demonstrates strong security practices in several areas:

- **Multibase key encoding** — All keys use multibase+multicodec, preventing JWK confusion attacks
- **Key length validation** — Strict byte-length checks per algorithm (Ed25519: 32, secp256k1: 32/33, P256: 32/33)
- **Cryptographically secure RNG** — Uses `noble/curves` `randomPrivateKey()` for all key generation
- **Bitcoin address validation** — Full format + checksum validation via `bitcoinjs-lib`, network-aware
- **Satoshi number validation** — Comprehensive: regex, range (0 to 2.1 quadrillion), type checks
- **Fee rate bounds** — Max 10,000 sat/vB in BitcoinManager prevents accidental fund drain
- **Dust limit handling** — Sub-546-sat change added to fee instead of creating dust outputs
- **Reveal-tx front-running protection** — Random reveal keypair per inscription
- **did:cel sat uniqueness** — First-anchor-wins, verified fail-closed at resolution in `verifyEventLog` via the provider's `getAnchoringsForDidCel` (`UNIQUENESS_UNVERIFIABLE` when the provider can't confirm). There is no "unique satoshi assignment" front-running mechanism — that was never wired and was removed (`preventFrontRunning` deleted, #369); commit/reveal is transaction construction, not front-running protection
- **Ownership IS live Bitcoin sat control** — `did:btco:<sat>` makes the satoshi both identity and ownership, read live via `getCurrentOwner()`. Ownership is never a credential and is never transferred by editing a DID document; `transferOwnership()` is a pure sat move that writes nothing to the CEL
- **Hosted-resource verification fails closed (#368)** — a URL-only resource whose fetch errors, hash-mismatches, or has no fetcher fails verification rather than silently passing
- **Inscription UTXO protection** — `hasResource` flag prevents spending inscription-bearing UTXOs
- **Error message sanitization** — No private keys or sensitive data in error messages
- **Comprehensive security tests** — 11 categories in `tests/security/bitcoin-penetration-tests.test.ts`
- **No remote JSON-LD fetching** — Document loader uses hardcoded context map, zero SSRF risk from JSON-LD
- **Path traversal defense-in-depth** — WebVHManager validates path segments, rejects `..`, null bytes, and verifies resolved paths stay within baseDir
- **Resource size limits** — Default 10MB max per resource, configurable per-resource
- **JSON-LD canonicalization** — Proper RDFC2019 canonicalization before signing prevents format manipulation
- **Key recovery design** — `KeyManager.recoverFromCompromise()` properly marks old keys, creates audit trail
- **Domain sanitization** — WebVHManager lowercases and sanitizes domain inputs
- **Ed25519 non-malleability** — Deterministic signatures prevent signature malleability attacks
- **Wallet key separation** — SDK never handles wallet private keys; delegated to OrdinalsProvider
- **Network mismatch prevention** — Address validation enforces network consistency (mainnet/testnet/regtest)
- **BigInt fee calculation** — Uses BigInt in fee math to prevent JavaScript integer overflow
- **Minimum relay fee** — Enforces 1.1 sat/vB minimum to prevent transaction rejection

---

## Existing Security Test Coverage

| Category | Tests | File |
|----------|-------|------|
| Double-spend attacks | Concurrent UTXO detection, locked exclusion | `bitcoin-penetration-tests.test.ts:34-112` |
| Fee rate manipulation | High/negative/NaN/Infinity/zero rejection | `bitcoin-penetration-tests.test.ts:114-184` |
| Address fuzzing | 12 malicious address formats | `bitcoin-penetration-tests.test.ts:186-232` |
| Satoshi fuzzing | 15 malicious satoshi formats | `bitcoin-penetration-tests.test.ts:234-281` |
| MIME type fuzzing | 13 malicious MIME types | `bitcoin-penetration-tests.test.ts:283-329` |
| UTXO edge cases | Empty lists, dust, insufficient funds | `bitcoin-penetration-tests.test.ts:331-409` |
| Integer overflow | Large UTXO values, overflow detection | `bitcoin-penetration-tests.test.ts:411-441` |
| Concurrency | Race condition demonstration | `bitcoin-penetration-tests.test.ts:443-468` |
| DID parsing | Malformed DID rejection | `bitcoin-penetration-tests.test.ts:471-506` |
| Boundary values | Min/max satoshi, address lengths | `bitcoin-penetration-tests.test.ts:508-540` |
| Error leakage | Sensitive data not in errors | `bitcoin-penetration-tests.test.ts:542-570` |

---

## Recommended Actions

Re-derived 2026-08-24 from the verified statuses above. Items 1, 5, 6, 7 and 15
of the previous list are gone because they are done or were never real.

### Open, worth doing before a wider launch
1. **Bound the inscription content read** (F9) — `await response.text()` in
   `BtcoDidResolver` is unbounded; a hostile content host can exhaust memory
   despite the timeout.
2. **Move the SSRF check into the resolver** (F9) — today it lives in
   `OrdHttpProvider`, so a custom provider reintroduces the vector.
3. **Require `https://` for `OrdHttpProvider` base URLs** (F15), with an
   explicit localhost/regtest escape.
4. **Replace the silent signature-format fallback** in `Signer.ts` with an
   explicit throw (F14).
5. **Cap inscription data size** in `inscribeData()` (F16) — the 10MB
   per-resource limit does not cover direct callers.

### Open, lower priority
6. Distinguish retriable from permanent provider errors (F17) — backoff already
   exists; only the `isRetriable: () => true` predicate is left.
7. Document or implement multi-proof credential verification (F10).
8. Call `validateDIDDocument()` in DID creation paths (F5).
9. Add fee-rate bounds inside `calculateFee()` for defence in depth (F6).
10. Warn when `MemoryStorageAdapter` is used with `network === 'mainnet'` (F8).
11. Replace `any` assertions in `Signer.ts` with typed noble wrappers (F7).
12. Default `maxInputs` in UTXO selection (F2); document the wallet-level UTXO
    locking requirement for integrators (F3).

## Security Test Gaps

Areas not yet covered by `tests/security/bitcoin-penetration-tests.test.ts`:

| Gap | Description | Priority |
|-----|-------------|----------|
| Provider MiTM | No tests for malicious provider responses | High |
| Reveal key leakage | No tests verifying reveal key excluded from logs | High |
| Large inscription DoS | No tests for oversized inscription data | Medium |
| Provider retry exhaustion | No tests for retry storm behavior | Medium |
| Inscription ownership | No tests for unauthorized transfer attempts | Medium |
| Multibase encoding | Covered as of 2026-08 (`tests/unit/did/Ed25519Verifier.test.ts`) | — |
