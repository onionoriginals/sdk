# Authentication Flows Specification

## Flow 1: Direct Auth Proxy (Client-Side) — Removed / Unsupported

**This flow no longer works.** `initializeTurnkeyClient()` reads server-only
org API secrets and has been removed from the client module for that
reason; it unconditionally throws (it remains exported only as a
compatibility shim). There is no supported way for a browser to talk to
Turnkey directly. Use [Flow 2: Server-Proxied Authentication](#flow-2-server-proxied-authentication)
for browser-side code.

If your own server already holds a `Turnkey` client (via `createTurnkeyClient()`
from `@originals/auth/server`) and a verified `subOrgId`, the low-level
functions this flow used to describe (`initOtp`, `completeOtp`, `fetchUser`,
`fetchWallets`, `createWalletWithAccounts`, `ensureWalletWithAccounts`) are
still available server-side — see their real signatures in
[`client-api.md`](client-api.md#low-level-turnkey-functions-server-side-only).

---

## Flow 2: Server-Proxied Authentication

Use when: Server manages Turnkey API keys and controls auth flow. This is
the supported flow for browser clients.

```
┌─────────┐     ┌────────────┐     ┌─────────┐
│ Browser │────▶│ Your Server│────▶│ Turnkey │
│         │◀────│ (API Keys) │◀────│   API   │
└─────────┘     └────────────┘     └─────────┘
```

### Client-Side

```typescript
import { sendOtp, verifyOtp } from '@originals/auth/client';

// Step 1: Request OTP
const { sessionId, message } = await sendOtp('user@example.com');

// Step 2: Verify OTP. Pass a browser-generated publicKey so the
// verification token's private key never transits the response.
const { verified, email, subOrgId } = await verifyOtp(sessionId, code, undefined, {
  publicKey: myP256PublicKeyHex,
});
```

### Server-Side (Your Endpoints)

```typescript
import { initiateEmailAuth, verifyEmailAuth, createTurnkeyClient } from '@originals/auth/server';

const turnkey = createTurnkeyClient();

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  const result = await initiateEmailAuth(email, turnkey);
  res.json(result); // { sessionId, message }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { sessionId, code, publicKey } = req.body;
  const result = await verifyEmailAuth(sessionId, code, turnkey, undefined, { publicKey });
  res.json(result);
  // { verified, email, subOrgId, verificationToken?, publicKey?, privateKey? }
  // verificationToken/publicKey are set once verified; privateKey is only
  // present when the request omitted publicKey (server-generated fallback
  // keypair) — see VerifyEmailAuthOptions in packages/auth/src/server.
});
```

---

## Flow 3: Hybrid with JWT Sessions

Use when: Full-stack app with user database and server-managed sessions.

```
┌─────────┐     ┌────────────┐     ┌─────────┐     ┌──────────┐
│ Browser │────▶│ Your Server│────▶│ Turnkey │     │ Database │
│         │◀────│ (JWT+API)  │◀────│   API   │◀───▶│  Users   │
└─────────┘     └────────────┘     └─────────┘     └──────────┘
```

### Server-Side

```typescript
import {
  initiateEmailAuth,
  verifyEmailAuth,
  signToken,
  getAuthCookieConfig,
  createAuthMiddleware,
  createTurnkeyClient
} from '@originals/auth/server';

const turnkey = createTurnkeyClient();

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  const result = await initiateEmailAuth(req.body.email, turnkey);
  res.json(result);
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { verified, email, subOrgId } = await verifyEmailAuth(
    req.body.sessionId,
    req.body.code,
    turnkey
  );

  if (verified) {
    // Issue JWT
    const token = signToken(subOrgId, email);
    const cookie = getAuthCookieConfig(token);
    res.cookie(cookie.name, cookie.value, cookie.options);
    res.json({ success: true });
  }
});

// Protected routes
const authenticate = createAuthMiddleware({
  getUserByTurnkeyId: (id) => db.users.findByTurnkeyId(id),
  createUser: (id, email, did) => db.users.create({ turnkeySubOrgId: id, email, did }),
});

app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});
```

---

## Session Storage

The server-side email auth uses pluggable session storage:

```typescript
// Default: In-memory (for single-server deployments)
const result = await initiateEmailAuth(email, turnkey);

// Custom: Redis, database, etc.
const redisStorage = createRedisSessionStorage(redis);
const result = await initiateEmailAuth(email, turnkey, redisStorage);
```

### Session Storage Interface

```typescript
interface SessionStorage {
  get(sessionId: string): EmailAuthSession | undefined;
  set(sessionId: string, session: EmailAuthSession): void;
  delete(sessionId: string): void;
  cleanup(): void;
}
```

---

## Error Handling

### Session Expiration

```typescript
import { TurnkeySessionExpiredError, fetchWallets } from '@originals/auth/client';

try {
  const wallets = await fetchWallets(turnkeyClient, subOrgId, () => {
    // Token expired callback
    redirectToLogin();
  });
} catch (error) {
  if (error instanceof TurnkeySessionExpiredError) {
    // Handle expired session
  }
}
```

Note: `fetchWallets` is a [low-level, server-side-only function](client-api.md#low-level-turnkey-functions-server-side-only) —
this pattern applies to your own server code holding a `Turnkey` client, not
the browser.

### Server Errors

```typescript
// Server-proxied auth throws Error with server message
try {
  await sendOtp('invalid-email');
} catch (error) {
  console.error(error.message); // "Invalid email format"
}
```
