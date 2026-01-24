# Server API Reference

Import: `import { ... } from '@originals/auth/server'`

---

## Turnkey Client

### `createTurnkeyClient()`

Create a Turnkey SDK instance for server-side API calls.

```typescript
function createTurnkeyClient(): Turnkey
```

**Environment Variables Required:**
- `TURNKEY_API_PUBLIC_KEY`
- `TURNKEY_API_PRIVATE_KEY`
- `TURNKEY_ORGANIZATION_ID`

---

## Email Authentication

### `initiateEmailAuth(email, turnkeyClient, sessionStorage?)`

Send OTP code to user's email.

```typescript
function initiateEmailAuth(
  email: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage
): Promise<InitiateAuthResult>
```

**Returns:**
```typescript
interface InitiateAuthResult {
  sessionId: string;  // Use for verification step
  message: string;    // "Verification code sent to your email..."
}
```

**Throws:** Error if email format is invalid or Turnkey API fails.

---

### `verifyEmailAuth(sessionId, code, turnkeyClient, sessionStorage?)`

Verify the OTP code entered by user.

```typescript
function verifyEmailAuth(
  sessionId: string,
  code: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage
): Promise<VerifyAuthResult>
```

**Returns:**
```typescript
interface VerifyAuthResult {
  verified: boolean;
  email: string;
  subOrgId: string;  // Turnkey sub-organization ID
}
```

**Throws:** Error if session expired, invalid, or code is wrong.

---

### `getSession(sessionId, sessionStorage?)`

Get session data without modifying it.

```typescript
function getSession(
  sessionId: string,
  sessionStorage?: SessionStorage
): EmailAuthSession | undefined
```

---

### `isSessionVerified(sessionId, sessionStorage?)`

Check if a session has been verified.

```typescript
function isSessionVerified(
  sessionId: string,
  sessionStorage?: SessionStorage
): boolean
```

---

### `cleanupSession(sessionId, sessionStorage?)`

Remove a session after successful login.

```typescript
function cleanupSession(
  sessionId: string,
  sessionStorage?: SessionStorage
): void
```

---

### `createInMemorySessionStorage()`

Create default in-memory session storage with auto-cleanup.

```typescript
function createInMemorySessionStorage(): SessionStorage
```

---

## JWT Tokens

### `signToken(subOrgId, email, sessionToken?, options?)`

Sign a JWT token for authenticated user.

```typescript
function signToken(
  subOrgId: string,
  email: string,
  sessionToken?: string,
  options?: {
    secret?: string;     // Default: process.env.JWT_SECRET
    expiresIn?: number;  // Default: 7 days (in seconds)
    issuer?: string;     // Default: 'originals-auth'
    audience?: string;   // Default: 'originals-api'
  }
): string
```

---

### `verifyToken(token, options?)`

Verify and decode a JWT token.

```typescript
function verifyToken(
  token: string,
  options?: {
    secret?: string;
    issuer?: string;
    audience?: string;
  }
): TokenPayload
```

**Returns:**
```typescript
interface TokenPayload {
  sub: string;           // Turnkey sub-org ID
  email: string;
  sessionToken?: string;
  iat: number;
  exp: number;
}
```

**Throws:** Error if token is invalid or expired.

---

### `getAuthCookieConfig(token, options?)`

Generate secure cookie configuration.

```typescript
function getAuthCookieConfig(
  token: string,
  options?: {
    cookieName?: string;  // Default: 'auth_token'
    maxAge?: number;      // Default: 7 days (ms)
    secure?: boolean;     // Default: true in production
  }
): AuthCookieConfig
```

**Returns:**
```typescript
interface AuthCookieConfig {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;    // true (XSS protection)
    secure: boolean;      // true in production
    sameSite: 'strict';   // CSRF protection
    maxAge: number;
    path: string;
  };
}
```

---

### `getClearAuthCookieConfig(cookieName?)`

Get cookie config for logout (expires immediately).

```typescript
function getClearAuthCookieConfig(cookieName?: string): AuthCookieConfig
```

---

## Express Middleware

### `createAuthMiddleware(options)`

Create authentication middleware for Express routes.

```typescript
function createAuthMiddleware(
  options: AuthMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void | Response>
```

**Options:**
```typescript
interface AuthMiddlewareOptions {
  getUserByTurnkeyId: (turnkeyId: string) => Promise<AuthUser | null>;
  createUser?: (turnkeyId: string, email: string, temporaryDid: string) => Promise<AuthUser>;
  cookieName?: string;   // Default: 'auth_token'
  jwtSecret?: string;    // Default: process.env.JWT_SECRET
}
```

**Request Extension:**
```typescript
interface AuthenticatedRequest {
  user: {
    id: string;
    turnkeySubOrgId: string;
    email: string;
    did: string;
    sessionToken?: string;
  };
}
```

**Usage:**
```typescript
const auth = createAuthMiddleware({
  getUserByTurnkeyId: (id) => db.users.findByTurnkeyId(id),
});

app.get('/api/protected', auth, (req, res) => {
  res.json({ user: req.user });
});
```

---

## DID Signing

### `TurnkeyWebVHSigner`

Server-side signer for DID documents using Turnkey API keys.

```typescript
class TurnkeyWebVHSigner {
  constructor(params: {
    turnkeyClient: Turnkey;
    organizationId: string;
    privateKeyId: string;
  });

  sign(input: SigningInput): Promise<SigningOutput>;
  getVerificationMethodId(): string;
}
```

### `createTurnkeySigner(params)`

Factory function for creating server-side signers.

```typescript
function createTurnkeySigner(params: {
  turnkeyClient: Turnkey;
  organizationId: string;
  privateKeyId: string;
}): TurnkeyWebVHSigner
```
