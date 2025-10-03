# Migration: WebVHManager → DIDManager

## Summary

The DID:WebVH functionality has been moved from a separate `WebVHManager` into the `DIDManager` class. This provides better cohesion since `DIDManager` already handles creating and managing all DID types (did:peer, did:btco), so did:webvh belongs there too.

## What Changed

### Before
```typescript
// Separate manager
const sdk = OriginalsSDK.create({ network: 'mainnet' });
const result = await sdk.webvh.createDIDWebVH({ ... });
```

### After
```typescript
// Integrated into DIDManager
const sdk = OriginalsSDK.create({ network: 'mainnet' });
const result = await sdk.did.createDIDWebVH({ ... });
```

## Migration Guide

### 1. Update SDK Usage

**Before:**
```typescript
await sdk.webvh.createDIDWebVH(options);
await sdk.webvh.updateDIDWebVH(options);
await sdk.webvh.saveDIDLog(did, log, dir);
await sdk.webvh.loadDIDLog(path);
```

**After:**
```typescript
await sdk.did.createDIDWebVH(options);
await sdk.did.updateDIDWebVH(options);
await sdk.did.saveDIDLog(did, log, dir);
await sdk.did.loadDIDLog(path);
```

### 2. Update Imports

**Before:**
```typescript
import { WebVHManager, CreateWebVHOptions, CreateWebVHResult } from '@originals/sdk';
```

**After:**
```typescript
import { DIDManager, CreateWebVHOptions, CreateWebVHResult } from '@originals/sdk';
```

The types are still exported the same way, they just come from `DIDManager` now.

### 3. Update Direct Instantiation (if applicable)

**Before:**
```typescript
import { WebVHManager } from '@originals/sdk';
const manager = new WebVHManager();
await manager.createDIDWebVH(...);
```

**After:**
```typescript
import { DIDManager } from '@originals/sdk';
import { OriginalsConfig } from '@originals/sdk';

const config: OriginalsConfig = {
  network: 'mainnet',
  defaultKeyType: 'Ed25519',
};
const manager = new DIDManager(config);
await manager.createDIDWebVH(...);
```

Note: DIDManager requires a config object, whereas WebVHManager didn't.

## Implementation Details

### File Changes

- `src/did/DIDManager.ts` - Added createDIDWebVH(), updateDIDWebVH(), saveDIDLog(), loadDIDLog()
- `src/did/WebVHManager.ts` - **Deprecated** (can be removed)
- `src/core/OriginalsSDK.ts` - Removed `webvh` property
- `src/index.ts` - Export types from DIDManager instead of WebVHManager

### Privy Integration

The Privy signer implementation now uses the correct Privy API:

```typescript
const { signature, encoding } = await privyClient.wallets().rawSign(walletId, {
  params: { hash: '0x...' },
});
```

This matches the Privy SDK documentation format.

### Benefits

1. **Better cohesion** - All DID methods in one place
2. **Consistent API** - Same pattern for did:peer, did:webvh, and did:btco
3. **Simpler SDK** - One less top-level property to remember
4. **Easier to maintain** - Related functionality grouped together

## Compatibility

**Breaking Changes:**
- `sdk.webvh.*` → `sdk.did.*`
- Direct `WebVHManager` instantiation requires config

**Non-Breaking:**
- All method signatures remain the same
- All types remain the same
- ExternalSigner interface unchanged
- Privy integration pattern unchanged

## Testing

After migrating, verify:

```typescript
const sdk = OriginalsSDK.create({ network: 'mainnet' });

// Should work
const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
});

// Should also work (existing did:peer creation)
const peerDoc = await sdk.did.createDIDPeer([...]);

// Should also work (existing did:btco creation)  
const btcoDoc = await sdk.did.migrateToDIDBTCO(peerDoc, '12345');
```

## Timeline

- ✅ Implementation complete
- ✅ Build passing
- ✅ Documentation updated
- ⏳ Ready for deployment

## Questions?

See:
- [DIDWEBVH_INTEGRATION.md](./DIDWEBVH_INTEGRATION.md) for full integration guide
- [README.md](./README.md) for updated examples
- `src/did/DIDManager.ts` for implementation
