# Privy to Turnkey Migration Guide

## Executive Summary

This document describes the migration from Privy to Turnkey for key management and authentication in the Originals SDK Explorer application.

## Migration Prompt (For Claude Code)

```
Migrate the originals-explorer application from Privy to Turnkey for key management and authentication.

CONTEXT:
The application currently uses Privy (@privy-io/react-auth, @privy-io/node) for:
1. User authentication (email, wallet, Google OAuth)
2. Wallet creation and management (Stellar wallets with Ed25519 keys)
3. Cryptographic signing for DID:WebVH operations
4. Integration with didwebvh-ts through PrivyWebVHSigner (ExternalSigner implementation)

OBJECTIVE:
Replace Privy with Turnkey (https://docs.turnkey.com) while maintaining all existing authentication flows and DID:WebVH functionality.

COMPLETED WORK:
✅ Updated package.json dependencies (Privy removed, Turnkey added)
✅ Updated .env.example with Turnkey configuration variables
✅ Created TurnkeyWebVHSigner implementing ExternalSigner interface
✅ Updated did-webvh-service.ts to use Turnkey for DID creation
✅ Updated database schema (replaced Privy wallet IDs with Turnkey key IDs)
✅ Updated storage.ts (replaced getUserByPrivyId with getUserByTurnkeyId)

REMAINING TASKS:

1. **Update Server Authentication (routes.ts)**
   - Replace PrivyClient initialization with Turnkey SDK
   - Update authenticateUser middleware to verify Turnkey sessions/tokens
   - Update DID creation flow in authentication middleware
   - Replace Privy token verification with Turnkey authentication

2. **Update Database Layer (db.ts)**
   - Update DatabaseStorage class to match MemStorage changes
   - Replace getUserByPrivyId with getUserByTurnkeyId in SQL queries
   - Update schema references from authWalletId to authKeyId, etc.

3. **Update Client-Side Authentication**
   - **App.tsx**: Replace PrivyProvider with TurnkeyProvider from @turnkey/sdk-react
   - **useAuth.ts**: Replace usePrivy() with useTurnkey() hook
   - Map authentication methods (email, passkeys, OAuth)
   - Update token/session management

4. **Update UI Pages**
   - **login.tsx**: Update login UI for Turnkey authentication flows
   - **dashboard.tsx**: Update to use Turnkey user context
   - **profile.tsx**: Update user profile display

5. **Update Tests**
   - Rename privy-signer.test.ts → turnkey-signer.test.ts
   - Update test mocks for Turnkey API
   - Update integration tests for new authentication flow

6. **Install Dependencies and Verify**
   - Run `npm install` or `bun install`
   - Fix any TypeScript compilation errors
   - Run tests: `npm test`
   - Verify build: `npm run build`

7. **Create Migration Script (Optional)**
   - Script to migrate existing Privy users to Turnkey
   - Map Privy user IDs to Turnkey sub-organizations

KEY TECHNICAL NOTES:
- Turnkey uses sub-organizations for user isolation (one per user)
- Each sub-org contains the user's private keys
- Authentication uses passkeys, email OTP, or OAuth (similar to Privy)
- Server operations require API key stamper for Turnkey API auth
- Signing uses signRawPayload() instead of Privy's rawSign()
- Keys are Ed25519 (CURVE_ED25519) compatible with stellar wallets
- Must maintain ExternalSigner interface compatibility for didwebvh-ts
```

---

## Detailed Migration Status

### ✅ Completed Changes

#### 1. Package Dependencies (`package.json`)
**Removed:**
- `@privy-io/react-auth: ^2.24.0`
- `@privy-io/node: ^0.2.0`

**Added:**
- `@turnkey/http: ^2.15.1`
- `@turnkey/api-key-stamper: ^0.6.1`
- `@turnkey/sdk-server: ^0.4.1`
- `@turnkey/sdk-react: ^0.21.1`
- `@turnkey/sdk-browser: ^1.7.1`

#### 2. Environment Variables (`.env.example`)
**Before:**
```env
PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret
PRIVY_EMBEDDED_WALLET_POLICY_IDS=policy_id_1,policy_id_2
```

**After:**
```env
TURNKEY_ORGANIZATION_ID=your_turnkey_org_id
TURNKEY_API_PUBLIC_KEY=your_api_public_key
TURNKEY_API_PRIVATE_KEY=your_api_private_key
VITE_TURNKEY_ORGANIZATION_ID=your_turnkey_org_id
```

#### 3. New File: `turnkey-signer.ts`
Created `TurnkeyWebVHSigner` class that:
- Implements `ExternalSigner` and `ExternalVerifier` interfaces
- Uses Turnkey's `signRawPayload` API for signing
- Handles Ed25519 key operations
- Provides `createTurnkeySigner()` factory function
- Provides `createVerificationMethodsFromTurnkey()` for DID setup

