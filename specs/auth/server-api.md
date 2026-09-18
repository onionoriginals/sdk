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

### `verifyEmailAuth(sessionId, code, turnkeyClient, sessionStorage?, options?)`

Verify the OTP code entered by user. Also provisions the user's Turnkey
sub-organization (get or create), deferred from initiation so resources are
only created for proven email addresses.

```typescript
function verifyEmailAuth(
  sessionId: string,
  code: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage,
  options?: VerifyEmailAuthOptions
): Promise<VerifyAuthResult>
```

**Options:**
```typescript
interface VerifyEmailAuthOptions {
  // Compressed P-256 public key (hex) supplied by the client, to which the
  // Turnkey verification token will be bound. When provided, the matching
  // private key never leaves the client and the result's `privateKey` is
  // omitted. When omitted, an ephemeral keypair is generated server-side
  // and its private key is returned in the result (server-only fallback —
  // browser clients should always generate the keypair themselves and pass
  // its public key here).
  publicKey?: string;
  // Override for the enclave signing key used to verify the OTP encryption
  // target bundle's signature. ONLY for tests or non-production Turnkey
  // environments; defaults to Turnkey's production signer key.
  dangerouslyOverrideSignerPublicKey?: string;
  // Serializes the lookup-then-create sequence for a brand-new email,
  // preventing two concurrent verifications from minting two sub-
  // organizations. Defaults to an in-process lock, which is NOT safe
  // across multiple server instances — pass a distributed `SubOrgLock`
  // for multi-instance deployments.
  subOrgLock?: SubOrgLock;
}
```

`SubOrgLock` (also exported): `{ withLock<T>(key: string, fn: () => Promise<T>): Promise<T> }`. `createInProcessSubOrgLock()` builds the default in-process implementation used when `subOrgLock` is omitted.

**Returns:**
```typescript
interface VerifyAuthResult {
  verified: boolean;
  email: string;
  subOrgId: string;  // Turnkey sub-organization ID
  // Verification token issued by Turnkey. Consumed by a subsequent
  // OTP_LOGIN request to create an authenticated session.
  verificationToken?: string;
  // Compressed P-256 public key (hex) the verification token is bound to.
  // Pass this as `publicKey` to a subsequent `otpLogin` activity.
  publicKey?: string;
  // Private key (hex) for the ephemeral key pair generated during OTP
  // encryption. Only present when the server generated the keypair (no
  // client `publicKey` was supplied in `options`). Sensitive: never log
  // or persist insecurely.
  privateKey?: string;
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

Server-side signer for DID documents using Turnkey API keys. Implements both
`ExternalSigner` and `ExternalVerifier`. Prefer `createTurnkeySigner()` below
over calling this constructor directly — it takes positional arguments in a
different order than the factory's options object.

```typescript
class TurnkeyWebVHSigner {
  constructor(
    subOrgId: string,
    keyId: string,
    publicKeyMultibase: string,
    turnkeyClient: Turnkey,
    verificationMethodId: string
  );

  sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }>;
  // Signs pre-canonicalized, pre-hashed bytes — used to author CEL events
  // and sign credentials, not just did:webvh logs.
  signBytes(data: Uint8Array): Promise<{ signature: Uint8Array }>;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  getVerificationMethodId(): string;
  getPublicKeyMultibase(): string;
}
```

### `createTurnkeySigner(options)`

Factory function for creating server-side signers.

```typescript
function createTurnkeySigner(options: {
  turnkeyClient: Turnkey;
  organizationId: string;   // -> TurnkeyWebVHSigner's subOrgId
  privateKeyId: string;     // -> TurnkeyWebVHSigner's keyId
  verificationMethodId: string;
  publicKeyMultibase: string;
}): TurnkeyWebVHSigner
```
