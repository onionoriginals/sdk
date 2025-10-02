# DID:WebVH Setup Guide

This document explains how the automatic DID creation works and how to configure it.

## Overview

The application automatically creates a `did:webvh` identifier for users when they sign in via Privy (Google OAuth, etc.). All private keys are managed securely by Privy's infrastructure - they never touch your server or database.

## How It Works

### 1. User Signs In
When a user signs in via Privy (e.g., Google OAuth), they get a Privy user ID like `did:privy:cltest123456`.

### 2. Auto-Create DID on Profile Visit
When the user visits their profile page, the frontend automatically calls `/api/user/ensure-did` which:

1. Checks if user already has a DID
2. If not, creates 3 Privy embedded wallets:
   - **Bitcoin wallet** (Secp256k1) - for authentication
   - **Stellar wallet #1** (Ed25519) - for signing credentials/assertions
   - **Stellar wallet #2** (Ed25519) - for DID document updates

3. Extracts public keys from each wallet
4. Converts public keys to multibase format (z-base58btc with multicodec headers)
5. Generates a user slug from the Privy user ID
6. Creates a DID document with all three verification methods
7. Stores the DID metadata in the user record

### 3. DID Document Structure

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:webvh:localhost%3A5000:cltest123456",
  "verificationMethod": [
    {
      "id": "did:webvh:localhost%3A5000:cltest123456#auth-key",
      "type": "Multikey",
      "controller": "did:webvh:localhost%3A5000:cltest123456",
      "publicKeyMultibase": "zQ3s..."
    },
    {
      "id": "did:webvh:localhost%3A5000:cltest123456#assertion-key",
      "type": "Multikey",
      "controller": "did:webvh:localhost%3A5000:cltest123456",
      "publicKeyMultibase": "z6Mk..."
    },
    {
      "id": "did:webvh:localhost%3A5000:cltest123456#update-key",
      "type": "Multikey",
      "controller": "did:webvh:localhost%3A5000:cltest123456",
      "publicKeyMultibase": "z6Mk..."
    }
  ],
  "authentication": ["did:webvh:localhost%3A5000:cltest123456#auth-key"],
  "assertionMethod": ["did:webvh:localhost%3A5000:cltest123456#assertion-key"]
}
```

### 4. DID Resolution

According to the DID:WebVH specification, DIDs are resolved using path-based transformation:

**DID Format:** `did:webvh:{url-encoded-domain}:{identifier}`  
**Resolves to:** `https://{domain}/{identifier}/did.jsonld`

**Important:** Domains with ports must be URL-encoded (`:` becomes `%3A`)

For example:
```
DID: did:webvh:localhost%3A5000:cltest123456
Resolves to: http://localhost:5000/cltest123456/did.jsonld
```

**Note:** The `/did.jsonld` suffix is required by the DID:WebVH spec.

## Environment Variables

Create a `.env` file in the `apps/originals-explorer` directory:

```env
# Required: Privy Configuration
PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret

# Optional: Privy Wallet Policies
PRIVY_EMBEDDED_WALLET_POLICY_IDS=policy_id_1,policy_id_2

# Required: DID Domain
# Use localhost:5000 for development
# Use your actual domain for production (e.g., app.example.com)
DID_DOMAIN=localhost:5000
VITE_APP_DOMAIN=localhost:5000
```

### Getting Privy Credentials

1. Go to https://dashboard.privy.io
2. Create a new app or select existing app
3. Copy your App ID and App Secret
4. Enable embedded wallets in the dashboard
5. (Optional) Create wallet policies if needed

## Database Schema

The `users` table includes these DID-related fields:

```typescript
{
  // DID identifier (e.g., "did:webvh:localhost%3A5000:user123")
  did: string | null,
  
  // Complete DID document (JSON)
  didDocument: object | null,
  
  // Privy wallet IDs (for signing operations)
  authWalletId: string | null,       // Bitcoin wallet
  assertionWalletId: string | null,  // Stellar wallet #1
  updateWalletId: string | null,     // Stellar wallet #2
  
  // Public keys (in multibase format)
  authKeyPublic: string | null,      // Bitcoin public key
  assertionKeyPublic: string | null, // Stellar public key #1
  updateKeyPublic: string | null,    // Stellar public key #2
  
  // Timestamp
  didCreatedAt: Date | null
}
```

**Important**: Private keys are NEVER stored in the database. They are managed entirely by Privy.

## Security Benefits

✅ **No private keys in your database** - All keys managed by Privy  
✅ **No private keys in memory** - Signing happens via Privy API  
✅ **Automatic key backup** - Privy handles backup and recovery  
✅ **Multi-device access** - Users can access from any device via Privy  
✅ **Industry-standard security** - Privy uses HSMs and secure enclaves  

## Usage in Application

### Auto-Create DID
The DID is automatically created when users visit their profile. No manual action needed.

### Display DID
The profile page shows:
- The full DID identifier
- A QR code for sharing
- Key information (types and truncated public keys)
- "Secured by Privy" badge

### Copy/Export DID
Users can:
- Copy DID to clipboard
- Export DID document as JSON
- View verification method details

## Future: Signing Credentials

When you need to sign verifiable credentials, use the signing service:

```typescript
import { signWithUserKey } from './server/signing-service';

// Sign with assertion key (for credentials)
const signature = await signWithUserKey(
  userId, 
  'assertion', 
  dataToSign,
  privyClient
);
```

**Note**: The Privy signing API integration is not yet implemented. Check Privy's documentation for the exact API method to use.

## Testing

Run tests:
```bash
npm test apps/originals-explorer/server/__tests__/did-service.test.ts
```

The tests mock Privy wallet creation and verify:
- DID document structure
- Public key conversion
- User slug generation
- Error handling

## Troubleshooting

### DID not being created
- Check that `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are set
- Check that `DID_DOMAIN` is set
- Check browser console and server logs for errors

### Wallet creation fails
- Verify Privy credentials are correct
- Check that embedded wallets are enabled in Privy dashboard
- Check if wallet policies are required and configured

### DID resolution fails
- Verify the DID document is stored in the database
- Check that the user slug matches the DID
- Verify the `/:userSlug` endpoint is accessible

## Production Deployment

1. Update `DID_DOMAIN` to your production domain
2. Ensure Privy is configured for production
3. Set up proper HTTPS (required for production)
4. Test DID resolution at `https://your-domain.com/{slug}/did.jsonld`
5. Consider setting up monitoring for DID creation failures

## Additional Resources

- [DID:WebVH Specification](https://w3c-ccg.github.io/did-method-web/)
- [Privy Documentation](https://docs.privy.io)
- [Multikey Specification](https://w3c-ccg.github.io/multikey/)
- [Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
