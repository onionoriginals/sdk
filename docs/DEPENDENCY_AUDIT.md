# Dependency Audit — @originals/sdk v1.9.0

**Date:** 2026-03-06
**Runtime:** Bun 1.3.5
**Lockfile:** bun.lock (v1)

---

## Production Dependencies

| Package | Version | Purpose | Vulnerability |
|---------|---------|---------|---------------|
| `@aviarytech/did-peer` | ^1.1.2 | did:peer creation | None |
| `@noble/curves` | ^1.6.0 | Elliptic curve crypto | None |
| `@noble/ed25519` | ^2.0.0 | Ed25519 signatures | None |
| `@noble/hashes` | ^2.0.1 | SHA-256, SHA-512 | None |
| `@noble/secp256k1` | ^2.0.0 | Bitcoin/secp256k1 | None |
| `@scure/base` | ^1.1.6 | Base encoding | None |
| `@scure/bip32` | ^2.0.0 | HD key derivation | None |
| `@scure/btc-signer` | ^1.8.0 | Bitcoin tx signing | None |
| `@stablelib/ed25519` | ^2.0.2 | Ed25519 (legacy) | None |
| `b58` | ^4.0.3 | Base58 encoding | None |
| `bitcoinjs-lib` | ^6.1.0 | Bitcoin address validation | None |
| `cbor-js` | ^0.1.0 | CBOR encoding | None |
| `didwebvh-ts` | ^2.5.5 | did:webvh implementation | **Transitive: minimatch, brace-expansion** |
| `jsonld` | ^8.3.3 | JSON-LD processing | **Transitive: undici** |
| `micro-ordinals` | ^0.2.2 | Ordinals inscription | None |
| `multiformats` | ^12.0.0 | Multicodec/multibase | None |
| `uuid` | ^13.0.0 | UUID generation | None |

### Production Vulnerability Summary

Only **2 production deps** have transitive vulnerabilities, both in deep dependencies:

1. **`didwebvh-ts` → minimatch <3.1.3, @isaacs/brace-expansion <=5.0.0** (High: ReDoS)
   - Impact: Low — these are used for glob matching in build/tooling context, not user-facing input processing
   - Mitigation: Wait for upstream update or pin override

2. **`jsonld` → undici <6.23.0** (Moderate: unbounded decompression)
   - Impact: Low — jsonld uses undici for fetching JSON-LD contexts, which are fetched from trusted URLs
   - Mitigation: Wait for upstream update

### Crypto Library Assessment

The `@noble/*` and `@scure/*` families are audited, well-maintained cryptographic libraries by Paul Miller. All are at current stable versions with no known vulnerabilities. These are the correct choices for a Bitcoin/DID SDK.

---

## Dev Dependencies

| Package | Version | Status |
|---------|---------|--------|
| `@babel/core` | ^7.28.4 | Current |
| `@babel/preset-env` | ^7.28.3 | Current |
| `@types/bun` | ^1.3.0 | Current |
| `@types/node` | ^20.19.17 | Current |
| `@typescript-eslint/eslint-plugin` | ^6.0.0 | **Outdated** — v8 available |
| `@typescript-eslint/parser` | ^6.0.0 | **Outdated** — v8 available |
| `bun-types` | ^1.3.1 | Current |
| `eslint` | ^8.0.0 | **Outdated** — v9 available |
| `prettier` | ^3.0.0 | Current |
| `tsc-alias` | ^1.8.16 | Current |
| `typedoc` | ^0.28.17 | Current |
| `typescript` | ^5.0.0 | Current |

### Dev Vulnerability Summary

Most dev vulnerabilities come from `eslint` v8 and its transitive dependency tree (`minimatch`, `ajv`). The `eslint` v8 → v9 migration would resolve these. The `@semantic-release/*` packages at the root monorepo have minor patch updates available.

---

## Vulnerability Report (14 total)

### High Severity (12)

| CVE/Advisory | Package | Affected | Type | Production? |
|-------------|---------|----------|------|-------------|
| GHSA-3ppc-4f35-3m26 | minimatch <3.1.3 | eslint, typedoc, didwebvh-ts | ReDoS | Transitive via didwebvh-ts |
| GHSA-7r86-cg39-jmmj | minimatch <3.1.3 | Same | ReDoS (GLOBSTAR) | Transitive via didwebvh-ts |
| GHSA-23c5-xmqv-rm74 | minimatch <3.1.3 | Same | ReDoS (extglobs) | Transitive via didwebvh-ts |
| GHSA-83g3-92jg-28cx | tar <7.5.8 | @semantic-release/npm | File traversal | No (dev only) |
| GHSA-qffp-2rhf-9h96 | tar <7.5.8 | @semantic-release/npm | Path traversal | No (dev only) |
| GHSA-7h2j-956f-4vf2 | @isaacs/brace-expansion <=5.0.0 | eslint, typedoc, didwebvh-ts | Resource consumption | Transitive via didwebvh-ts |

### Moderate Severity (2)

| CVE/Advisory | Package | Affected | Type | Production? |
|-------------|---------|----------|------|-------------|
| GHSA-2g4f-4pwh-qvx6 | ajv <6.14.0 | eslint, @commitlint | ReDoS | No (dev only) |
| GHSA-g9mf-h72j-4rw9 | undici <6.23.0 | @semantic-release/github, jsonld | Decompression DoS | Transitive via jsonld |

---

## Automation

### Dependabot (already configured)

`.github/dependabot.yml` is in place with:
- Weekly checks on Mondays
- Grouped updates for `@noble/*` / `@scure/*` (crypto) and dev tools
- GitHub Actions ecosystem also tracked
- 10 PR limit

### Recommendations

1. **No immediate action required** — all high-severity vulns are in transitive deps of dev tools or used in non-user-facing contexts
2. **Pin versions in lockfile** — `bun.lock` already pins all transitive deps (confirmed)
3. **Update dev tools when ready:**
   - `eslint` v8 → v9 (breaking: flat config migration)
   - `@typescript-eslint/*` v6 → v8 (breaking: requires eslint v9)
   - `@semantic-release/*` patch updates (non-breaking)
4. **Monitor upstream:**
   - `didwebvh-ts` for minimatch fix
   - `jsonld` for undici update
5. **Consider overrides** if upstream is slow — Bun supports `"overrides"` in package.json to force transitive dep versions

---

## Version Pinning Strategy

Current approach: **caret ranges** (`^`) for all deps. This is appropriate for an SDK because:
- Lockfile (`bun.lock`) pins exact versions for reproducible builds
- Caret ranges allow Dependabot to propose compatible updates
- Production consumers get their own lockfile resolution

No changes recommended to version strategy.
