# Authentication Flows Specification

## Flow 1: Direct Auth Proxy (Client-Side)

Use when: Client handles authentication directly with Turnkey.

```
┌─────────┐     ┌──────────────┐     ┌─────────┐
│ Browser │────▶│ Turnkey Auth │────▶│ Turnkey │
│         │◀────│    Proxy     │◀────│   API   │
└─────────┘     └──────────────┘     └─────────┘
```

### Steps

1. **Initialize Client**
   ```typescript
   import { initializeTurnkeyClient, initOtp, completeOtp } from '@originals/auth/client';

   const client = initializeTurnkeyClient();
   // Requires: VITE_TURNKEY_AUTH_PROXY_CONFIG_ID, VITE_TURNKEY_ORGANIZATION_ID
   ```

2. **Send OTP**
   ```typescript
   const otpId = await initOtp(client, 'user@example.com');
   ```

3. **Verify OTP**
   ```typescript
   const { sessionToken, userId, action } = await completeOtp(client, otpId, code, email);
   // action: 'login' | 'signup'
   ```

4. **Use Session**
   ```typescript
   const wallets = await fetchWallets(client);
   ```

---

## Flow 2: Server-Proxied Authentication

Use when: Server manages Turnkey API keys and controls auth flow.

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

// Step 2: Verify OTP
const { verified, email, subOrgId } = await verifyOtp(sessionId, code);
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
  const { sessionId, code } = req.body;
  const result = await verifyEmailAuth(sessionId, code, turnkey);
  res.json(result); // { verified, email, subOrgId }
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
import { TurnkeySessionExpiredError, withTokenExpiration } from '@originals/auth/client';

try {
  const wallets = await fetchWallets(client, () => {
    // Token expired callback
    redirectToLogin();
  });
} catch (error) {
  if (error instanceof TurnkeySessionExpiredError) {
    // Handle expired session
  }
}
```

### Server Errors

```typescript
// Server-proxied auth throws Error with server message
try {
  await sendOtp('invalid-email');
} catch (error) {
  console.error(error.message); // "Invalid email format"
}
```
