# Client API Reference

Import: `import { ... } from '@originals/auth/client'`

---

## Direct Auth Proxy Functions

These functions call Turnkey directly via the auth proxy.

### `initializeTurnkeyClient()`

Initialize Turnkey client for browser use.

```typescript
function initializeTurnkeyClient(): TurnkeyClient
```

**Environment Variables Required:**
- `VITE_TURNKEY_AUTH_PROXY_CONFIG_ID`
- `VITE_TURNKEY_ORGANIZATION_ID`

---

### `initOtp(turnkeyClient, email)`

Send OTP code to email via Turnkey auth proxy.

```typescript
function initOtp(
  turnkeyClient: TurnkeyClient,
  email: string
): Promise<string>  // Returns OTP ID
```

---

### `completeOtp(turnkeyClient, otpId, otpCode, email)`

Verify OTP and establish session with Turnkey.

```typescript
function completeOtp(
  turnkeyClient: TurnkeyClient,
  otpId: string,
  otpCode: string,
  email: string
): Promise<{
  sessionToken: string;
  userId: string;
  action: 'login' | 'signup';
}>
```

---

### `fetchUser(turnkeyClient, onExpired?)`

Fetch current user information.

```typescript
function fetchUser(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<unknown>
```

---

### `fetchWallets(turnkeyClient, onExpired?)`

Fetch user's wallets with account details.

```typescript
function fetchWallets(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet[]>
```

**Returns:**
```typescript
interface TurnkeyWallet {
  walletId: string;
  walletName: string;
  accounts: TurnkeyWalletAccount[];
}

interface TurnkeyWalletAccount {
  address: string;
  curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
  path: string;
  addressFormat: string;
}
```

---

### `getKeyByCurve(wallets, curve)`

Find account by cryptographic curve.

```typescript
function getKeyByCurve(
  wallets: TurnkeyWallet[],
  curve: 'CURVE_SECP256K1' | 'CURVE_ED25519'
): WalletAccount | null
```

---

### `createWalletWithAccounts(turnkeyClient, onExpired?)`

Create new wallet with required accounts for DID creation.

```typescript
function createWalletWithAccounts(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet>
```

Creates wallet with:
- 1x CURVE_SECP256K1 account (Bitcoin)
- 2x CURVE_ED25519 accounts (DID signing)

---

### `ensureWalletWithAccounts(turnkeyClient, onExpired?)`

Ensure user has required accounts, creating if needed.

```typescript
function ensureWalletWithAccounts(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet[]>
```

---

## Server-Proxied Auth Functions

These functions call YOUR server endpoints (not Turnkey directly).

### `sendOtp(email, endpoint?, options?)`

Send OTP via your server endpoint.

```typescript
function sendOtp(
  email: string,
  endpoint?: string,  // Default: '/api/auth/send-otp'
  options?: ServerAuthOptions
): Promise<InitiateAuthResult>
```

**Returns:**
```typescript
interface InitiateAuthResult {
  sessionId: string;
  message: string;
}
```

**Options:**
```typescript
interface ServerAuthOptions {
  fetch?: typeof fetch;  // Custom fetch for testing
}
```

**Server Endpoint Contract:**
```typescript
// POST /api/auth/send-otp
// Body: { email: string }
// Response: { sessionId: string, message: string }
```

---

### `verifyOtp(sessionId, code, endpoint?, options?)`

Verify OTP via your server endpoint.

```typescript
function verifyOtp(
  sessionId: string,
  code: string,
  endpoint?: string,  // Default: '/api/auth/verify-otp'
  options?: ServerAuthOptions
): Promise<VerifyAuthResult>
```

**Returns:**
```typescript
interface VerifyAuthResult {
  verified: boolean;
  email: string;
  subOrgId: string;
}
```

**Server Endpoint Contract:**
```typescript
// POST /api/auth/verify-otp
// Body: { sessionId: string, code: string }
// Response: { verified: boolean, email: string, subOrgId: string }
```

---

## Session Expiration Handling

### `TurnkeySessionExpiredError`

Error thrown when Turnkey session has expired.

```typescript
class TurnkeySessionExpiredError extends Error {
  constructor(message?: string);
}
```

---

### `withTokenExpiration(fn, onExpired?)`

Wrapper to handle token expiration errors.

```typescript
function withTokenExpiration<T>(
  fn: () => Promise<T>,
  onExpired?: () => void
): Promise<T>
```

Detects expired API key errors and:
1. Calls `onExpired` callback if provided
2. Throws `TurnkeySessionExpiredError`

---

## DID Signing

### `TurnkeyDIDSigner`

Client-side signer for DID documents using Turnkey session.

```typescript
class TurnkeyDIDSigner {
  constructor(
    turnkeyClient: TurnkeyClient,
    walletAccount: WalletAccount,
    publicKeyMultibase: string,
    onExpired?: () => void
  );

  sign(input: SigningInput): Promise<SigningOutput>;
  getVerificationMethodId(): string;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
}
```

---

### `createDIDWithTurnkey(params)`

Create a DID:WebVH using Turnkey for signing.

```typescript
function createDIDWithTurnkey(params: {
  turnkeyClient: TurnkeyClient;
  updateKeyAccount: WalletAccount;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  domain: string;
  slug: string;
  onExpired?: () => void;
}): Promise<{
  did: string;
  didDocument: unknown;
  didLog: unknown;
}>
```

---

## Usage Examples

### Direct Auth Proxy Flow

```typescript
import {
  initializeTurnkeyClient,
  initOtp,
  completeOtp,
  ensureWalletWithAccounts,
  TurnkeySessionExpiredError
} from '@originals/auth/client';

// Initialize
const client = initializeTurnkeyClient();

// Send OTP
const otpId = await initOtp(client, 'user@example.com');

// Verify OTP
const { sessionToken, action } = await completeOtp(client, otpId, '123456', 'user@example.com');

// Ensure wallet exists
const wallets = await ensureWalletWithAccounts(client, () => {
  // Session expired, redirect to login
  window.location.href = '/login';
});
```

### Server-Proxied Flow

```typescript
import { sendOtp, verifyOtp } from '@originals/auth/client';

// Send OTP (calls your server)
const { sessionId } = await sendOtp('user@example.com');

// Verify OTP (calls your server)
const { verified, email, subOrgId } = await verifyOtp(sessionId, '123456');

if (verified) {
  // User authenticated, server may have set a JWT cookie
  window.location.href = '/dashboard';
}
```
