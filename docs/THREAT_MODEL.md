# Originals SDK — Security Audit & Threat Model

**Date:** 2026-03-06
**Scope:** @originals/sdk v1.9.0 — crypto operations, key handling, input validation, Bitcoin transactions
**Overall Risk:** MEDIUM — solid fundamentals, recommended hardening items below

---

## Threat Model

### Attack Surface Overview

```
External Input          SDK Boundary              Internal Operations
─────────────────────   ──────────────────────    ────────────────────────
User resources    ───→  Validation layer     ───→  DID creation (did:peer)
DID strings       ───→  DID parsing          ───→  WebVH publication
Bitcoin addresses ───→  Address validation   ───→  Bitcoin inscription
Fee rates         ───→  Bounds checking      ───→  Transaction construction
UTXO sets         ───→  Selection/filtering  ───→  Commit-reveal signing
External signers  ───→  Interface contract   ───→  Credential issuance
```

### Threat Categories

| # | Threat | Component | Severity | Status |
|---|--------|-----------|----------|--------|
| T1 | Malformed Bitcoin address causes fund loss | `commit.ts`, `transfer.ts` | High | Partially mitigated — see F1 |
| T2 | Fee rate manipulation drains wallet | `BitcoinManager`, `fee-calculation.ts` | High | Mitigated — max fee rate enforced in BitcoinManager |
| T3 | UTXO double-spend via concurrent selection | `utxo-selection.ts` | High | Known limitation — wallet-level locking required |
| T4 | Private key leakage via logging/errors | `Signer.ts`, `commit.ts`, `eddsa.ts` | Medium | Mitigated — no keys in logs/errors currently |
| T5 | Inscription front-running | `commit.ts` | Medium | Mitigated — random keypair per reveal tx |
| T6 | Spending inscription-bearing UTXOs | `utxo-selection.ts` | High | Mitigated — `hasResource` flag filtering |
| T7 | Integer overflow in satoshi math | `satoshi-validation.ts` | Medium | Mitigated — BigInt used, max supply enforced |
| T8 | DID document injection | `DIDManager`, `validation.ts` | Low | Partially mitigated — see F5 |
| T9 | Memory storage in production | `MemoryStorageAdapter.ts` | Low | Dev-only adapter, no production guard |
| T10 | Dust output creation | `commit.ts`, `utxo-selection.ts` | Medium | Mitigated — dust added to fee, 546 sat minimum |
| T11 | SSRF via malicious inscription URL | `BtcoDidResolver.ts` | Medium | Not mitigated — see F9 |
| T12 | Silent multi-proof bypass | `Verifier.ts` | Low | Not mitigated — see F10 |
| T13 | EdDSA proof hash collision via missing domain separation | `eddsa.ts` | High | Not mitigated — see F11 |
| T14 | Incorrect multibase encoding in Ed25519Verifier | `Ed25519Verifier.ts` | Medium | Not mitigated — see F12 |
| T15 | Malicious external signer injecting invalid proofs | `WebVHManager.ts` | Medium | Not mitigated — see F13 |
| T16 | Silent signature corruption via format fallback | `Signer.ts` | Medium | Not mitigated — see F14 |
| T17 | Provider MiTM via HTTP (no HTTPS enforcement) | `OrdHttpProvider.ts` | High | Not mitigated — see F15 |
| T18 | No inscription data size limit | `BitcoinManager.ts` | Medium | Not mitigated — see F16 |
| T19 | Provider retry storm (no backoff/circuit breaker) | `OrdinalsProvider.ts` | Medium | Not mitigated — see F17 |

---

## Findings

### High Priority

**F1 — Missing address validation in transfer/commit paths**
- **Files:** `src/bitcoin/transfer.ts:27`, `src/bitcoin/transactions/commit.ts:184-186`
- **Issue:** Change address and recipient address checked for presence but not format validity. `validateBitcoinAddress()` exists but isn't called in these paths.
- **Impact:** Invalid addresses would fail at `addOutputAddress()` with unclear errors instead of early validation.
- **Recommendation:** Add `validateBitcoinAddress(address, network)` calls at function entry points.

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
- **Issue:** `validateDIDDocument()` exists but isn't invoked during `createDIDPeer()` or `createDIDWebVH()`.
- **Impact:** Malformed DID documents could be created in edge cases.
- **Recommendation:** Call `validateDIDDocument()` in DID creation methods.

