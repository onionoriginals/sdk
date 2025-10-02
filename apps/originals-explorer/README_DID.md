# Automatic DID:WebVH Creation - Quick Start

## What Was Implemented

✅ **Automatic DID creation** for users who sign in via Privy (Google OAuth, etc.)  
✅ **Three Privy-managed wallets** per user (1 Bitcoin, 2 Stellar)  
✅ **Secure key management** - All private keys managed by Privy, never exposed  
✅ **Beautiful profile UI** - DID display with QR code, copy, and export  
✅ **DID resolution endpoint** - Spec-compliant `/{slug}/did.jsonld` endpoint  
✅ **Full test coverage** - Unit tests for all DID services  

## Quick Start

### 1. Set Environment Variables

Create `.env` file in `apps/originals-explorer/`:

```env
PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret
DID_DOMAIN=localhost:5000
VITE_APP_DOMAIN=localhost:5000
```

### 2. Start the App

```bash
cd apps/originals-explorer
npm install
npm run dev
```

### 3. Test the Flow

1. Navigate to http://localhost:5001
2. Sign in with Google (via Privy)
3. Go to your profile page
4. Watch as your DID is automatically created! 🎉

### 4. View Your DID

Your profile page will show:
- ✅ Your full DID identifier
- ✅ QR code for sharing
- ✅ Copy and export buttons
- ✅ Key information (expandable)
- ✅ "Secured by Privy" badge

### 5. Test DID Resolution

Visit:
```
http://localhost:5000/{your-slug}/did.jsonld
```

You should see your DID document in JSON-LD format!

**Note:** The `/did.jsonld` suffix is required by the DID:WebVH specification.

## File Structure

```
apps/originals-explorer/
├── server/
│   ├── did-service.ts          # DID creation logic
│   ├── key-utils.ts            # Key conversion utilities
│   ├── signing-service.ts      # Future signing operations
│   ├── routes.ts               # API endpoints (updated)
│   ├── storage.ts              # Storage methods (updated)
│   └── __tests__/
│       └── did-service.test.ts # Tests
├── shared/
│   └── schema.ts               # Database schema (updated)
├── client/src/pages/
│   └── profile.tsx             # Profile page (updated)
├── .env.example                # Environment template
├── DID_SETUP.md               # Detailed setup guide
├── IMPLEMENTATION_SUMMARY.md  # Complete implementation details
└── README_DID.md              # This file
```

## How It Works

1. **User signs in** via Privy (Google OAuth)
2. **Profile page loads** and calls `/api/user/ensure-did`
3. **Backend creates**:
   - Bitcoin wallet (authentication key)
   - Stellar wallet #1 (assertion key)
   - Stellar wallet #2 (update key)
4. **Public keys extracted** and converted to multibase format
5. **DID document created** with all verification methods
6. **Metadata stored** in database (no private keys!)
7. **Frontend displays** DID with QR code and controls

## Example DID

```
did:webvh:localhost%3A5000:cltest123456
```

Resolves to:
```
http://localhost:5000/cltest123456/did.jsonld
```

**Note:** The domain `localhost:5000` is URL-encoded as `localhost%3A5000` in the DID (`:` becomes `%3A`). This is required by the DID:WebVH specification for proper path-based resolution.

## Security Features

🔒 **Private keys never exposed** - All managed by Privy  
🔒 **No keys in database** - Only public keys and metadata  
🔒 **No keys in server memory** - Signing via Privy API  
🔒 **Industry-standard security** - Privy uses HSMs and secure enclaves  

## API Endpoints

### Create/Get DID
```bash
POST /api/user/ensure-did
Authorization: Bearer {privy-token}

Response:
{
  "did": "did:webvh:localhost:5000:user123",
  "didDocument": { ... },
  "created": true
}
```

### Resolve DID
```bash
GET /{userSlug}/did.jsonld

Response:
{
  "@context": [...],
  "id": "did:webvh:localhost:5000:user123",
  "verificationMethod": [...],
  ...
}
```

## Testing

Run tests:
```bash
npm test apps/originals-explorer/server/__tests__/did-service.test.ts
```

## Documentation

- **`DID_SETUP.md`** - Detailed setup and configuration
- **`IMPLEMENTATION_SUMMARY.md`** - Complete implementation details
- **`.env.example`** - Environment variable reference

## Troubleshooting

### DID not creating?
- Check Privy credentials in `.env`
- Check browser console for errors
- Check server logs

### Wallet creation fails?
- Verify embedded wallets enabled in Privy dashboard
- Check if wallet policies are required

### DID resolution fails?
- Verify user slug in database
- Check endpoint is accessible
- Verify DID document is stored

## Next Steps

1. **Set up Privy** - Get credentials from dashboard.privy.io
2. **Test locally** - Create a DID and view it
3. **Deploy** - Update `DID_DOMAIN` for production
4. **Integrate signing** - Implement Privy signing API
5. **Issue credentials** - Use DIDs to sign verifiable credentials

## Need Help?

- Privy Docs: https://docs.privy.io
- W3C DID Spec: https://www.w3.org/TR/did-core/
- Multikey Spec: https://w3c-ccg.github.io/multikey/

## Example Flow Diagram

```
User Signs In (Privy)
        ↓
Profile Page Loads
        ↓
Call /api/user/ensure-did
        ↓
Check if DID exists → Yes → Return existing DID
        ↓ No
Create 3 Privy Wallets
        ↓
Extract Public Keys
        ↓
Convert to Multibase
        ↓
Create DID Document
        ↓
Store in Database
        ↓
Return DID to Frontend
        ↓
Display with QR Code
```

## Success! 🎉

You now have automatic DID creation with Privy-managed keys!

All private keys are secure in Privy's infrastructure.
Your users can now have decentralized identities for verifiable credentials.
