# Originals SDK

![CI](https://github.com/onionoriginals/sdk/actions/workflows/ci.yml/badge.svg)
![Coverage](https://raw.githubusercontent.com/onionoriginals/sdk/refs/heads/main/badges/coverage.svg)

A TypeScript SDK for the Originals Protocol - enabling creation, discovery, and transfer of digital assets with cryptographically verifiable provenance.

## Overview

The Originals Protocol organizes digital asset lifecycles into three layers:

- **`did:peer`** - Private creation and experimentation (offline, free)
- **`did:webvh`** - Public discovery via HTTPS hosting ($25/year) 
- **`did:btco`** - Transferable ownership on Bitcoin ($75-200 one-time)

Assets migrate unidirectionally through these layers, with economic gravity determining when Bitcoin-level security is justified.

## Installation

```bash
npm install @originals/sdk
```

## Quick Start

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

// For testing/development - use mock provider
const originals = OriginalsSDK.create({
  network: 'testnet',
  enableLogging: true,
  ordinalsProvider: new OrdMockProvider()
});

// Create a digital asset
const resources = [{
  id: 'my-artwork',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256-hash-of-content'
}];

const asset = await originals.lifecycle.createAsset(resources);

// Publish for discovery
await originals.lifecycle.publishToWeb(asset, 'my-domain.com');

// Inscribe on Bitcoin for permanent ownership
await originals.lifecycle.inscribeOnBitcoin(asset);
```

## Architecture

The protocol now uses **CEL (Cryptographic Event Log)** as the universal event format across all three layers, ensuring consistent data structures while allowing different DID methods for resolvability at each stage.

See [ORIGINALS_CEL_SPECIFICATION.md](./ORIGINALS_CEL_SPECIFICATION.md) for the complete specification.

### Core Classes

- **OriginalsSDK** - Main entry point and orchestration
- **OriginalsAsset** - Represents a digital asset through its lifecycle
- **DIDManager** - DID document creation and resolution (did:peer, did:webvh, did:btco) with external signer support
- **CredentialManager** - Verifiable Credential handling
- **LifecycleManager** - Asset migration between layers using CEL event format
- **BitcoinManager** - Bitcoin/Ordinals integration
- **CelManager** - Universal CEL event handling across all layers

### Key Features

- ✅ W3C DID and Verifiable Credential compliance
- ✅ Multibase key encoding (no JSON Web Keys)
- ✅ JSON-LD credential signing (no JWT)
- ✅ Bitcoin Ordinals inscription support
- ✅ Three-layer asset lifecycle management: `did:peer` → `did:webvh` → `did:btco`
- ✅ Cryptographic provenance verification
- ✅ Front-running protection via unique satoshi assignment
- ✅ **DID:WebVH integration with didwebvh-ts** - Full support for creating and managing did:webvh identifiers
- ✅ **External signer support** - Integrate with Turnkey, AWS KMS, HSMs, and other key management systems

## Use Cases

### Digital Art
Artists create private assets for experimentation, publish for discovery, and inscribe on Bitcoin upon sale.

### Scientific Data
Researchers document datasets privately, publish for peer review, and anchor provenance on Bitcoin for permanent record.

### DAO Governance  
Issue member credentials privately, make public for recognition, and inscribe key decisions for immutable governance record.

### Supply Chain
Manufacturers create product credentials, publish public registries, and inscribe final ownership for anti-counterfeiting.

## Configuration

### Bitcoin Operations

Bitcoin operations (inscribing and transferring) require an `ordinalsProvider` to be configured. The SDK provides several options:

#### Testing and Development

For testing and local development, use the built-in mock provider:

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider()
});
```

#### Bitcoin Networks

**Mainnet (Production):**
```typescript
import { OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: 'https://your-ord-api.com',
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});
```

**Testnet:**
```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'testnet',
    apiUrl: 'https://testnet.ord-api.com',
    walletPrivateKey: process.env.TESTNET_PRIVATE_KEY
  })
});
```

**Signet:**
```typescript
const sdk = OriginalsSDK.create({
  network: 'signet',
  ordinalsProvider: new OrdinalsClient({
    network: 'signet',
    apiUrl: 'https://signet.ord-api.com',
    walletPrivateKey: process.env.SIGNET_PRIVATE_KEY
  })
});
```

#### Fee Management

Optionally configure a fee oracle for dynamic fee estimation:

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({...}),
  feeOracle: {
    estimateFeeRate: async (targetBlocks: number) => {
      // Fetch current fee rates from your preferred source
      const response = await fetch('https://mempool.space/api/v1/fees/recommended');
      const fees = await response.json();
      return targetBlocks <= 1 ? fees.fastestFee : fees.halfHourFee;
    }
  }
});
```

#### Error Handling

If you attempt Bitcoin operations without configuring an `ordinalsProvider`, you'll receive a clear error:

```typescript
const sdk = OriginalsSDK.create({ network: 'mainnet' });