**Key Methods:**
```typescript
class TurnkeyWebVHSigner {
  async sign(input): Promise<{ proofValue: string }>
  async verify(signature, message, publicKey): Promise<boolean>
  getVerificationMethodId(): string
  getPublicKeyMultibase(): string
}
```

#### 4. Updated: `did-webvh-service.ts`
**Changes:**
- Replaced `PrivyClient` import with `Turnkey`
- Replaced `createVerificationMethodsFromPrivy` with `createVerificationMethodsFromTurnkey`
- Replaced `createPrivySigner` with `createTurnkeySigner`
- Updated function signature: `createUserDIDWebVH(organizationId, turnkeyClient, domain)`
- Updated `DIDWebVHCreationResult` interface to use `authKeyId` instead of `authWalletId`

#### 5. Updated: `schema.ts` (Database Schema)
**Field Changes:**
```typescript
// BEFORE (Privy)
authWalletId: text("auth_wallet_id")
assertionWalletId: text("assertion_wallet_id")
updateWalletId: text("update_wallet_id")

// AFTER (Turnkey)
turnkeyUserId: text("turnkey_user_id").unique()
authKeyId: text("auth_key_id")
assertionKeyId: text("assertion_key_id")
updateKeyId: text("update_key_id")
```

#### 6. Updated: `storage.ts`
**Interface Changes:**
- `getUserByPrivyId()` → `getUserByTurnkeyId()`
- `createUserWithDid(privyUserId, ...)` → `createUserWithDid(turnkeyUserId, ...)`

**Implementation Changes:**
- `privyToDidMapping` → `turnkeyToDidMapping`
- Updated `createUser()` to include `turnkeyUserId` field
- Updated `ensureUser()` to use Turnkey IDs
- Updated `createUserWithDid()` to use `authKeyId` instead of `authWalletId`

---

### 🚧 Remaining Work

#### 1. Server-Side Authentication (`routes.ts`)
**Current Code:**
```typescript
const privyClient = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!
});

const authenticateUser = async (req, res, next) => {
  const token = authorizationHeader.substring(7);
  const verifiedClaims = await privyClient.utils().auth().verifyAuthToken(token);
  let user = await storage.getUserByPrivyId(verifiedClaims.user_id);
  // ...
}
```

**Needed Changes:**
```typescript
import { Turnkey } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";

const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
});

const authenticateUser = async (req, res, next) => {
  // Verify Turnkey session/token
  // Get user's sub-organization ID from session
  // Check if user exists: storage.getUserByTurnkeyId(subOrgId)
  // If not, create DID using createUserDIDWebVH(subOrgId, turnkeyClient)
}
```

#### 2. Database Implementation (`db.ts`)
Need to find and update `DatabaseStorage` class:
- Replace SQL queries using `privy_id` with `turnkey_user_id`
- Update column references from `auth_wallet_id` to `auth_key_id`
- Update the `getUserByPrivyId` query to `getUserByTurnkeyId`

#### 3. Client-Side React Code

**File: `client/src/App.tsx`**
```typescript
// BEFORE
import { PrivyProvider } from "@privy-io/react-auth";

<PrivyProvider
  appId={import.meta.env.VITE_PRIVY_APP_ID}
  config={{...}}
>

// AFTER
import { TurnkeyProvider } from "@turnkey/sdk-react";

<TurnkeyProvider
  config={{
    apiBaseUrl: "https://api.turnkey.com",
    organizationId: import.meta.env.VITE_TURNKEY_ORGANIZATION_ID,
  }}
>
```

**File: `client/src/hooks/useAuth.ts`**
```typescript
// BEFORE
import { usePrivy } from "@privy-io/react-auth";

export function useAuth() {
  const { login, logout, user, getAccessToken } = usePrivy();
  // ...
}

// AFTER
import { useTurnkey } from "@turnkey/sdk-react";

export function useAuth() {
  const { authIframeClient, getActiveClient } = useTurnkey();
  // Implement login/logout using Turnkey's auth flows
  // Handle email authentication, passkeys, or OAuth
}
```

**File: `client/src/pages/login.tsx`**
- Update login UI to use Turnkey authentication components
- Replace Privy login methods with Turnkey equivalents:
  - Email → Turnkey email auth
  - Google OAuth → Turnkey OAuth
  - Wallet connect → Turnkey passkey/wallet auth

#### 4. Testing Updates

**File: `server/__tests__/turnkey-signer.test.ts` (rename from privy-signer.test.ts)**
```typescript
// Mock Turnkey SDK
jest.mock("@turnkey/sdk-server");

describe("TurnkeyWebVHSigner", () => {
  it("should sign data using Turnkey API", async () => {
    // Test signing flow
  });

  it("should verify signatures correctly", async () => {
    // Test verification
  });
});
```