**F6 — Fee calculation accepts unbounded rates**
- **File:** `src/bitcoin/fee-calculation.ts:19-36`
- **Issue:** `calculateFee()` doesn't validate the `feeRate` parameter. Protection exists in `BitcoinManager` (max 10,000 sat/vB) but not in the utility function.
- **Recommendation:** Add bounds checking in `calculateFee()` for defense-in-depth.

**F9 — SSRF via unvalidated inscription content URL**
- **File:** `src/did/BtcoDidResolver.ts:126-134`
- **Issue:** When resolving a `did:btco`, the resolver fetches `inscription.content_url` without validating the URL scheme or destination. A malicious inscription could set `content_url` to `file:///etc/passwd` or `http://169.254.169.254/...` (cloud metadata).
- **Impact:** Server-side request forgery — an attacker could probe internal networks or read local files via a crafted inscription.
- **Recommendation:** Validate URL scheme (allow only `https://`), reject private IP ranges and localhost before fetching.

**F10 — Silent multi-proof bypass in credential verification**
- **File:** `src/vc/Verifier.ts:21,45`
- **Issue:** When a credential has multiple proofs, only the first is verified: `Array.isArray(proofValue) ? proofValue[0] : proofValue`. Additional proofs are silently ignored.
- **Impact:** Low — an attacker cannot exploit this to bypass verification, but valid additional proofs go unverified.
- **Recommendation:** Document single-proof-only behavior or implement multi-proof verification.

**F11 — EdDSA proof hash concatenation without domain separation**
- **File:** `src/vc/cryptosuites/eddsa.ts:83`
- **Issue:** The proof hash is created by concatenating `proofConfigHash` (32 bytes) and `documentHash` (32 bytes) directly: `new Uint8Array([...proofConfigHash, ...documentHash])`. No length prefix or domain separator is used. This creates a theoretical risk of collision attacks where different (proofConfig, document) pairs could produce the same 64-byte concatenation.
- **Impact:** Theoretical collision risk in credential proof verification. Practical exploitation is difficult but violates cryptographic best practice.
- **Recommendation:** Add domain separation tag or length prefix before each hash component.

**F12 — Incorrect multibase encoding in Ed25519Verifier**
- **File:** `src/did/Ed25519Verifier.ts:65`
- **Issue:** `getPublicKeyMultibase()` encodes the public key as base64 with a `z` prefix (`z<base64>`), but the `z` prefix per multibase standard means base58-btc. This is inconsistent with the rest of the SDK which correctly uses base58-btc with `z`.
- **Impact:** Keys from Ed25519Verifier are non-standard multibase and would fail interoperability with correct multibase decoders.
- **Recommendation:** Use `multikey.encodePublicKey(this.publicKey, 'Ed25519')` from `src/crypto/Multikey.ts`.

**F13 — External signer proofValue not validated after signing**
- **File:** `src/did/WebVHManager.ts:199-213`
- **Issue:** When using an external signer, the returned `proofValue` is accepted without verifying it is a valid signature. A compromised or malicious external signer could return arbitrary proof values that would be stored as valid.
- **Impact:** Invalid credentials could be created if the external signer is compromised.
- **Recommendation:** Always verify the returned signature against the document, even for external signers. Validate that `proofValue` decodes as valid multibase.

**F14 — Signature format detection with silent fallback**
- **File:** `src/crypto/Signer.ts:40-50`
- **Issue:** When noble crypto returns an unrecognized signature format, the code falls back to `new Uint8Array(sigAny)` which could produce a corrupted signature without error.
- **Impact:** If noble changes its return type, signatures could silently become invalid rather than throwing.
- **Recommendation:** Throw an explicit error if the signature format is unrecognized instead of silent conversion.

