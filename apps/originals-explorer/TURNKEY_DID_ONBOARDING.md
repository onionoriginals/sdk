# Turnkey DID Onboarding Flow

This document details the cryptographic operations and DID creation flow for user onboarding with Turnkey key management.

## Overview

The Originals Explorer uses **browser-based signing** with Turnkey for non-custodial DID creation. All private keys are managed by Turnkey and never touch the server. The DID creation process uses **didwebvh-ts** for verification and follows W3C DID standards.

## Architecture

### Key Components

1. **Frontend (`client/src/`)**
   - `contexts/TurnkeySessionContext.tsx` - Global Turnkey session management
   - `lib/turnkey-client.ts` - Turnkey client initialization and wallet management
   - `lib/turnkey-did-signer.ts` - Adapter for Turnkey signing with didwebvh-ts
   - `lib/key-utils.ts` - Multibase key encoding utilities
   - `lib/turnkey-error-handler.ts` - Session expiration detection

2. **Backend (`server/`)**
   - `routes-did.ts` - DID submission and verification endpoints
   - `routes.ts` - Authentication middleware with temporary DID creation
   - `storage.ts` - User and DID persistence
   - `webvh-integration.ts` - Filesystem DID log storage

### Data Flow

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   Browser   │─────▶│  Turnkey API │─────▶│   Server    │
│  (Signing)  │      │ (Key Mgmt)   │      │(Verify+Store)│
└─────────────┘      └──────────────┘      └─────────────┘
      │                                            │
      │                                            ▼
      │                                     ┌─────────────┐
      │                                     │  Database   │
      │                                     │  + did.jsonl│
      └─────────────────────────────────────▶ Filesystem  │
           (Submit complete DID log)         └─────────────┘
```

## User Onboarding Flow

### Phase 1: Authentication (OTP)

1. **User enters email** (`pages/login.tsx`)
   - Calls `POST /api/auth/initiate` to send OTP code

2. **User enters OTP code**
   - Frontend calls Turnkey's `completeOtp()` which:
     - Verifies the code
     - Creates Turnkey sub-organization (if new user)
     - Returns session token + userId

3. **Session establishment**
   - Frontend calls `POST /api/auth/exchange-session` with Turnkey session token
   - Server creates JWT with Turnkey sub-org ID and session token
   - JWT stored in HTTP-only cookie

4. **Temporary user creation** (`routes.ts:authenticateUser`)
   - If user doesn't exist in database, create with temporary DID:
     ```typescript
     const temporaryDid = `temp:turnkey:${turnkeySubOrgId}`;
     ```
   - All key fields set to `null` (keys created later during DID creation)

### Phase 2: Wallet Creation

5. **Create Turnkey wallets** (`lib/turnkey-client.ts:ensureWalletWithAccounts`)
   - Check if user has existing wallets
   - If none, create wallet with 3 accounts:
     - **Auth Key**: `CURVE_SECP256K1` (Bitcoin path `m/44'/0'/0'/0/0`)
     - **Assertion Key**: `CURVE_ED25519` (Solana path `m/44'/501'/0'/0'`)
     - **Update Key**: `CURVE_ED25519` (Solana path `m/44'/501'/1'/0'`)

6. **Extract public keys** (`lib/key-utils.ts:extractKeysFromWallets`)
   - Convert Turnkey's hex-encoded keys to multibase format
   - Use SDK's `multikey.encodePublicKey(publicKeyBytes, keyType)`
   - Result: `z...` (base58btc-encoded with multicodec prefix)

### Phase 3: DID Creation

7. **Create DID log with Turnkey signing** (`lib/turnkey-did-signer.ts:createDIDWithTurnkey`)

   ```typescript
   // Create signer adapter
   const signer = new TurnkeyDIDSigner(
     turnkeyClient,
     updateKeyAccount, // Second Ed25519 key
     updateKeyPublic,
     onExpired
   );

   // Use Originals SDK which wraps didwebvh-ts
   const result = await OriginalsSDK.createDIDOriginal({
     type: 'did',
     domain: window.location.host,
     signer,              // For signing proofs
     verifier: signer,    // For browser-side verification
     updateKeys: [signer.getVerificationMethodId()],
     verificationMethods: [
       { id: '#key-0', publicKeyMultibase: authKeyPublic },     // Secp256k1
       { id: '#key-1', publicKeyMultibase: assertionKeyPublic } // Ed25519
     ],
     paths: [userSlug],
     portable: false,
     authentication: ['#key-0'],
     assertionMethod: ['#key-1'],
   });
   ```

   **What happens inside:**
   - didwebvh-ts creates DID document
   - Calls `signer.sign()` to create proof:
     1. `OriginalsSDK.prepareDIDDataForSigning()` canonicalizes data
     2. Turnkey signs with update key via `signRawPayload()`
     3. Signature (r+s, 64 bytes) encoded as multibase: `z...`
   - Returns: `{ did, didDocument, didLog }`

