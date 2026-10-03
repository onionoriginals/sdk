# @originals/auth Package Specification

## Overview

The `@originals/auth` package provides Turnkey-based authentication for the Originals Protocol. It enables secure user authentication using email OTP with cryptographic key management via Turnkey.

## Architecture

```
@originals/auth
├── /server          # Server-side utilities (requires API keys)
│   ├── email-auth   # OTP initiation and verification
│   ├── jwt          # Token signing and verification
│   ├── middleware   # Express authentication middleware
│   ├── turnkey-client # Turnkey API integration
│   └── turnkey-signer # Server-side DID signing
├── /client          # Client-side utilities (browser-safe)
│   ├── turnkey-client # Low-level Turnkey calls (server-side use only)
│   ├── turnkey-did-signer # Client-side DID signing
│   └── server-auth  # Server-proxied auth helpers [NEW]
└── /types           # Shared type definitions
```

## Authentication Patterns

The package supports two supported authentication patterns, plus low-level
server-side building blocks:

### 1. Server-Proxied (Server manages API keys)
- Client calls YOUR server endpoints
- Server uses Turnkey API keys to process auth
- Best for: Apps where server controls auth flow

### 2. Hybrid (Server issues JWTs)
- Combines OTP verification with server-issued JWTs
- Server manages session state and user records
- Best for: Full-stack apps with user databases

### Direct client-side Turnkey calls are not supported
A prior "Direct Auth Proxy" pattern let the browser call Turnkey directly.
`initializeTurnkeyClient()` (the entry point for that pattern) has been
removed for reading server-only org API secrets and now unconditionally
throws. The low-level functions it used (`initOtp`, `completeOtp`,
`fetchUser`, `fetchWallets`, `createWalletWithAccounts`,
`ensureWalletWithAccounts`) remain exported from `@originals/auth/client`,
but require a `Turnkey` client obtained server-side via `createTurnkeyClient()`
— see [`client-api.md`](client-api.md#low-level-turnkey-functions-server-side-only).

## Security Model

- **Turnkey Sub-Organizations**: Each user gets isolated key storage
- **HTTP-Only Cookies**: JWT tokens stored securely against XSS
- **OTP Expiration**: 15-minute validity window
- **Session Tokens**: Short-lived Turnkey session credentials

## Dependencies

- `@turnkey/sdk-server` - Server-side Turnkey SDK
- `@turnkey/core` - Core Turnkey client
- `@originals/sdk` - DID operations and signing
- `jsonwebtoken` - JWT token handling
- `@noble/hashes` - Cryptographic hashing

## Entry Points

| Import Path | Environment | Description |
|-------------|-------------|-------------|
| `@originals/auth/server` | Node.js | Server utilities with API key access |
| `@originals/auth/client` | Browser | Client utilities (no secrets) |
| `@originals/auth/types` | Both | Type definitions only |
| `@originals/auth` | Node.js | Re-exports server + types |
