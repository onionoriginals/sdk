# @originals/auth

Turnkey-based authentication for the [Originals Protocol](https://github.com/onionoriginals/sdk) — server middleware and client helpers for email-OTP auth flows backed by [Turnkey](https://www.turnkey.com/) key management.

## Installation

```bash
npm install @originals/auth
# or
bun add @originals/auth
```

Requires Node.js `>=20.10.0` (or Bun). Published as ESM. `express` is an optional peer dependency for the server middleware.

## Usage

Server-side:

```typescript
import { createAuthMiddleware, initiateEmailAuth, verifyEmailAuth } from '@originals/auth/server';
```

Client-side (pure functions, no React):

```typescript
import { initializeTurnkeyClient, initOtp, completeOtp, fetchWallets } from '@originals/auth/client';
```

Types:

```typescript
import type { AuthUser, TokenPayload, TurnkeyWallet } from '@originals/auth/types';
```

Import client utilities from `@originals/auth/client` (not the package root) to avoid pulling server code into browser bundles.

## Documentation

- [Originals SDK repository](https://github.com/onionoriginals/sdk) — source, issues, and protocol documentation
- [@originals/sdk on npm](https://www.npmjs.com/package/@originals/sdk) — the core SDK this package builds on

## License

[MIT](./LICENSE) © Aviary Tech
