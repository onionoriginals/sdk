# Key Management in Originals SDK

## Overview

The Originals SDK now supports proper key management for credential signing using keys from DID documents instead of ephemeral keys. This ensures that credentials are cryptographically verifiable and maintains the integrity of the DID-based identity system.

## Key Concepts

### KeyStore Interface

The `KeyStore` interface provides a simple abstraction for storing and retrieving private keys:

```typescript
interface KeyStore {
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}
```

### Verification Method IDs

Keys are stored and retrieved using verification method IDs from DID documents. These IDs are typically in the format:
- `did:peer:xxx#key-0` (full format with DID and fragment)
- `#key-0` (fragment-only, automatically converted to full format internally)

## Usage

### 1. Initialize SDK with KeyStore

```typescript
import { OriginalsSDK, KeyStore } from '@originals/sdk';

// Implement your own KeyStore (example using in-memory storage)
class MyKeyStore implements KeyStore {
  private keys = new Map<string, string>();

  async getPrivateKey(verificationMethodId: string): Promise<string | null> {
    return this.keys.get(verificationMethodId) || null;
  }

  async setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void> {
    this.keys.set(verificationMethodId, privateKey);
  }
}

const keyStore = new MyKeyStore();
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  keyStore
});
```

### 2. Create Assets with Automatic Key Registration

When you create an asset with a keyStore configured, the SDK automatically registers the generated key:

```typescript
const resources = [{
  id: 'resource1',
  type: 'image',
  contentType: 'image/png',
  hash: 'abcd1234...',
  content: '...'
}];

// Creates DID:peer document and automatically stores the private key in keyStore
const asset = await sdk.lifecycle.createAsset(resources);
```

### 3. Publish to Web with DID Keys

When publishing to web, credentials are now signed using the keys from the keyStore:

```typescript
// Signs credentials with the DID document keys (not ephemeral keys)
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');

// Credentials are cryptographically verifiable
console.log(published.credentials[0].proof);
```

### 4. Manual Key Registration

You can also manually register keys for existing DIDs:

```typescript
import { KeyManager } from '@originals/sdk';

const keyManager = new KeyManager();
const keyPair = await keyManager.generateKeyPair('ES256K');

// Register the key for a specific verification method
await sdk.lifecycle.registerKey(
  'did:peer:xxx#key-0',
  keyPair.privateKey
);
```

## Implementation Patterns

### Secure Key Storage

**⚠️ SECURITY WARNING**: The examples above use in-memory storage for demonstration. In production, you MUST use secure key storage:

```typescript
// Example: Using encrypted storage (pseudo-code)
class SecureKeyStore implements KeyStore {
  private encryptionKey: Buffer;

  constructor(encryptionKey: Buffer) {
    this.encryptionKey = encryptionKey;
  }

  async getPrivateKey(verificationMethodId: string): Promise<string | null> {
    const encrypted = await this.db.get(verificationMethodId);
    if (!encrypted) return null;
    return this.decrypt(encrypted);
  }

  async setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void> {
    const encrypted = this.encrypt(privateKey);
    await this.db.set(verificationMethodId, encrypted);
  }

  private encrypt(data: string): string {
    // Use proper encryption (e.g., AES-256-GCM)
    // ...
  }

  private decrypt(data: string): string {
    // Use proper decryption
    // ...
  }
}
```

### Key Backup and Recovery

Always implement a key backup strategy:

```typescript
class BackupKeyStore implements KeyStore {
  constructor(
    private primary: KeyStore,
    private backup: KeyStore
  ) {}

  async getPrivateKey(verificationMethodId: string): Promise<string | null> {
    let key = await this.primary.getPrivateKey(verificationMethodId);
    if (!key) {
      // Try backup if primary fails
      key = await this.backup.getPrivateKey(verificationMethodId);
      if (key) {
        // Restore to primary
        await this.primary.setPrivateKey(verificationMethodId, key);
      }
    }
    return key;
  }

  async setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void> {
    // Store in both primary and backup
    await Promise.all([
      this.primary.setPrivateKey(verificationMethodId, privateKey),
      this.backup.setPrivateKey(verificationMethodId, privateKey)
    ]);
  }
}
```

