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
import { OriginalsSDK } from '@originals/sdk';

const originals = OriginalsSDK.create({
  network: 'testnet',
  enableLogging: true
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

### Core Classes

- **OriginalsSDK** - Main entry point and orchestration
- **OriginalsAsset** - Represents a digital asset through its lifecycle
- **DIDManager** - DID document creation and resolution
- **CredentialManager** - Verifiable Credential handling
- **LifecycleManager** - Asset migration between layers
- **BitcoinManager** - Bitcoin/Ordinals integration

### Key Features

- ✅ W3C DID and Verifiable Credential compliance
- ✅ Multibase key encoding (no JSON Web Keys)
- ✅ JSON-LD credential signing (no JWT)
- ✅ Bitcoin Ordinals inscription support
- ✅ Three-layer asset lifecycle management: `did:peer` → `did:webvh` → `did:btco`
- ✅ Cryptographic provenance verification
- ✅ Front-running protection via unique satoshi assignment

## Use Cases

### Digital Art
Artists create private assets for experimentation, publish for discovery, and inscribe on Bitcoin upon sale.

### Scientific Data
Researchers document datasets privately, publish for peer review, and anchor provenance on Bitcoin for permanent record.

### DAO Governance  
Issue member credentials privately, make public for recognition, and inscribe key decisions for immutable governance record.

### Supply Chain
Manufacturers create product credentials, publish public registries, and inscribe final ownership for anti-counterfeiting.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test  
npm test

# Lint
npm run lint
```

## License

MIT License - see LICENSE file for details.