---

## Architecture Comparison

### Privy Architecture (Before)
```
User Login (PrivyProvider)
    ↓
Privy JWT Token
    ↓
Server: privyClient.verifyAuthToken()
    ↓
Get Privy User ID
    ↓
Create/Get Stellar Wallets
    ↓
PrivyWebVHSigner (uses Privy rawSign API)
    ↓
DID:WebVH Creation
```

### Turnkey Architecture (After)
```
User Login (TurnkeyProvider)
    ↓
Turnkey Session/Token
    ↓
Server: Verify Turnkey session
    ↓
Get Turnkey Sub-Organization ID
    ↓
Create/Get Ed25519 Private Keys
    ↓
TurnkeyWebVHSigner (uses signRawPayload API)
    ↓
DID:WebVH Creation
```

---

## Key Differences: Privy vs Turnkey

| Feature | Privy | Turnkey |
|---------|-------|---------|
| **Key Storage** | Embedded wallets | Private keys in TEE enclaves |
| **User Isolation** | User IDs | Sub-organizations |
| **Authentication** | JWT tokens | Sessions/API keys |
| **Signing API** | `wallets().rawSign()` | `signRawPayload()` |
| **Key Types** | Stellar/Bitcoin wallets | Private keys (any curve) |
| **Client SDK** | `@privy-io/react-auth` | `@turnkey/sdk-react` |
| **Server SDK** | `@privy-io/node` | `@turnkey/sdk-server` |
| **Policy Engine** | Wallet policies | Activity policies |

---

## Migration Checklist

- [x] Update package.json dependencies
- [x] Update environment variables
- [x] Create TurnkeyWebVHSigner
- [x] Update did-webvh-service.ts
- [x] Update database schema
- [x] Update storage.ts interface
- [ ] Update routes.ts authentication
- [ ] Update db.ts implementation
- [ ] Update App.tsx (TurnkeyProvider)
- [ ] Update useAuth.ts hook
- [ ] Update login.tsx page
- [ ] Update dashboard.tsx page
- [ ] Update profile.tsx page
- [ ] Update tests
- [ ] Install dependencies
- [ ] Fix TypeScript errors
- [ ] Run test suite
- [ ] Verify build
- [ ] Test authentication flow
- [ ] Test DID creation
- [ ] Test asset signing

---

## Testing Strategy

### Unit Tests
1. Test `TurnkeyWebVHSigner.sign()` with mocked Turnkey API
2. Test `TurnkeyWebVHSigner.verify()` with known signatures
3. Test `createTurnkeySigner()` factory function
4. Test `createVerificationMethodsFromTurnkey()`

### Integration Tests
1. Test full authentication flow (login → DID creation)
2. Test asset creation with Turnkey signer
3. Test publishing to web layer (signing credentials)
4. Test DID resolution

### Manual Testing
1. Register new user with email
2. Verify DID:WebVH is created
3. Create an asset
4. Publish asset to web layer
5. Verify signature is valid

---

## Rollback Plan

If migration fails, rollback by:
```bash
git checkout HEAD~1  # Go back one commit
npm install          # Reinstall Privy dependencies
```

---

## Next Steps

1. **Install Turnkey Dependencies**
   ```bash
   cd apps/originals-explorer
   npm install
   # or
   bun install
   ```

2. **Set Up Turnkey Account**
   - Create account at https://app.turnkey.com
   - Create an organization
   - Generate API keys
   - Update .env with credentials

3. **Complete Remaining Code Changes**
   - Follow the "Remaining Work" section above
   - Test each component as you update it

4. **Run Tests**
   ```bash
   npm test
   npm run check  # TypeScript type checking
   npm run build  # Production build
   ```

5. **Deploy**
   - Test in development environment first
   - Migrate existing users (if any)
   - Deploy to production

---

## Support Resources

- **Turnkey Documentation**: https://docs.turnkey.com
- **Turnkey API Reference**: https://docs.turnkey.com/api
- **Turnkey SDK Examples**: https://github.com/tkhq/sdk
- **Originals SDK**: Check DIDManager.ts for ExternalSigner interface

---

## Migration Timeline Estimate

| Task | Estimated Time |
|------|---------------|
| Server authentication (routes.ts) | 2-3 hours |
| Database layer (db.ts) | 1-2 hours |
| Client-side auth (App.tsx, useAuth.ts) | 2-3 hours |
| UI updates (login, dashboard) | 1-2 hours |
| Testing and fixes | 2-4 hours |
| **Total** | **8-14 hours** |

---

*This migration guide generated by Claude Code on 2025-10-21*