8. **Submit to backend** (`pages/profile.tsx`)
   - `POST /api/did/submit-log` with `{ did, didDocument, didLog }`

### Phase 4: Server Verification & Storage

9. **Verify DID log** (`server/routes-did.ts:POST /api/did/submit-log`)

   ```typescript
   // Create Ed25519 verifier (from SDK)
   const verifier = new Ed25519Verifier();

   // Verify using didwebvh-ts
   const isValid = await resolveDIDFromLog(didLog, { verifier });
   if (!isValid) {
     return res.status(400).json({ error: "Invalid DID log" });
   }
   ```

10. **Extract and persist keys** (`routes-did.ts`)
    - Extract auth and assertion keys from `didDocument.verificationMethod`
    - Extract update key from `didLog[0].proof[0].verificationMethod`
    - Store all three keys in database

11. **Migrate from temporary to real DID** (`storage.ts:createUserWithDid`)
    ```typescript
    // Create new user entry with real DID as primary key
    this.users.set(did, user);

    // Create Turnkey ID → DID mapping
    this.turnkeyToDidMapping.set(turnkeySubOrgId, did);

    // Delete temporary user record
    this.users.delete(temporaryDid);
    ```

12. **Save to filesystem** (`webvh-integration.ts`)
    - Write DID log to `.well-known/did.jsonl` for web resolution
    - Format: JSONL (newline-delimited JSON)

## Cryptographic Details

### Key Types and Usage

| Key | Curve | Format | Purpose | Path |
|-----|-------|--------|---------|------|
| Auth | Secp256k1 | Multikey (z...) | Authentication | `m/44'/0'/0'/0/0` |
| Assertion | Ed25519 | Multikey (z...) | Credential signing | `m/44'/501'/0'/0'` |
| Update | Ed25519 | Multikey (z...) | DID document updates | `m/44'/501'/1'/0'` |

### Signature Encoding

**All signatures use multibase base58btc encoding:**

```typescript
// Turnkey returns: { r: '0x...', s: '0x...' }
const signatureBytes = Buffer.from(cleanR + cleanS, 'hex'); // 64 bytes for Ed25519
const proofValue = encoding.multibase.encode(signatureBytes, 'base58btc'); // 'z...'
```

**Encoding standard:**
- Keys: `z` + base58btc(multicodec prefix + public key bytes)
- Signatures: `z` + base58btc(signature bytes)
- No hex or '0x' prefixes in stored data

### Signing Process (TurnkeyDIDSigner)

```typescript
async sign(input: SigningInput): Promise<SigningOutput> {
  // 1. Canonicalize data using didwebvh-ts
  const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(
    input.document,
    input.proof
  );

  // 2. Sign with Turnkey (happens in Turnkey's infrastructure)
  const response = await turnkeyClient.httpClient.signRawPayload({
    signWith: walletAccount.address,
    payload: Buffer.from(dataToSign).toString('hex'),
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE', // Pre-hashed
  });

  // 3. Extract r+s (ignore v for Ed25519)
  const signatureBytes = Buffer.from(cleanR + cleanS, 'hex');

  // 4. Validate length (Ed25519 = 64 bytes)
  if (signatureBytes.length !== 64) {
    throw new Error('Invalid signature length');
  }

  // 5. Encode as multibase
  return { proofValue: encoding.multibase.encode(signatureBytes, 'base58btc') };
}
```

### Verification Process (Ed25519Verifier)

```typescript
// Server-side verification (routes-did.ts)
const verifier = new Ed25519Verifier();
const isValid = await resolveDIDFromLog(didLog, { verifier });

// Under the hood (SDK Ed25519Verifier):
async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
  return ed25519.verify(signature, message, publicKey); // @noble/curves
}
```

## Session Management

### Token Expiration Handling

Turnkey session tokens can expire. The system detects expiration and redirects to login:

```typescript
// Error patterns that indicate expiration
const expiredPatterns = [
  'unauthorized', 'invalid session', 'session expired',
  'token expired', 'invalid token', 'authentication failed',
  '401', '403', 'api_key_expired', '"code":16'
];

// Wrapped around all Turnkey API calls
async function withTokenExpiration<T>(
  operation: () => Promise<T>,
  onExpired?: () => void
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTokenExpiredError(error)) {
      if (onExpired) onExpired();
      throw new TurnkeySessionExpiredError();
    }
    throw error;
  }
}
```

