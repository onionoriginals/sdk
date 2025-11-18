# Route Refactoring Review

## Current Status

### Completed ✅
- **Middleware**: `auth.middleware.ts` (70 lines) - JWT authentication
- **Auth Routes**: `auth.routes.ts` (269 lines) - 7 endpoints
  - POST `/initiate` - Initiate email auth
  - POST `/verify` - Verify email code
  - POST `/exchange-session` - Exchange Turnkey session for JWT
  - POST `/logout` - Clear auth cookie
  - POST `/send-otp` - Legacy OTP (fallback)
  - POST `/verify-otp` - Legacy OTP verification
  - GET `/google` - Google OAuth initiate
  - GET `/google/callback` - Google OAuth callback
- **User Routes**: `users.routes.ts` (25 lines) - 1 endpoint
  - GET `/` - Get authenticated user
- **Wallet Routes**: `wallet.routes.ts` (41 lines) - 2 endpoints
  - POST `/connect` - Connect wallet
  - GET `/:userId` - Get wallet connection
- **Utils Routes**: `utils.routes.ts` (51 lines) - 3 endpoints
  - GET `/originals/health` - SDK health check
  - GET `/stats` - System statistics
  - POST `/qr-code` - Generate QR code
- **Main Routes**: `routes.ts` (241 lines) - Orchestration + 4 DID hosting routes

### Incomplete ⚠️
- **Asset Routes**: `assets.routes.ts` (171 lines) - Only 4 basic CRUD routes

## Missing Asset Endpoints

The following endpoints need to be added to `assets.routes.ts`:

### 1. POST `/create-with-did` (~280 lines)
- Complex asset creation with media upload
- Supports file upload or URL
- SSRF protection
- Creates did:peer with Originals SDK
- Stores in database

### 2. POST `/generate-random` (~100 lines)
- Generate random demo asset
- Creates JSON content with random attributes
- Uses Originals SDK for did:peer creation

### 3. POST `/:id/publish-to-web` (~480 lines) **VERY LARGE**
- Migrate asset from did:peer → did:webvh
- Ownership verification
- Turnkey signer integration
- Publishes DID document
- Issues ownership credentials
- Complex URL parsing for SCID handling

### 4. GET `/asset-types` (~10 lines)
- List asset types for user

### 5. POST `/asset-types` (~18 lines)
- Create new asset type

### 6. POST `/upload-spreadsheet` (~190 lines)
- Bulk import from CSV/XLSX
- Parses spreadsheet
- Creates multiple assets
- Auto-creates asset types

## Route Mapping

### Current Organization
```
/api/auth/*       → auth.routes.ts
/api/user/*       → users.routes.ts
/api/wallet/*     → wallet.routes.ts
/api/*            → utils.routes.ts (health, stats, qr-code)
/api/did/*        → routes-did.ts (existing)
/api/import/*     → routes/import.ts (existing)
/api/assets/*     → assets.routes.ts (INCOMPLETE)
```

### What's Missing from assets.routes.ts

Currently has:
- GET `/` - List assets ✅
- GET `/:id` - Get asset ✅
- POST `/` - Create asset ✅
- PUT `/:id` - Update asset ✅

Needs to add:
- POST `/create-with-did` - Create with SDK ❌
- POST `/generate-random` - Generate demo ❌
- POST `/:id/publish-to-web` - Publish migration ❌
- POST `/upload-spreadsheet` - Bulk import ❌
- GET `/asset-types` - List types ❌
- POST `/asset-types` - Create type ❌

## Recommendation

Complete the assets.routes.ts file by adding all 6 missing endpoints (~1,000+ lines of code to add).

This will give us:
- **Before**: 1 monolithic file (1,703 lines)
- **After**: 8 modular files (1,043 lines total currently, ~2,000 after completion)

The increase in total lines is due to:
1. Separate imports per module
2. Better organization and comments
3. Exported routers instead of inline definitions

The benefit is much better maintainability and clear separation of concerns.
