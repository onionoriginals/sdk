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
│   ├── turnkey-client # Direct Turnkey auth proxy calls
│   ├── turnkey-did-signer # Client-side DID signing
│   └── server-auth  # Server-proxied auth helpers [NEW]
└── /types           # Shared type definitions
```

## Authentication Patterns

The package supports three authentication patterns:

### 1. Direct Auth Proxy (Client-side)
- Client calls Turnkey directly via auth proxy
- Requires `VITE_TURNKEY_AUTH_PROXY_CONFIG_ID` in client
- Best for: SPAs where client handles auth flow directly

### 2. Server-Proxied (Server manages API keys)
- Client calls YOUR server endpoints
- Server uses Turnkey API keys to process auth
- Best for: Apps where server controls auth flow

### 3. Hybrid (Server issues JWTs)
- Combines OTP verification with server-issued JWTs
- Server manages session state and user records
- Best for: Full-stack apps with user databases

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