### Session Persistence

**Frontend:**
- Turnkey session data stored in `sessionStorage` (not `localStorage`)
- Data: `{ sessionToken, email, wallets, isAuthenticated }`
- `TurnkeyClient` **cannot** be serialized - recreated from sessionToken on mount

**Backend:**
- JWT stored in HTTP-only cookie (secure against XSS)
- JWT payload: `{ sub: turnkeySubOrgId, email, sessionToken }`
- User's Turnkey session token passed through for API calls

## Error Handling

### Common Failure Scenarios

1. **Missing wallets**
   - Symptom: "No wallets found" error
   - Cause: User created before wallet creation implemented
   - Fix: Call `ensureWalletWithAccounts()` to create missing wallets

2. **Invalid signature length**
   - Symptom: "Invalid Ed25519 signature length: X (expected 64 bytes)"
   - Cause: Incorrect r+s concatenation or v component included
   - Fix: Ensure only r+s combined (no v for Ed25519)

3. **DID verification failed**
   - Symptom: "Invalid DID log: verification failed"
   - Cause: Signature doesn't match, wrong key used, or tampered log
   - Fix: Check update key matches proof's verificationMethod

4. **Session expired**
   - Symptom: 401/403 errors from Turnkey API
   - Cause: Turnkey session token expired (typically after 15-60 minutes)
   - Fix: Automatic redirect to `/login?reason=session_expired`

5. **Key extraction failure**
   - Symptom: Null keys in database after DID creation
   - Cause: Keys not extracted from DID document
   - Fix: Extract from `verificationMethod` array and DID log proof

## Testing Checklist

### DID Creation Flow

- [ ] New user can log in with OTP
- [ ] Temporary DID created on first login
- [ ] Wallets created with 3 accounts (Secp256k1 + 2x Ed25519)
- [ ] Keys extracted and multibase-encoded correctly
- [ ] DID document created and signed with update key
- [ ] DID log verification passes on server
- [ ] Auth, assertion, and update keys persisted to database
- [ ] Temporary user migrated to real DID (old record deleted)
- [ ] DID log saved to `.well-known/did.jsonl`
- [ ] User can view DID on profile page

### Error Scenarios

- [ ] Expired session detected and redirected to login
- [ ] Missing wallets auto-created on DID creation attempt
- [ ] Invalid signature rejected by server
- [ ] Tampered DID log rejected
- [ ] Network failures handled gracefully

### Verification

- [ ] DID resolves via HTTP at `https://{domain}/{slug}/did.jsonl`
- [ ] Signature verification succeeds with extracted keys
- [ ] Keys match between database and DID document
- [ ] No null keys in database for completed onboarding

## Security Considerations

### Private Key Management

- **Private keys NEVER leave Turnkey** - signing happens server-side at Turnkey
- Frontend only receives public keys and session tokens
- Server never has access to private keys
- Session tokens expire and require re-authentication

### Authentication

- **HTTP-only cookies** prevent XSS attacks on JWT
- **OTP via email** for passwordless authentication
- **Turnkey sub-org per user** for isolation
- **Session tokens** scoped to user's Turnkey sub-org

### DID Integrity

- **Cryptographic proofs** verify DID log integrity
- **didwebvh-ts verification** ensures signatures match
- **Multibase encoding** prevents encoding ambiguity
- **Server-side verification** before database storage

## Maintenance

### Key Rotation (Future)

To rotate keys:
1. Create new wallet account in Turnkey
2. Convert new public key to multibase
3. Call didwebvh-ts to create DID log update entry
4. Sign update with current update key
5. Submit new log entry to server
6. Update database with new key

### Debugging

**Enable verbose logging:**
```typescript
// Frontend
console.log('Turnkey session:', turnkeySession);
console.log('Wallets:', wallets);
console.log('DID log before submit:', didLog);

// Backend
console.log('[DID submission] Verifying log:', didLog);
console.log('[DID submission] Extracted keys:', { authKey, assertionKey, updateKey });
```

**Common log messages:**
- `Creating user record for {email}` - New user, temporary DID created
- `Migrating user from temporary DID` - DID creation successful
- `Turnkey session expired` - Token expiration detected
- `No wallets found` - Wallet creation needed

## References

- [Turnkey Documentation](https://docs.turnkey.com/)
- [didwebvh-ts GitHub](https://github.com/onion-originals/didwebvh-ts)
- [W3C DID Core](https://www.w3.org/TR/did-core/)
- [Data Integrity Proofs](https://www.w3.org/TR/vc-data-integrity/)
- [Multikey Specification](https://w3c-ccg.github.io/di-multikey/)
