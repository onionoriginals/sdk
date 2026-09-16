# Client API Reference

Import: `import { ... } from '@originals/auth/client'`

---

## Low-Level Turnkey Functions (server-side only)

**`initializeTurnkeyClient()` has been removed.** It read server-grade org
API secrets and has unconditionally thrown since it was pulled out of the
client bundle for that reason; it is not a working entry point despite still
being exported (as a throw-only compatibility shim). There is no supported
way to talk to Turnkey directly from the browser — use the
[Server-Proxied Auth Functions](#server-proxied-auth-functions) below for
browser-side code.

Most functions in this section call Turnkey directly and take a `Turnkey`
client instance plus a `subOrgId` (required, except `initOtp`'s, which is
optional — see below). They are for your own server code: obtain the
client from `createTurnkeyClient()` (`@originals/auth/server`, which holds
the org API secret) and pass the sub-organization ID returned by
`verifyEmailAuth`/`initiateEmailAuth`. `getKeyByCurve` and `getKeyByRole`
are the exception — pure lookups over an already-fetched `TurnkeyWallet[]`,
with no `Turnkey` client or `subOrgId` involved.

### `initOtp(turnkeyClient, email, subOrgId?)`

Send OTP code to email via Turnkey (Turnkey v6 encrypted-bundle flow).

```typescript
function initOtp(
  turnkeyClient: Turnkey,
  email: string,
  subOrgId?: string  // Omit to run under the parent (default) org
): Promise<{
  otpId: string;
  otpEncryptionTargetBundle: string;  // Required by completeOtp
}>
```

---

### `completeOtp(turnkeyClient, otpId, otpCode, subOrgId, otpEncryptionTargetBundle, options?)`

Verify an OTP code by encrypting it to the target bundle from `initOtp` and
submitting it to Turnkey (Turnkey v6 no longer accepts plaintext codes).

```typescript
function completeOtp(
  turnkeyClient: Turnkey,
  otpId: string,
  otpCode: string,
  subOrgId: string,               // Echoed back in the result, for otpLogin
  otpEncryptionTargetBundle: string,  // From initOtp's result
  options?: {
    publicKey?: string;            // Client P-256 public key to bind the token to
    organizationId?: string;       // Must match initOtp's org context, if overridden
    dangerouslyOverrideSignerPublicKey?: string;  // Tests/non-prod only
  }
): Promise<{
  verificationToken: string;
  subOrgId: string;
  publicKey: string;
  privateKey?: string;  // Present only when `options.publicKey` was omitted
}>
```

---

### `fetchUser(turnkeyClient, subOrgId, onExpired?)`

Fetch current user information.

```typescript
function fetchUser(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<unknown>
```

---

### `fetchWallets(turnkeyClient, subOrgId, onExpired?)`

Fetch user's wallets with account details.

```typescript
function fetchWallets(
  turnkeyClient: Turnkey,
  subOrgId: string,
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

Returns the **first** account matching `curve`, in wallet/account order. The
wallet layout below provisions two `CURVE_ED25519` accounts (DID
assertion-key and update-key), so for `CURVE_ED25519` this returns whichever
of the two happens to come first in the API response — not reliably the
assertion-key, since account order is not a guaranteed contract — and there
is no way to select the other one through this function. Use `getKeyByRole`
to select a specific DID-signing account by its exact role instead.

---

### `getKeyByRole(wallets, role)`

Find an account by its canonical role — curve **and** exact derivation
path, not curve alone. Use this to distinguish the DID assertion-key from
the update-key.

```typescript
type TurnkeyAccountRole = 'bitcoin-auth' | 'did-assertion' | 'did-update';

function getKeyByRole(
  wallets: TurnkeyWallet[],
  role: TurnkeyAccountRole
): WalletAccount | null
```

| Role | Curve | Path |
|---|---|---|
| `bitcoin-auth` | `CURVE_SECP256K1` | `m/44'/0'/0'/0/0` |
| `did-assertion` | `CURVE_ED25519` | `m/44'/501'/0'/0'` |
| `did-update` | `CURVE_ED25519` | `m/44'/501'/1'/0'` |

Returns `null` if no account exists at that role's exact curve + path —
it never guesses by returning an arbitrary same-curve account. This table
is also exported as `TURNKEY_ACCOUNT_ROLES`.

---

### `createWalletWithAccounts(turnkeyClient, subOrgId, onExpired?)`

Create new wallet with required accounts for DID creation.

```typescript
function createWalletWithAccounts(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<TurnkeyWallet>
```

Creates wallet with:
- 1x CURVE_SECP256K1 account (Bitcoin)
- 2x CURVE_ED25519 accounts (DID signing)

---

### `ensureWalletWithAccounts(turnkeyClient, subOrgId, onExpired?)`

Ensure user has required accounts, creating if needed.

```typescript
function ensureWalletWithAccounts(
  turnkeyClient: Turnkey,
  subOrgId: string,
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
  options?: VerifyOtpClientOptions
): Promise<VerifyAuthResult>
```

**Options:**
```typescript
interface VerifyOtpClientOptions extends ServerAuthOptions {
  /**
   * Compressed P-256 public key (hex) generated in the browser. The
   * verification token is bound to this key, so `privateKey` is never
   * present in the result. Strongly recommended: without it, the server
   * generates the keypair itself and must return the private key in the
   * response.
   */
  publicKey?: string;
}
```

**Returns:**
```typescript
interface VerifyAuthResult {
  verified: boolean;
  email: string;
  subOrgId: string;
  /** Consumed by a subsequent Turnkey `otpLogin` activity. */
  verificationToken?: string;
  /** The key the verification token is bound to. */
  publicKey?: string;
  /**
   * Present only when `options.publicKey` was omitted from the request —
   * the server generated the keypair and must return the private key here.
   * Sensitive: never log or persist insecurely.
   */
  privateKey?: string;
}
```

**Server Endpoint Contract:**
```typescript
// POST /api/auth/verify-otp
// Body: { sessionId: string, code: string, publicKey?: string }
// Response: VerifyAuthResult (see above) — the exact fields your endpoint
// returns depend on what it forwards from verifyEmailAuth()'s result.
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

### Server-Proxied Flow (browser-side, supported)

```typescript
import { sendOtp, verifyOtp } from '@originals/auth/client';

// Send OTP (calls your server)
const { sessionId } = await sendOtp('user@example.com');

// Verify OTP (calls your server). Pass a browser-generated publicKey so the
// verification token's private key never transits the response — see
// VerifyOtpClientOptions above.
const { verified, email, subOrgId } = await verifyOtp(sessionId, '123456', undefined, {
  publicKey: myP256PublicKeyHex,
});

if (verified) {
  // User authenticated, server may have set a JWT cookie
  window.location.href = '/dashboard';
}
```

### Low-Level Turnkey Flow (server-side only)

The Direct Auth Proxy flow this section previously documented required
`initializeTurnkeyClient()`, which has been removed (it read server-only org
API secrets). The functions below still exist for server code that already
holds a `Turnkey` client and a verified `subOrgId` — for example, a custom
`/api/auth/verify-otp` handler built on `@originals/auth/server`.

```typescript
import { createTurnkeyClient } from '@originals/auth/server';
import { initOtp, completeOtp, ensureWalletWithAccounts } from '@originals/auth/client';

const turnkeyClient = createTurnkeyClient();

// Send OTP
const { otpId, otpEncryptionTargetBundle } = await initOtp(turnkeyClient, 'user@example.com');

// Verify OTP (subOrgId comes from your own sub-org lookup/creation step)
const { verificationToken, publicKey } = await completeOtp(
  turnkeyClient,
  otpId,
  '123456',
  subOrgId,
  otpEncryptionTargetBundle
);

// Ensure wallet exists
const wallets = await ensureWalletWithAccounts(turnkeyClient, subOrgId, () => {
  // Session expired — this runs on your server; withTokenExpiration()
  // already throws TurnkeySessionExpiredError for the caller to catch, so
  // this callback is just a hook for side effects (e.g. logging).
  console.error(`Turnkey API key expired for subOrgId ${subOrgId}`);
});
```