**F15 — Provider MiTM via HTTP (no HTTPS enforcement)**
- **File:** `src/adapters/providers/OrdHttpProvider.ts:13-21`
- **Issue:** `OrdHttpProvider` fetches from `baseUrl` using `globalThis.fetch()` without enforcing HTTPS. Provider responses (inscription data, satoshi info) are trusted without independent verification.
- **Impact:** A network attacker could intercept HTTP provider responses to return false inscription ownership, potentially enabling theft during transfers.
- **Recommendation:** Enforce HTTPS for provider URLs at construction time. Consider certificate pinning for high-value operations.

**F16 — No inscription data size limit**
- **File:** `src/bitcoin/BitcoinManager.ts:99-107`
- **Issue:** `inscribeData()` accepts any data with only a non-null check. No size limit is enforced before serialization.
- **Impact:** DoS via resource exhaustion — caller could attempt to inscribe gigabytes, consuming memory before the provider rejects it.
- **Recommendation:** Add configurable max inscription size (e.g., 4MB default).

**F17 — Provider retry storm (no backoff or circuit breaker)**
- **File:** `src/bitcoin/providers/OrdinalsProvider.ts:14-55`
- **Issue:** All provider calls use `withRetry()` with `isRetriable: () => true`, meaning any error triggers retries. No exponential backoff or circuit breaker pattern.
- **Impact:** Could hammer a provider with repeated requests for permanent errors. DoS risk against provider infrastructure.
- **Recommendation:** Implement exponential backoff, distinguish retriable (network) vs permanent (404) errors, add circuit breaker.

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

## Security Strengths

The SDK demonstrates strong security practices in several areas:

- **Multibase key encoding** — All keys use multibase+multicodec, preventing JWK confusion attacks
- **Key length validation** — Strict byte-length checks per algorithm (Ed25519: 32, secp256k1: 32/33, P256: 32/33)
- **Cryptographically secure RNG** — Uses `noble/curves` `randomPrivateKey()` for all key generation
- **Bitcoin address validation** — Full format + checksum validation via `bitcoinjs-lib`, network-aware
- **Satoshi number validation** — Comprehensive: regex, range (0 to 2.1 quadrillion), type checks
- **Fee rate bounds** — Max 10,000 sat/vB in BitcoinManager prevents accidental fund drain
- **Dust limit handling** — Sub-546-sat change added to fee instead of creating dust outputs
- **Front-running protection** — Random reveal keypair per inscription
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

### Immediate (before v1.0 release)
1. Add `validateBitcoinAddress()` in `transfer.ts` and `commit.ts` entry points
2. Set default `maxInputs: 100` in UTXO selection
3. Document UTXO locking requirement for production integrators
4. Validate inscription content URLs in `BtcoDidResolver` — whitelist `https://`, reject private IPs
5. Fix Ed25519Verifier multibase encoding — use `multikey.encodePublicKey()` instead of base64 with `z` prefix
6. Add domain separation to EdDSA proof hash concatenation in `eddsa.ts`
7. Replace silent signature format fallback in `Signer.ts` with explicit error
8. Enforce HTTPS for `OrdHttpProvider` base URLs
9. Add configurable max inscription data size (e.g., 4MB default)

### Short-term
10. Minimize private key string conversions in `eddsa.ts` and `commit.ts`
11. Call `validateDIDDocument()` in DID creation paths
12. Add fee rate validation in `calculateFee()`
13. Add production warning for `MemoryStorageAdapter` on mainnet
14. Document or implement multi-proof credential verification
15. Verify external signer proofValue after signing in `WebVHManager`
16. Add exponential backoff and circuit breaker to provider retry logic

### Medium-term
17. Replace `any` assertions in `Signer.ts` with typed noble wrappers
18. Consider UTXO locking API for wallet-level integrations
19. Add key rotation test suite
20. Expand security test suite (see gaps below)

---

## Security Test Gaps

Areas not yet covered by `tests/security/bitcoin-penetration-tests.test.ts`:

| Gap | Description | Priority |
|-----|-------------|----------|
| Provider MiTM | No tests for malicious provider responses | High |
| Reveal key leakage | No tests verifying reveal key excluded from logs | High |
| Large inscription DoS | No tests for oversized inscription data | Medium |
| Provider retry exhaustion | No tests for retry storm behavior | Medium |
| Inscription ownership | No tests for unauthorized transfer attempts | Medium |
| Multibase encoding | No tests for Ed25519Verifier encoding correctness | Medium |
