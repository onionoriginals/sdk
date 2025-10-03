# DID:WebVH Integration with Originals SDK

This document describes the tight integration between `didwebvh-ts` and the Originals SDK, including support for external key management systems like Privy.

## Overview

The Originals SDK now provides a comprehensive, centralized integration for creating and managing `did:webvh` identifiers. This integration:

1. **Uses didwebvh-ts properly** - Leverages the official didwebvh-ts library for creating and updating DIDs with proper cryptographic signing and proofs
2. **Supports external signers** - Allows integration with external key management systems (e.g., Privy, AWS KMS, HSMs)
3. **Centralized in the SDK** - All DID:WebVH functionality is available through the SDK's `webvh` manager
4. **Automatic DID creation on login** - Users get a did:webvh created automatically when they first authenticate

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Originals SDK                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   WebVHManager                             │  │
│  │  - createDIDWebVH()                                        │  │
│  │  - updateDIDWebVH()                                        │  │
│  │  - saveDIDLog()                                            │  │
│  │  - loadDIDLog()                                            │  │
│  └────────────────────┬──────────────────────────────────────┘  │
│                       │                                          │
│         ┌─────────────┴──────────────┐                          │
│         ▼                            ▼                           │
│  ┌─────────────┐            ┌────────────────┐                  │
│  │  Internal   │            │   External     │                  │
│  │   Signer    │            │   Signer       │                  │
│  │ (Ed25519)   │            │  (Interface)   │                  │
│  └─────────────┘            └────────┬───────┘                  │
└──────────────────────────────────────┼──────────────────────────┘
                                       │
                        ┌──────────────┴────────────────┐
                        ▼                               ▼
               ┌────────────────┐            ┌─────────────────┐
               │  Privy Signer  │            │  Other Signers  │
               │  Integration   │            │  (KMS, HSM...)  │
               └────────────────┘            └─────────────────┘
                        │
                        ▼
                ┌───────────────┐
                │ didwebvh-ts   │
                │  (official)   │
                └───────────────┘
```

## Key Components

### 1. SDK Core (`src/core/OriginalsSDK.ts`)

The main SDK now includes a `webvh` property that provides access to the WebVHManager:

```typescript
const sdk = OriginalsSDK.create({ network: 'mainnet' });

// Access WebVH functionality
const result = await sdk.webvh.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
});
```

### 2. WebVHManager (`src/did/WebVHManager.ts`)

The WebVHManager is the core component for DID:WebVH operations:

**Methods:**
- `createDIDWebVH(options)` - Create a new DID with proper signing
- `updateDIDWebVH(options)` - Update an existing DID
- `saveDIDLog(did, log, outputDir)` - Save DID log to filesystem
- `loadDIDLog(logPath)` - Load DID log from filesystem

**Key Features:**
- Supports both internal (SDK-managed) and external signers
- Automatically generates and saves DID logs in the correct format
- Full integration with didwebvh-ts for proper cryptographic proofs

### 3. External Signer Interface (`src/types/common.ts`)

The SDK defines `ExternalSigner` and `ExternalVerifier` interfaces that allow integration with external key management:

```typescript
export interface ExternalSigner {
  sign(input: { 
    document: Record<string, unknown>; 
    proof: Record<string, unknown> 
  }): Promise<{ proofValue: string }>;
  
  getVerificationMethodId(): Promise<string> | string;
}

export interface ExternalVerifier {
  verify(
    signature: Uint8Array, 
    message: Uint8Array, 
    publicKey: Uint8Array
  ): Promise<boolean>;
}
```

### 4. Privy Integration (`apps/originals-explorer/server/privy-signer.ts`)

A complete implementation of the ExternalSigner interface for Privy:

**Classes:**
- `PrivyWebVHSigner` - Implements ExternalSigner using Privy wallets
- `createPrivySigner()` - Factory function to create a Privy signer
- `createVerificationMethodsFromPrivy()` - Creates verification methods from Privy wallets

### 5. DID Creation Service (`apps/originals-explorer/server/did-webvh-service.ts`)

Updated to use the SDK with Privy integration:

```typescript
// Old: Manual DID creation with no signing
const didDocument = { /* manually created */ };

