# DID:WebVH Implementation Guide

This guide explains how to use the Originals SDK to create and manage `did:webvh` identifiers using the `didwebvh-ts` library.

## Overview

The `did:webvh` (DID Web with Version History) method provides:
- **Cryptographically signed DID documents** with verifiable version history
- **Portable DIDs** that can be migrated between domains
- **Version control** with complete audit trail in a DID log
- **Key rotation** support with cryptographic proofs

## Quick Start

### Creating a DID:WebVH

```typescript
import { WebVHManager } from '@originals/sdk';

const manager = new WebVHManager();

// Create a simple DID
const result = await manager.createDIDWebVH({
  domain: 'example.com',
  outputDir: './.well-known',
});

console.log('DID:', result.did);
console.log('Document:', result.didDocument);
console.log('Log path:', result.logPath);
```

### Result Structure

```typescript
{
  did: 'did:webvh:example.com:a1b2c3',  // The DID identifier
  didDocument: {                          // The DID Document
    '@context': [...],
    id: 'did:webvh:example.com:a1b2c3',
    verificationMethod: [...],
    authentication: [...],
    assertionMethod: [...]
  },
  log: [...],                            // Version history log
  keyPair: {                             // Generated key pair
    publicKey: 'z...',
    privateKey: 'z...'
  },
  logPath: '/.well-known/did/a1b2c3/did.jsonl'  // Path where log is saved
}
```

## Advanced Usage

### Custom Paths

Create DIDs with custom path segments:

```typescript
const result = await manager.createDIDWebVH({
  domain: 'example.com',
  paths: ['users', 'alice'],
  outputDir: './.well-known',
});

// Results in: did:webvh:example.com:users:alice:a1b2c3
// Log saved to: ./.well-known/did/users/alice/a1b2c3/did.jsonl
```

### Portable DIDs

Create portable DIDs that can be migrated:

```typescript
const result = await manager.createDIDWebVH({
  domain: 'example.com',
  portable: true,
  outputDir: './.well-known',
});
```

### Using Custom Key Pairs

Provide your own Ed25519 key pair:

```typescript
import { KeyManager } from '@originals/sdk';

const keyManager = new KeyManager();
const customKeyPair = await keyManager.generateKeyPair('Ed25519');

const result = await manager.createDIDWebVH({
  domain: 'example.com',
  keyPair: customKeyPair,
  outputDir: './.well-known',
});
```

### Creating Without Saving

Create a DID without saving the log to disk:

```typescript
const result = await manager.createDIDWebVH({
  domain: 'example.com',
  // No outputDir specified
});

// result.logPath will be undefined
// You can manually save the log later if needed
```

## DID Log Management

### Saving the Log

The DID log is automatically saved when you provide an `outputDir`:

```typescript
const result = await manager.createDIDWebVH({
  domain: 'example.com',
  outputDir: '/var/www/html/.well-known',
});
```

The log is saved in JSONL (JSON Lines) format, where each line is a separate JSON object representing a log entry.

### Loading a Saved Log

```typescript
const log = await manager.loadDIDLog('/path/to/did.jsonl');

console.log('Version ID:', log[0].versionId);
console.log('Created:', log[0].versionTime);
console.log('State:', log[0].state);
```

### Log Structure

Each log entry contains:

```typescript
{
  versionId: "1-QmHash...",           // Version identifier
  versionTime: "2025-10-03T12:00:00Z", // Timestamp
  parameters: {
    method: "did:webvh:0.4",
    scid: "QmHash...",                 // Self-certifying ID
    updateKeys: ["z..."],              // Keys authorized for updates
    portable: true,                    // Portability flag
    // ... other parameters
  },
  state: {                             // The DID Document at this version
    "@context": [...],
    id: "did:webvh:example.com:...",
    verificationMethod: [...],
    // ... rest of DID document
  },
  proof: [{                            // Cryptographic proof
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    verificationMethod: "...",
    created: "2025-10-03T12:00:00Z",
    proofValue: "z...",
    proofPurpose: "assertionMethod"
  }]
}
```

## Web Server Setup

To enable DID resolution, you need to serve the DID logs at the appropriate path:

### Example: Express.js

```javascript
const express = require('express');
const app = express();

// Serve .well-known directory
app.use('/.well-known', express.static('.well-known'));

app.listen(443, () => {
  console.log('DID resolver running on port 443');
});
```

### Example: Nginx

```nginx
server {
  listen 443 ssl;
  server_name example.com;

  location /.well-known/did/ {
    root /var/www/html;
    default_type application/json;
  }
}
```

### File Structure

Your server should serve files in this structure:

```
.well-known/
└── did/
    ├── alice/
    │   └── did.jsonl          # did:webvh:example.com:alice
    └── users/
        └── bob/
            └── did.jsonl      # did:webvh:example.com:users:bob
```

## Integration with Originals SDK

### Using with DID Manager

```typescript
import { OriginalsSDK, WebVHManager } from '@originals/sdk';

const sdk = new OriginalsSDK({
  network: 'testnet',
  bitcoinRpcUrl: 'http://localhost:3000',
});

const webvhManager = new WebVHManager();

// Create a did:webvh
const result = await webvhManager.createDIDWebVH({
  domain: 'example.com',
  outputDir: './.well-known',
});

// Resolve it using the SDK
const resolved = await sdk.did.resolveDID(result.did);
console.log('Resolved:', resolved);
```

### Key Types

The `WebVHManager` uses **Ed25519** keys by default, which are well-suited for did:webvh. The keys are encoded in multibase format with proper multicodec headers.

## Security Considerations

1. **Private Key Protection**: Never expose private keys. Store them securely (e.g., in environment variables, key management systems).

2. **HTTPS Required**: DID:WebVH requires HTTPS in production to prevent man-in-the-middle attacks.

3. **Key Rotation**: Plan for key rotation using the `updateDID` function (from didwebvh-ts).

4. **Backup Logs**: Always backup your DID logs. Loss of logs means loss of version history.

## Troubleshooting

### DID Not Resolving

1. Check that the log file is accessible at `https://domain/.well-known/did/{path}/did.jsonl`
2. Verify the file is valid JSONL format
3. Check CORS headers if resolving from browser
4. Ensure HTTPS is enabled

### Invalid Proof Errors

1. Verify the key pair matches the one used to create the DID
2. Check that the signing algorithm (EdDSA) is supported
3. Ensure the multibase encoding is correct

## API Reference

### `WebVHManager`

#### `createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult>`

Creates a new did:webvh DID.

**Options:**
- `domain` (required): The domain name for the DID
- `keyPair` (optional): Custom Ed25519 key pair
- `paths` (optional): Array of path segments
- `portable` (optional): Whether the DID is portable
- `outputDir` (optional): Directory to save the DID log

**Returns:**
- `did`: The DID identifier
- `didDocument`: The DID Document
- `log`: Version history log
- `keyPair`: The key pair (generated or provided)
- `logPath`: Path where log was saved (if outputDir provided)

#### `saveDIDLog(did: string, log: DIDLog, baseDir: string): Promise<string>`

Saves a DID log to the appropriate path.

#### `loadDIDLog(logPath: string): Promise<DIDLog>`

Loads a DID log from a file.

## Examples

See `src/examples/webvh-demo.ts` for complete working examples.

## References

- [DID:WebVH Specification](https://identity.foundation/didwebvh/)
- [didwebvh-ts Library](https://github.com/aviarytech/didwebvh-ts)
- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