### Testing with MockKeyStore

For testing, use the provided `MockKeyStore`:

```typescript
import { MockKeyStore } from '@originals/sdk/tests/mocks';

const keyStore = new MockKeyStore();
const sdk = OriginalsSDK.create({
  network: 'regtest',
  keyStore
});

// ... run tests

// Inspect stored keys for verification
const allKeys = keyStore.getAllKeys();
console.log('Stored keys:', allKeys.size);

// Clear keys between tests
keyStore.clear();
```

## Security Considerations

### 1. Private Key Protection

- **NEVER** log or expose private keys
- Store private keys encrypted at rest
- Use hardware security modules (HSMs) for production
- Implement proper access controls

### 2. Key Lifecycle Management

- Generate new keys for each DID
- Rotate keys periodically
- Revoke compromised keys immediately
- Maintain audit logs of key operations

### 3. Credential Verification

Credentials are now verifiable because they're signed with keys from the DID document:

```typescript
// Credential verification works because:
// 1. The credential.proof.verificationMethod references the DID document
// 2. The DID document contains the public key
// 3. The private key used for signing matches the public key
const isValid = await sdk.credentials.verifyCredential(credential);
```

### 4. Error Handling

When a key is not available, the SDK uses a "best-effort" approach:

```typescript
// Without keyStore, publishing succeeds but no credential is created
const sdk = OriginalsSDK.create({ network: 'mainnet' }); // no keyStore
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
console.log(published.credentials.length); // 0

// With keyStore but missing key, same behavior
const sdkWithKeyStore = OriginalsSDK.create({ 
  network: 'mainnet',
  keyStore: new MyKeyStore() 
});
// If key not found, publishing succeeds without credential
```

## Migration Guide

If you're upgrading from a version that used ephemeral keys:

### Before (Ephemeral Keys)
```typescript
const sdk = OriginalsSDK.create({ network: 'mainnet' });
const asset = await sdk.lifecycle.createAsset(resources);
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
// Credentials were signed with ephemeral keys (not verifiable)
```

### After (DID Document Keys)
```typescript
const keyStore = new MySecureKeyStore();
const sdk = OriginalsSDK.create({ 
  network: 'mainnet',
  keyStore 
});
const asset = await sdk.lifecycle.createAsset(resources);
// Key is automatically registered in keyStore
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
// Credentials are signed with DID keys (verifiable!)
```

## API Reference

### OriginalsSDK.create(options)

Creates a new SDK instance with optional keyStore.

```typescript
interface OriginalsSDKOptions {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  defaultKeyType?: 'ES256K' | 'Ed25519' | 'ES256';
  keyStore?: KeyStore;
  // ... other options
}
```

### LifecycleManager.registerKey(verificationMethodId, privateKey)

Manually register a private key for a verification method.

```typescript
await sdk.lifecycle.registerKey(
  'did:peer:xxx#key-0',
  'z...' // multibase-encoded private key
);
```

**Throws:**
- `Error` if keyStore is not configured
- `Error` if verificationMethodId is invalid
- `Error` if privateKey format is invalid

### LifecycleManager.createAsset(resources)

Creates a new asset with automatic key registration (if keyStore is configured).

```typescript
const asset = await sdk.lifecycle.createAsset(resources);
// If keyStore is provided, the key is automatically stored
```

### LifecycleManager.publishToWeb(asset, domain)

Publishes an asset to web and creates a signed credential using DID keys.

```typescript
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
// If keyStore is configured and key is available:
//   - Credential is created and signed
// If keyStore is not configured or key is missing:
//   - Publishing succeeds but no credential is added (best-effort)
```

## Examples

See the test file `tests/lifecycle/LifecycleManager.keymanagement.test.ts` for comprehensive examples of:
- Automatic key registration
- Manual key registration
- Credential signing with DID keys
- Error handling
- Key rotation scenarios

## Support

For questions or issues related to key management:
1. Check the examples in the tests directory
2. Review the source code in `src/lifecycle/LifecycleManager.ts`
3. Open an issue on the project repository