// New: Proper SDK integration with signing
const result = await originalsSdk.webvh.createDIDWebVH({
  domain,
  paths: [userSlug],
  externalSigner: privySigner,
  verificationMethods,
  updateKeys,
  outputDir,
});
```

## Usage Examples

### Example 1: Create DID with SDK-managed keys

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({ network: 'mainnet' });

// Create DID with SDK-managed Ed25519 keys
const result = await sdk.webvh.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  portable: false,
  outputDir: './public/.well-known',
});

console.log('DID:', result.did);
console.log('DID Document:', result.didDocument);
console.log('Public Key:', result.keyPair.publicKey);
// IMPORTANT: Store result.keyPair.privateKey securely!
```

### Example 2: Create DID with Privy keys

```typescript
import { OriginalsSDK } from '@originals/sdk';
import { createPrivySigner, createVerificationMethodsFromPrivy } from './privy-signer';

const sdk = OriginalsSDK.create({ network: 'mainnet' });

// Create verification methods from Privy
const {
  verificationMethods,
  updateKey,
  authWalletId,
  updateWalletId,
} = await createVerificationMethodsFromPrivy(
  privyUserId,
  privyClient,
  'example.com',
  'alice'
);

// Create signer
const signer = await createPrivySigner(
  privyUserId,
  updateWalletId,
  privyClient,
  updateKey
);

// Create DID
const result = await sdk.webvh.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  externalSigner: signer,
  verificationMethods,
  updateKeys: [updateKey],
  outputDir: './public/.well-known',
});

console.log('DID:', result.did);
console.log('DID Document:', result.didDocument);
// Keys are managed by Privy - no need to store them
```

### Example 3: Update a DID

```typescript
// Load existing DID log
const log = await sdk.webvh.loadDIDLog('./path/to/did.jsonl');

// Update the DID
const result = await sdk.webvh.updateDIDWebVH({
  did: 'did:webvh:example.com:alice',
  currentLog: log,
  updates: {
    service: [{
      id: '#my-service',
      type: 'MyService',
      serviceEndpoint: 'https://example.com/service'
    }]
  },
  signer: keyPair, // or externalSigner
  outputDir: './public/.well-known',
});

console.log('Updated DID Document:', result.didDocument);
```

## Integration with Privy (Complete Flow)

The originals-explorer app demonstrates the complete integration:

### 1. First Login - Automatic DID Creation

When a user logs in for the first time (in `apps/originals-explorer/server/routes.ts`):

```typescript
const authenticateUser = async (req, res, next) => {
  const verifiedClaims = await privyClient.verifyAuthToken(token);
  let user = await storage.getUserByPrivyId(verifiedClaims.userId);
  
  // If user doesn't exist, create DID:WebVH
  if (!user) {
    const didData = await createUserDIDWebVH(
      verifiedClaims.userId, 
      privyClient
    );
    user = await storage.createUserWithDid(
      verifiedClaims.userId, 
      didData.did, 
      didData
    );
  }
  
  req.user = { id: user.did, privyId: verifiedClaims.userId };
  next();
};
```

### 2. DID Creation with Privy

The `createUserDIDWebVH` function (in `did-webvh-service.ts`):

```typescript
export async function createUserDIDWebVH(
  privyUserId: string,
  privyClient: PrivyClient,
  domain: string
) {
  // 1. Create verification methods from Privy wallets
  const { verificationMethods, updateKey, authWalletId, updateWalletId } =
    await createVerificationMethodsFromPrivy(
      privyUserId, 
      privyClient, 
      domain, 
      userSlug
    );

  // 2. Create Privy signer
  const signer = await createPrivySigner(
    privyUserId,
    updateWalletId,
    privyClient,
    updateKey
  );

  // 3. Create DID using SDK
  const result = await originalsSdk.webvh.createDIDWebVH({
    domain,
    paths: [userSlug],
    externalSigner: signer,
    verificationMethods,
    updateKeys: [updateKey],
    outputDir: path.join(publicDir, '.well-known'),
  });

  return {
    did: result.did,
    didDocument: result.didDocument,
    authWalletId,
    updateWalletId,
    // ... other metadata
  };
}
```