// This will throw StructuredError with code 'ORD_PROVIDER_REQUIRED'
await sdk.bitcoin.inscribeData(data, 'application/json');
// Error: Ordinals provider must be configured to inscribe data on Bitcoin.
// Please provide an ordinalsProvider in your SDK configuration.
```

You can also validate the configuration before attempting operations:

```typescript
try {
  sdk.validateBitcoinConfig();
  // Safe to perform Bitcoin operations
} catch (error) {
  console.error('Bitcoin operations not available:', error.message);
}
```

## DID:WebVH Integration

The SDK provides comprehensive support for creating and managing `did:webvh` identifiers with proper cryptographic signing.

### Create DID with SDK-managed keys

```typescript
const sdk = OriginalsSDK.create({ network: 'mainnet' });

const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  outputDir: './public/.well-known',
});

console.log('DID:', result.did);
// Store result.keyPair.privateKey securely!
```

### Create DID with External Key Management (e.g., Turnkey)

```typescript
import { createTurnkeySigner } from './turnkey-signer';

// Create external signer
const signer = await createTurnkeySigner(subOrgId, keyId, turnkeyClient, verificationMethodId, publicKeyMultibase);

// Create DID
const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  externalSigner: signer,
  verificationMethods: [{ type: 'Multikey', publicKeyMultibase: '...' }],
  updateKeys: ['did:key:...'],
  outputDir: './public/.well-known',
});
```

### Update an existing DID

```typescript
const log = await sdk.did.loadDIDLog('./path/to/did.jsonl');

const result = await sdk.did.updateDIDWebVH({
  did: 'did:webvh:example.com:alice',
  currentLog: log,
  updates: {
    service: [{ id: '#my-service', type: 'MyService', serviceEndpoint: 'https://...' }]
  },
  signer: keyPair, // or externalSigner
});
```

For detailed information about the DID:WebVH integration, including Turnkey setup and external signer implementation, see [DIDWEBVH_INTEGRATION.md](./DIDWEBVH_INTEGRATION.md).

## Protocol Specification

This SDK implements the **Originals Protocol** as specified in [ORIGINALS_CEL_SPECIFICATION.md](./ORIGINALS_CEL_SPECIFICATION.md). The specification has been updated from the previous `did:cel`-only approach to use CEL (Cryptographic Event Log) as the universal event format across three distinct DID layers:

- **did:peer**: Private creation and offline validation
- **did:webvh**: Public discovery and web hosting  
- **did:btco**: Bitcoin anchoring and tradeable ownership

This architecture resolves the resolvability issues with content-addressed DIDs while maintaining consistent event structures across all asset lifecycle stages.

## Documentation

### For LLM Agents

If you're an AI/LLM agent working with this SDK, we provide optimized documentation:

- **[docs/LLM_AGENT_GUIDE.md](./docs/LLM_AGENT_GUIDE.md)** - Comprehensive API reference with complete type signatures, method documentation, and working examples
- **[docs/LLM_QUICK_REFERENCE.md](./docs/LLM_QUICK_REFERENCE.md)** - Compact quick-reference card for rapid lookups
- **[CLAUDE.md](./CLAUDE.md)** - Development context and project architecture

### Bitcoin Documentation

- **[docs/BITCOIN_INTEGRATION_GUIDE.md](./docs/BITCOIN_INTEGRATION_GUIDE.md)** - Complete guide for Bitcoin integration
- **[docs/BITCOIN_API_REFERENCE.md](./docs/BITCOIN_API_REFERENCE.md)** - Bitcoin API reference
- **[docs/BITCOIN_BEST_PRACTICES.md](./docs/BITCOIN_BEST_PRACTICES.md)** - Best practices for production deployments
- **[docs/BITCOIN_TROUBLESHOOTING.md](./docs/BITCOIN_TROUBLESHOOTING.md)** - Troubleshooting common issues

## Development

This is a monorepo managed with [Turborepo](https://turbo.build/repo) for efficient task orchestration.

```bash
# Install dependencies
bun install

# Build all packages (SDK + Apps)
bun run build

# Test all packages
bun test

# Lint all packages
bun run lint

# Start development servers
bun run dev

# Type check all packages
bun run check
```

### Monorepo Structure

```
sdk/
├── packages/
│   └── sdk/                # Main SDK package
└── apps/
    └── originals-explorer/ # Explorer application
```

### Turborepo Benefits

- **Intelligent caching**: Never rebuild the same code twice
- **Parallel execution**: Run tasks across packages simultaneously
- **Task dependencies**: Automatically build dependencies before dependents

For detailed information about using Turborepo, see [docs/TURBOREPO.md](./docs/TURBOREPO.md).

## License

MIT License - see LICENSE file for details.
