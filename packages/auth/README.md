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

## Security notes

**Rate-limit the send-OTP endpoint.** `initiateEmailAuth` sends an email on every call. The endpoint exposing it MUST enforce rate limits (per IP and per target email) — Turnkey's per-user throttle does not protect arbitrary recipient addresses from an attacker who varies the email. Turnkey sub-organizations and wallets are only provisioned after the OTP is verified, so unverified requests create no billable resources, but unthrottled requests still spam arbitrary inboxes.

**Keep the verification-token key in the browser.** The Turnkey verification token returned by `verifyEmailAuth` is bound to a P-256 key. Generate that keypair in the browser (`generateP256KeyPair` from `@turnkey/crypto`) and pass its public key through your verify endpoint into `verifyEmailAuth`'s `options.publicKey`, so the private key never transits an HTTP response:

```typescript
// Browser
import { generateP256KeyPair } from '@turnkey/crypto';
import { verifyOtp } from '@originals/auth/client';

const keyPair = generateP256KeyPair(); // private key stays here
const result = await verifyOtp(sessionId, code, undefined, {
  publicKey: keyPair.publicKey,
});

// Server verify endpoint
const result = await verifyEmailAuth(sessionId, code, turnkeyClient, storage, {
  publicKey: req.body.publicKey, // bind the token to the client's key
});
```

If no `publicKey` is supplied, `verifyEmailAuth` falls back to generating the keypair server-side and returns the private key in its result — acceptable for pure server-to-server flows only.

**OTP attempt limiting.** A verification session is destroyed after 5 failed attempts; the user must request a new code.

## Documentation

- [Originals SDK repository](https://github.com/onionoriginals/sdk) — source, issues, and protocol documentation
- [@originals/sdk on npm](https://www.npmjs.com/package/@originals/sdk) — the core SDK this package builds on

## License

[MIT](./LICENSE) © Aviary Tech