## TODO: Complete Privy Signing Implementation

The Privy signer is currently a placeholder. To complete the integration:

### Step 1: Check Privy Documentation

Review the Privy wallet API documentation for the signing method. It should be something like:

```typescript
const signature = await privyClient.walletApi.sign({
  walletId: walletId,
  message: messageHex,
});
```

### Step 2: Update `privy-signer.ts`

In `apps/originals-explorer/server/privy-signer.ts`, update the `sign()` method:

```typescript
async sign(input: { 
  document: Record<string, unknown>; 
  proof: Record<string, unknown> 
}): Promise<{ proofValue: string }> {
  // Import didwebvh-ts to use its canonical data preparation
  const { prepareDataForSigning } = await import('didwebvh-ts');
  
  // Prepare the data for signing
  const dataToSign = await prepareDataForSigning(input.document, input.proof);
  
  // Convert to hex for Privy
  const messageHex = Buffer.from(dataToSign).toString('hex');
  
  // TODO: Replace with actual Privy signing API
  const signatureHex = await this.privyClient.walletApi.sign({
    walletId: this.walletId,
    message: messageHex,
  });
  
  // Convert signature to bytes
  const signatureBytes = Buffer.from(signatureHex, 'hex');
  
  // Encode as multibase
  const proofValue = multikey.encodeMultibase(signatureBytes);
  
  return { proofValue };
}
```

### Step 3: Test

After implementing, test the integration:

```bash
# In the originals-explorer app
npm run dev

# Login with Privy
# Check that the DID is created successfully
# Verify that the DID log is saved to ./public/.well-known/did/...
```

## File Structure

```
originals-sdk/
├── src/
│   ├── core/
│   │   └── OriginalsSDK.ts         # Added webvh property
│   ├── did/
│   │   ├── WebVHManager.ts         # Updated with external signer support
│   │   └── DIDManager.ts           # Existing DID management
│   └── types/
│       └── common.ts               # Added ExternalSigner interface
│
└── apps/originals-explorer/
    └── server/
        ├── privy-signer.ts         # NEW: Privy signer implementation
        ├── did-webvh-service.ts    # Updated to use SDK
        ├── webvh-integration.ts    # Updated to use SDK
        └── routes.ts               # Uses SDK for DID creation
```

## Benefits of This Integration

1. **Proper Cryptographic Signing** - Uses didwebvh-ts for spec-compliant DID creation with real cryptographic proofs
2. **Flexible Key Management** - Supports both SDK-managed keys and external key management (Privy, KMS, HSM)
3. **Centralized Logic** - All DID:WebVH functionality in one place (SDK's webvh manager)
4. **Type Safety** - Full TypeScript support with proper interfaces
5. **Automatic DID Creation** - Users get DIDs created on first login
6. **Proper DID Log Management** - Automatically saves and loads DID logs in the correct format
7. **Update Support** - Full support for updating DIDs with proper versioning

## Migration Guide

If you were using the old manual DID creation:

### Before
```typescript
// Manual DID creation without signing
const didDocument = {
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": `did:webvh:example.com:alice`,
  "verificationMethod": [/* ... */],
};
```

### After
```typescript
// Use SDK with proper signing
const result = await originalsSdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  // Use external signer for Privy, or omit for SDK-managed keys
});
```

## Additional Resources

- [didwebvh-ts GitHub](https://github.com/aviarytech/didwebvh-ts)
- [DID:WebVH Specification](https://identity.foundation/did-webvh/)
- [Privy Documentation](https://docs.privy.io/)
- [Originals SDK Documentation](./README.md)
- [Migration Guide](./MIGRATION_TO_DIDMANAGER.md) - For upgrading from WebVHManager

## Support

For questions or issues:
1. Check the test files in `tests/unit/did/WebVHManager.test.ts`
2. Review the example in `apps/originals-explorer/server/did-webvh-service.ts`
3. Open an issue on GitHub
