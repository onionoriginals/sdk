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

The supported flow is server-driven email OTP: your server holds the Turnkey API keys and exposes send/verify endpoints; the client calls those endpoints.

Server-side — create the Turnkey client and handle the OTP endpoints:

```typescript
import {
  createTurnkeyClient,
  initiateEmailAuth,
  verifyEmailAuth,
  createAuthMiddleware,
} from '@originals/auth/server';

// In your send-OTP endpoint: initiateEmailAuth(...)
// In your verify-OTP endpoint: verifyEmailAuth(...)
// Protect routes with createAuthMiddleware(...)
```

Client-side (pure functions, no React) — call your server's OTP endpoints:

```typescript
import { sendOtp, verifyOtp } from '@originals/auth/client';

const { sessionId } = await sendOtp('user@example.com');
// ...user enters the code from their inbox...
const { verified } = await verifyOtp(sessionId, '123456');
```

Types:

```typescript
import type { AuthUser, TokenPayload, TurnkeyWallet } from '@originals/auth/types';
```

Import client utilities from `@originals/auth/client` (not the package root) to avoid pulling server code into browser bundles. Turnkey API keys are server-only: initialize Turnkey with `createTurnkeyClient` from `@originals/auth/server` — there is no client-side Turnkey initializer.

## Documentation

- [Originals SDK repository](https://github.com/onionoriginals/sdk) — source, issues, and protocol documentation
- [@originals/sdk on npm](https://www.npmjs.com/package/@originals/sdk) — the core SDK this package builds on

## License

[MIT](./LICENSE) © Aviary Tech
