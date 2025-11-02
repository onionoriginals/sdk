# Migration to @turnkey/sdk-react

## Overview

We're migrating from `@turnkey/core` to `@turnkey/sdk-react` to leverage the official React SDK's built-in features and resolve signing/verification issues.

## Why Migrate?

1. **Official React Integration**: Built specifically for React apps
2. **Simpler API**: Uses React hooks and context patterns
3. **Better Session Management**: Automatic persistence and refresh
4. **Type Safety**: Better TypeScript support
5. **Maintained**: Official SDK is actively maintained by Turnkey

## Migration Steps

### ✅ 1. Update Dependencies

**Status**: COMPLETED

- Changed `@turnkey/core` to `@turnkey/sdk-react` in package.json
- Next: Run `bun install` to update lock file

### 🔄 2. Replace TurnkeySessionProvider

**Current**: `client/src/contexts/TurnkeySessionContext.tsx`
**New**: Use `TurnkeyProvider` from `@turnkey/sdk-react`

**Changes needed in `App.tsx`**:
```tsx
import { TurnkeyProvider } from '@turnkey/sdk-react';

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TurnkeyProvider
        config={{
          apiBaseUrl: import.meta.env.VITE_TURNKEY_API_BASE_URL || 'https://api.turnkey.com',
          defaultOrganizationId: import.meta.env.VITE_TURNKEY_ORGANIZATION_ID,
          // Auth iframe configuration
          authConfig: {
            iframeUrl: import.meta.env.VITE_TURNKEY_IFRAME_URL,
          }
        }}
      >
        <TooltipProvider>
          <AppContent />
        </TooltipProvider>
      </TurnkeyProvider>
    </QueryClientProvider>
  );
}
```

### 🔄 3. Update Login Flow

**Current**: `client/src/pages/login.tsx` uses `useTurnkeyAuth` custom hook
**New**: Use `useTurnkey` hook from SDK

**Changes needed**:
```tsx
import { useTurnkey } from '@turnkey/sdk-react';

export default function Login() {
  const turnkey = useTurnkey();

  // Email auth flow
  const handleEmailSubmit = async (email: string) => {
    // Step 1: Init email auth
    const response = await turnkey.initEmailAuth({
      email,
      targetPublicKey: turnkey.config.defaultOrganizationId,
    });

    // Store otpId for verification
    setOtpId(response.otpId);
  };

  const handleCodeSubmit = async (code: string) => {
    // Step 2: Verify OTP
    const session = await turnkey.emailAuth({
      otpId,
      otpCode: code,
      organizationId: turnkey.config.defaultOrganizationId,
    });

    // Session is automatically stored by SDK
    // Exchange for JWT cookie
    await apiRequest('POST', '/api/auth/exchange-session', {
      email,
      userId: session.userId,
      sessionToken: session.sessionToken,
    });
  };
}
```

### 🔄 4. Update DID Signing

**Current**: `client/src/lib/turnkey-did-signer.ts` manually creates Turnkey client
**New**: Use SDK's signing methods

**Changes needed**:
```tsx
import { useTurnkey } from '@turnkey/sdk-react';
import { OriginalsSDK } from '@originals/sdk';

// In component
const turnkey = useTurnkey();

// Create signer adapter
class TurnkeyReactSDKSigner {
  constructor(
    private turnkey: ReturnType<typeof useTurnkey>,
    private accountId: string,
    private publicKeyMultibase: string
  ) {}

  async sign(input: SigningInput): Promise<SigningOutput> {
    const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(
      input.document,
      input.proof
    );

    // Use SDK's signing method
    const signature = await this.turnkey.signRawPayload({
      organizationId: this.turnkey.config.defaultOrganizationId,
      signWith: this.accountId,
      payload: Buffer.from(dataToSign).toString('hex'),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });

    // Format signature for didwebvh-ts
    const proofValue = formatSignatureAsMultibase(signature);
    return { proofValue };
  }

  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
  }
}
```

### 🔄 5. Update Profile Page

**Current**: Uses `useTurnkeySession` custom hook
**New**: Use `useTurnkey` from SDK

**Changes needed in `client/src/pages/profile.tsx`**:
```tsx
import { useTurnkey } from '@turnkey/sdk-react';

export default function Profile() {
  const turnkey = useTurnkey();
  const { user } = useAuth();

  const handleCreateDid = async () => {
    if (!turnkey.currentUser) {
      toast({ title: "Not authenticated", variant: "destructive" });
      return;
    }

    // Get wallet accounts
    const wallets = await turnkey.getWallets();
    const accounts = await turnkey.getWalletAccounts(wallets[0].walletId);

    // Create DID using SDK signing
    const signer = new TurnkeyReactSDKSigner(
      turnkey,
      accounts[2].walletAccountId, // Update key
      keysData.updateKey
    );

    const { did, didDocument, didLog } = await createDIDWithTurnkey({
      signer,
      authKeyPublic: keysData.authKey,
      assertionKeyPublic: keysData.assertionKey,
      updateKeyPublic: keysData.updateKey,
      domain: window.location.host,
      slug: keysData.userSlug,
    });

    // Submit to backend
    await apiRequest('POST', '/api/did/submit-log', {
      did,
      didDocument,
      didLog,
    });
  };
}
```

### 🔄 6. Remove Old Files

Once migration is complete, delete:
- `client/src/contexts/TurnkeySessionContext.tsx`
- `client/src/hooks/useTurnkeyAuth.ts`
- `client/src/lib/turnkey-client.ts` (if fully replaced)

### 🔄 7. Update Environment Variables

Ensure these are set in `.env`:
```bash
VITE_TURNKEY_API_BASE_URL=https://api.turnkey.com
VITE_TURNKEY_ORGANIZATION_ID=your-org-id
VITE_TURNKEY_IFRAME_URL=https://auth.turnkey.com
VITE_TURNKEY_AUTH_PROXY_CONFIG_ID=your-config-id
```

## Testing Checklist

- [ ] Login with email OTP works
- [ ] Session persists across page refreshes
- [ ] DID creation with Turnkey signing works
- [ ] DID verification on backend passes
- [ ] Token expiration handled gracefully
- [ ] Logout clears session properly

## Rollback Plan

If migration fails:
1. Revert to commit before package.json change
2. Run `bun install` to restore old dependencies
3. Old code still exists in git history

## Resources

- [@turnkey/sdk-react npm](https://www.npmjs.com/package/@turnkey/sdk-react)
- [Turnkey Docs](https://docs.turnkey.com/sdks/react/getting-started)
- [GitHub SDK Repo](https://github.com/tkhq/sdk)

## Notes

The React SDK handles:
- Automatic session persistence (localStorage/sessionStorage)
- Token refresh
- WebAuthn/passkey support (for future use)
- Iframe communication for auth

This should resolve our signing/verification issues because:
1. SDK handles signature formatting correctly
2. Built-in session management prevents expiration issues
3. Official implementation is tested and maintained
