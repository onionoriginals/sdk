# Bitcoin Operations Integration Guide

A comprehensive guide to integrating Bitcoin operations into your application using the Originals SDK.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Basic Setup](#basic-setup)
- [Network Configuration](#network-configuration)
- [Creating Your First Inscription](#creating-your-first-inscription)
- [UTXO Management](#utxo-management)
- [Transaction Building](#transaction-building)
- [Inscription Transfers](#inscription-transfers)
- [Fee Management](#fee-management)
- [External Signer Integration](#external-signer-integration)
- [Production Deployment](#production-deployment)
- [Testing Strategies](#testing-strategies)

## Prerequisites

Before integrating Bitcoin operations, ensure you have:

- **Node.js**: Version 18 or higher
- **TypeScript**: Version 5.0 or higher (recommended)
- **Bitcoin Knowledge**: Basic understanding of UTXOs, addresses, and transactions
- **Ordinals Understanding**: Familiarity with inscription concepts
- **Test Funds**: Access to testnet/signet Bitcoin for testing

### Environment Variables

Create a `.env` file with the following:

```bash
# Network Configuration
BITCOIN_NETWORK=testnet                    # mainnet, testnet, signet, regtest

# Ordinals Provider
ORD_API_URL=https://testnet.ordinals.api   # Your Ordinals API endpoint

# Wallet (for development/testing only - use external signer in production)
BITCOIN_PRIVATE_KEY=your_testnet_wif       # WIF format

# Fee Oracle (optional)
MEMPOOL_SPACE_API=https://mempool.space/api

# External Signer (production)
PRIVY_APP_ID=your_privy_app_id
AWS_KMS_KEY_ID=your_kms_key_id
```

**IMPORTANT**: Never commit `.env` files to version control. Add to `.gitignore`:

```bash
# .gitignore
.env
.env.local
.env.*.local
*.key
*.pem
```

## Installation

### Using npm

```bash
npm install @originals/sdk
```

### Using yarn

```bash
yarn add @originals/sdk
```

### Using bun

```bash
bun add @originals/sdk
```

### TypeScript Configuration

Ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  }
}
```

## Basic Setup

### Step 1: Import the SDK

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';
```

### Step 2: Initialize for Development

For local development and testing, use the mock provider:

```typescript
const sdk = OriginalsSDK.create({
  network: 'regtest',
  enableLogging: true,
  ordinalsProvider: new OrdMockProvider()
});

// Validate configuration
sdk.validateBitcoinConfig(); // Throws if misconfigured
```

### Step 3: Initialize for Production

For production, use a real Ordinals provider:

```typescript
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: process.env.BITCOIN_NETWORK as 'mainnet' | 'testnet',
  ordinalsProvider: new OrdinalsClient({
    network: process.env.BITCOIN_NETWORK as 'mainnet' | 'testnet',
    apiUrl: process.env.ORD_API_URL!,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  }),
  feeOracle: {
    estimateFeeRate: async (targetBlocks = 6) => {
      const response = await fetch(
        `${process.env.MEMPOOL_SPACE_API}/v1/fees/recommended`
      );
      const fees = await response.json();
      return targetBlocks <= 1 ? fees.fastestFee : fees.halfHourFee;
    }
  }
});
```

## Network Configuration

### Understanding Bitcoin Networks

| Network | Purpose | Real Value | Best For |
|---------|---------|------------|----------|
| **mainnet** | Production Bitcoin | Yes | Live applications |
| **testnet** | Public test network | No | Integration testing |
| **signet** | Controlled test network | No | Reliable testing |
| **regtest** | Local regression testing | No | Unit testing |

### Network-Specific Setup

#### Mainnet (Production)

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: 'https://api.ordinals.com',
    walletPrivateKey: process.env.MAINNET_PRIVATE_KEY
  })
});

// CRITICAL: Triple-check addresses before mainnet operations
const isValid = sdk.bitcoin.validateBitcoinAddress(
  recipientAddress,
  'mainnet'
);

if (!isValid) {
  throw new Error('Invalid mainnet address');
}
```

#### Testnet (Public Testing)

```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'testnet',
    apiUrl: 'https://testnet.ordinals.com',
    walletPrivateKey: process.env.TESTNET_PRIVATE_KEY
  })
});

// Get testnet coins from faucets:
// - https://testnet-faucet.mempool.co/
// - https://bitcoinfaucet.uo1.net/
```

#### Signet (Controlled Testing)

```typescript
const sdk = OriginalsSDK.create({
  network: 'signet',
  ordinalsProvider: new OrdinalsClient({
    network: 'signet',
    apiUrl: 'https://signet.ordinals.com',
    walletPrivateKey: process.env.SIGNET_PRIVATE_KEY
  })
});

// Signet faucet: https://signetfaucet.com/
```

#### Regtest (Local Development)

```typescript
const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider()
});

// Perfect for unit tests - no real blockchain needed
```

## Creating Your First Inscription

### Step 1: Prepare Your Data

```typescript
// Text inscription
const textData = JSON.stringify({
  p: 'btco',
  op: 'create',
  name: 'My First Inscription'
});

// Image inscription
import { readFile } from 'fs/promises';
const imageData = await readFile('./artwork.png');

// JSON inscription
const jsonData = {
  type: 'digital-asset',
  title: 'Rare Pepe',
  creator: 'artist.eth'
};
```

### Step 2: Inscribe on Bitcoin

```typescript
try {
  const inscription = await sdk.bitcoin.inscribeData(
    textData,
    'text/plain;charset=utf-8',
    10 // Fee rate in sat/vB (optional)
  );

  console.log('Success!');
  console.log('Inscription ID:', inscription.inscriptionId);
  console.log('Satoshi:', inscription.satoshi);
  console.log('Transaction:', inscription.txid);
  console.log('Block Height:', inscription.blockHeight);

} catch (error) {
  console.error('Inscription failed:', error.message);

  if (error.code === 'INSUFFICIENT_FUNDS') {
    console.error('Need more Bitcoin in wallet');
  } else if (error.code === 'FEE_TOO_LOW') {
    console.error('Increase fee rate');
  }
}
```

### Step 3: Track Inscription Status

```typescript
// Get inscription details
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);

if (inscription) {
  console.log('Found:', inscription);
  console.log('Confirmations:', inscription.blockHeight ? '6+' : '0');
} else {
  console.log('Inscription not found or pending');
}

// Check for front-running (multiple inscriptions on same satoshi)
const isSafe = await sdk.bitcoin.preventFrontRunning(inscription.satoshi);
if (!isSafe) {
  console.warn('Warning: Multiple inscriptions detected on this satoshi!');
}
```

### Content Type Examples

```typescript
// Text
await sdk.bitcoin.inscribeData(text, 'text/plain;charset=utf-8');

// HTML
await sdk.bitcoin.inscribeData(html, 'text/html;charset=utf-8');

// JSON
await sdk.bitcoin.inscribeData(
  JSON.stringify(data),
  'application/json'
);

// PNG Image
await sdk.bitcoin.inscribeData(pngBuffer, 'image/png');

// SVG
await sdk.bitcoin.inscribeData(svg, 'image/svg+xml');

// Audio
await sdk.bitcoin.inscribeData(mp3Buffer, 'audio/mpeg');

// Video
await sdk.bitcoin.inscribeData(mp4Buffer, 'video/mp4');
```

## UTXO Management

### Understanding UTXOs

UTXOs (Unspent Transaction Outputs) are the fundamental units in Bitcoin. Each UTXO:
- Has a specific value (in satoshis)
- Can only be spent once
- May contain an Ordinals inscription
- Requires a signature to spend

### Fetching UTXOs

```typescript
// You need to fetch UTXOs from your wallet or indexer
// This is outside the SDK scope, but here's a typical pattern:

async function fetchUtxos(address: string): Promise<Utxo[]> {
  const response = await fetch(
    `https://your-indexer.com/address/${address}/utxos`
  );
  const data = await response.json();

  return data.map(utxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    value: utxo.value, // satoshis
    address: address,
    scriptPubKey: utxo.scriptPubKey
  }));
}

const utxos = await fetchUtxos(walletAddress);
```

### Basic UTXO Selection

```typescript
import { selectUtxos } from '@originals/sdk';

// Simple selection (amount in satoshis)
const result = selectUtxos(utxos, {
  requiredAmount: 100000, // 0.001 BTC
  strategy: 'minimize_inputs'
});

console.log('Selected UTXOs:', result.selectedUtxos);
console.log('Total input:', result.totalInput);
console.log('Change:', result.change);
```

### Resource-Aware Selection

**CRITICAL**: Always use resource-aware selection to avoid spending inscribed UTXOs:

```typescript
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// Step 1: Tag UTXOs with inscription data
const inscriptions = await fetchInscriptions(address);
const resourceData = inscriptions.map(ins => ({
  utxo: { txid: ins.txid, vout: ins.vout },
  resourceType: 'inscription',
  resourceId: ins.inscriptionId
}));

const taggedUtxos = tagResourceUtxos(utxos, resourceData);

// Step 2: Select UTXOs (automatically avoids inscribed ones)
const result = selectResourceUtxos(taggedUtxos, {
  requiredAmount: 50000,
  feeRate: 10,
  strategy: 'optimize_size',
  preference: 'closest' // or 'oldest'
});

console.log('Selected regular UTXOs:', result.selectedUtxos);
console.log('Inscribed UTXOs preserved:', result.resourceUtxos);
```

### Payment-Specific Selection

```typescript
import { selectUtxosForPayment } from '@originals/sdk';

// Optimized for payments
const result = selectUtxosForPayment(
  taggedUtxos,
  requiredAmount,
  feeRate
);

if (!result.success) {
  console.error('Selection failed:', result.error);
  console.error('Available:', result.totalAvailable);
  console.error('Required:', requiredAmount);
}
```

### Selection Strategies

```typescript
// Minimize number of inputs (lower fees)
selectResourceUtxos(utxos, {
  requiredAmount: 100000,
  feeRate: 10,
  strategy: 'minimize_inputs'
});

// Minimize change output (cleaner UTXO set)
selectResourceUtxos(utxos, {
  requiredAmount: 100000,
  feeRate: 10,
  strategy: 'minimize_change'
});

// Optimize transaction size (balance of both)
selectResourceUtxos(utxos, {
  requiredAmount: 100000,
  feeRate: 10,
  strategy: 'optimize_size'
});
```

## Transaction Building

### Building a Transfer Transaction

```typescript
import { buildTransferTransaction } from '@originals/sdk';

const { tx, selection } = buildTransferTransaction(
  availableUtxos,
  recipientAddress,
  amountSats,
  feeRateSatsPerVb,
  {
    // Optional: UTXOs to exclude from selection
    excludeUtxos: [
      { txid: 'abc...', vout: 0 }
    ],

    // Optional: Change address (defaults to first input address)
    changeAddress: 'your-change-address',

    // Optional: Dust threshold (default: 546 sats)
    dustThreshold: 546
  }
);

console.log('Transaction:', tx);
console.log('Selected UTXOs:', selection.selectedUtxos);
console.log('Fee:', tx.fee);
```

### Transaction Structure

```typescript
interface BitcoinTransaction {
  txid: string;
  vin: Array<{
    txid: string;
    vout: number;
    scriptSig?: string;
    sequence?: number;
  }>;
  vout: Array<{
    value: number;
    scriptPubKey: string;
    address?: string;
  }>;
  fee: number;
  blockHeight?: number;
  confirmations?: number;
}
```

### Broadcasting Transactions

The SDK handles broadcasting through the configured provider:

```typescript
// Inscriptions are automatically broadcast
const inscription = await sdk.bitcoin.inscribeData(data, contentType);

// Transfers are automatically broadcast
const tx = await sdk.bitcoin.transferInscription(inscription, newAddress);

// Custom broadcast (advanced)
// You'll typically use the provider's broadcast method
const txid = await ordinalsProvider.broadcastTransaction(signedTxHex);
```

## Inscription Transfers

### Basic Transfer

```typescript
// Get the inscription to transfer
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);

if (!inscription) {
  throw new Error('Inscription not found');
}

// Transfer to new owner
const transferTx = await sdk.bitcoin.transferInscription(
  inscription,
  buyerAddress
);

console.log('Transfer complete:', transferTx.txid);
console.log('Inscription now at:', buyerAddress);
```

### Transfer with Custom Fee

```typescript
const transferTx = await sdk.bitcoin.transferInscription(
  inscription,
  buyerAddress,
  { feeRate: 20 } // Higher priority
);
```

### Batch Transfers

```typescript
// Transfer multiple inscriptions
const inscriptions = await Promise.all(
  inscriptionIds.map(id => sdk.bitcoin.trackInscription(id))
);

const transfers = [];
for (const inscription of inscriptions) {
  if (inscription) {
    const tx = await sdk.bitcoin.transferInscription(
      inscription,
      recipientAddress
    );
    transfers.push(tx);

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

console.log(`Transferred ${transfers.length} inscriptions`);
```

### Verifying Transfer

```typescript
// After transfer, verify the inscription moved
await new Promise(resolve => setTimeout(resolve, 60000)); // Wait for confirmation

const updatedInscription = await sdk.bitcoin.trackInscription(inscriptionId);

if (updatedInscription) {
  console.log('Inscription location:', updatedInscription.txid);
  console.log('Confirmations:', updatedInscription.blockHeight ? '✓' : 'Pending');
}
```

## Fee Management

### Understanding Fee Rates

Fee rates in Bitcoin are measured in **satoshis per virtual byte (sat/vB)**:

- **1-3 sat/vB**: Low priority (hours to days)
- **4-10 sat/vB**: Medium priority (1-6 hours)
- **11-20 sat/vB**: High priority (10-60 minutes)
- **20+ sat/vB**: Urgent (next block)

### Automatic Fee Estimation

```typescript
// SDK uses fee oracle if configured
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: ordinalsClient,
  feeOracle: {
    estimateFeeRate: async (targetBlocks = 6) => {
      const response = await fetch(
        'https://mempool.space/api/v1/fees/recommended'
      );
      const fees = await response.json();

      // Target blocks -> fee rate mapping
      if (targetBlocks <= 1) return fees.fastestFee;
      if (targetBlocks <= 3) return fees.halfHourFee;
      return fees.hourFee;
    }
  }
});

// Inscription uses oracle fee rate automatically
const inscription = await sdk.bitcoin.inscribeData(data, contentType);
```

### Manual Fee Specification

```typescript
// Override with manual fee rate
const inscription = await sdk.bitcoin.inscribeData(
  data,
  contentType,
  15 // sat/vB
);
```

### Fee Calculation

```typescript
import { calculateFee, estimateTransactionSize } from '@originals/sdk';

// Estimate transaction size
const vsize = estimateTransactionSize(
  inputCount,
  outputCount
);

// Calculate fee
const feeSats = calculateFee(vsize, feeRate);

console.log(`Transaction: ${vsize} vBytes`);
console.log(`Fee rate: ${feeRate} sat/vB`);
console.log(`Total fee: ${feeSats} sats (${feeSats / 100_000_000} BTC)`);
```

### Fallback Chain

The SDK uses a three-tier fallback for fee estimation:

1. **Fee Oracle** (if configured)
2. **Ordinals Provider** `estimateFee()` method
3. **User-provided rate** or default minimum (1.1 sat/vB)

```typescript
// Fallback behavior
try {
  feeRate = await feeOracle.estimateFeeRate(targetBlocks);
} catch {
  try {
    feeRate = await ordinalsProvider.estimateFee(targetBlocks);
  } catch {
    feeRate = manualFeeRate || 1.1; // Minimum relay fee
  }
}
```

## External Signer Integration

### Why Use External Signers?

External signers provide:
- **Hardware security**: Keys never leave HSM/secure enclave
- **Compliance**: SOC 2, ISO 27001, PCI DSS requirements
- **Multi-party signing**: MPC wallets and threshold signatures
- **Audit trails**: All signing operations logged
- **Key rotation**: Seamless without code changes

### ExternalSigner Interface

```typescript
interface ExternalSigner {
  /**
   * Sign document and return proof
   */
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;

  /**
   * Get verification method identifier
   */
  getVerificationMethodId(): Promise<string> | string;
}
```

### Privy Integration

```typescript
import { PrivyClient } from '@privy-io/server-auth';

class PrivySigner implements ExternalSigner {
  constructor(
    private privyClient: PrivyClient,
    private userId: string,
    private walletId: string,
    private verificationMethodId: string
  ) {}

  async sign({ document, proof }) {
    // Privy signs the document
    const signature = await this.privyClient.wallets.sign({
      userId: this.userId,
      walletId: this.walletId,
      message: JSON.stringify(document)
    });

    return { proofValue: signature };
  }

  getVerificationMethodId() {
    return this.verificationMethodId;
  }
}

// Usage
const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

const signer = new PrivySigner(
  privyClient,
  userId,
  walletId,
  verificationMethodId
);

const result = await sdk.did.createDIDWebVH({
  domain: 'example.com',
  paths: ['alice'],
  externalSigner: signer,
  verificationMethods: [{
    type: 'Multikey',
    publicKeyMultibase: publicKey
  }],
  updateKeys: [`did:key:${publicKey}`],
  outputDir: './public/.well-known'
});
```

### AWS KMS Integration

```typescript
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';

class AWSKMSSigner implements ExternalSigner {
  private kmsClient: KMSClient;

  constructor(
    private keyId: string,
    private verificationMethodId: string
  ) {
    this.kmsClient = new KMSClient({ region: 'us-east-1' });
  }

  async sign({ document, proof }) {
    const message = Buffer.from(JSON.stringify(document));

    const command = new SignCommand({
      KeyId: this.keyId,
      Message: message,
      SigningAlgorithm: 'ECDSA_SHA_256'
    });

    const response = await this.kmsClient.send(command);
    const signature = Buffer.from(response.Signature!).toString('base64');

    return { proofValue: signature };
  }

  getVerificationMethodId() {
    return this.verificationMethodId;
  }
}

// Usage
const signer = new AWSKMSSigner(
  process.env.AWS_KMS_KEY_ID!,
  verificationMethodId
);
```

### Hardware Security Module (HSM)

```typescript
class HSMSigner implements ExternalSigner {
  constructor(
    private hsmSession: HSMSession,
    private keyLabel: string,
    private verificationMethodId: string
  ) {}

  async sign({ document, proof }) {
    const message = Buffer.from(JSON.stringify(document));

    const signature = await this.hsmSession.sign({
      keyLabel: this.keyLabel,
      message,
      algorithm: 'ECDSA-SHA256'
    });

    return {
      proofValue: Buffer.from(signature).toString('base64')
    };
  }

  getVerificationMethodId() {
    return this.verificationMethodId;
  }
}
```

## Production Deployment

### Environment Configuration

```typescript
// config/production.ts
export const productionConfig = {
  network: 'mainnet' as const,
  ordinalsProvider: {
    apiUrl: process.env.ORD_API_URL!,
    timeout: 30000,
    retries: 3
  },
  feeOracle: {
    url: process.env.FEE_ORACLE_URL!,
    fallbackRate: 10 // Conservative fallback
  },
  security: {
    useExternalSigner: true,
    requireMFA: true,
    maxTransactionValue: 1_000_000 // sats
  },
  monitoring: {
    enableAlerts: true,
    alertThreshold: 50_000 // sats
  }
};

// Validate all required environment variables
const requiredEnvVars = [
  'ORD_API_URL',
  'FEE_ORACLE_URL',
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
```

### Error Handling

```typescript
import { StructuredError } from '@originals/sdk';

async function inscribeWithRetry(data: any, contentType: string) {
  const maxRetries = 3;
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const inscription = await sdk.bitcoin.inscribeData(
        data,
        contentType
      );
      return inscription;

    } catch (error) {
      lastError = error;

      if (error instanceof StructuredError) {
        // Don't retry these errors
        if (error.code === 'INVALID_ADDRESS') throw error;
        if (error.code === 'INSUFFICIENT_FUNDS') throw error;

        // Retry network/temporary errors
        if (error.code === 'NETWORK_ERROR') {
          await new Promise(resolve =>
            setTimeout(resolve, 1000 * Math.pow(2, i))
          );
          continue;
        }
      }

      throw error;
    }
  }

  throw lastError!;
}
```

### Monitoring and Alerts

```typescript
// monitoring/bitcoin-ops.ts
export class BitcoinOperationsMonitor {
  async trackInscription(inscriptionId: string) {
    const startTime = Date.now();

    try {
      const inscription = await sdk.bitcoin.inscribeData(data, contentType);

      // Log success metrics
      this.logMetric({
        operation: 'inscription',
        status: 'success',
        duration: Date.now() - startTime,
        inscriptionId: inscription.inscriptionId,
        fee: inscription.fee
      });

      return inscription;

    } catch (error) {
      // Log failure metrics
      this.logMetric({
        operation: 'inscription',
        status: 'failure',
        duration: Date.now() - startTime,
        error: error.message
      });

      // Alert on high-value failures
      if (error.code === 'INSUFFICIENT_FUNDS') {
        await this.sendAlert({
          severity: 'high',
          message: 'Bitcoin wallet insufficient funds',
          action: 'Top up wallet immediately'
        });
      }

      throw error;
    }
  }
}
```

### Rate Limiting

```typescript
import pLimit from 'p-limit';

// Limit concurrent Bitcoin operations
const limit = pLimit(3);

const inscriptions = await Promise.all(
  dataItems.map(item =>
    limit(() => sdk.bitcoin.inscribeData(item.data, item.contentType))
  )
);
```

## Testing Strategies

### Unit Testing

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

describe('Bitcoin Operations', () => {
  let sdk: OriginalsSDK;

  beforeEach(() => {
    sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: new OrdMockProvider()
    });
  });

  it('should inscribe data', async () => {
    const data = { test: 'data' };
    const inscription = await sdk.bitcoin.inscribeData(
      JSON.stringify(data),
      'application/json'
    );

    expect(inscription.inscriptionId).toBeDefined();
    expect(inscription.txid).toBeDefined();
    expect(inscription.contentType).toBe('application/json');
  });

  it('should transfer inscription', async () => {
    const inscription = await sdk.bitcoin.inscribeData('test', 'text/plain');
    const tx = await sdk.bitcoin.transferInscription(
      inscription,
      'tb1qxyz...'
    );

    expect(tx.txid).toBeDefined();
    expect(tx.vin.length).toBeGreaterThan(0);
    expect(tx.vout.length).toBeGreaterThan(0);
  });
});
```

### Integration Testing

```typescript
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

describe('Bitcoin Integration Tests', () => {
  const sdk = OriginalsSDK.create({
    network: 'signet',
    ordinalsProvider: new OrdinalsClient({
      network: 'signet',
      apiUrl: process.env.SIGNET_API_URL!,
      walletPrivateKey: process.env.SIGNET_PRIVATE_KEY!
    })
  });

  it('should inscribe on signet', async () => {
    const inscription = await sdk.bitcoin.inscribeData(
      'Integration test',
      'text/plain'
    );

    // Verify on blockchain
    const retrieved = await sdk.bitcoin.trackInscription(
      inscription.inscriptionId
    );

    expect(retrieved).toBeDefined();
    expect(retrieved!.inscriptionId).toBe(inscription.inscriptionId);
  }, 120000); // 2 minute timeout
});
```

### End-to-End Testing

```typescript
describe('Full Asset Lifecycle', () => {
  it('should create, inscribe, and transfer asset', async () => {
    // Create asset
    const resources = [{
      id: 'test-asset',
      type: 'image',
      contentType: 'image/png',
      hash: 'sha256-...'
    }];

    const asset = await sdk.lifecycle.createAsset(resources);
    expect(asset.did).toMatch(/^did:peer:/);

    // Inscribe on Bitcoin
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(asset.did).toMatch(/^did:btco:/);

    // Transfer ownership
    const transferResult = await sdk.lifecycle.transferOwnership(
      asset,
      'buyer-bitcoin-address'
    );

    // Verify transfer completed
    expect(transferResult).toBeDefined();
    expect(asset.did).toMatch(/^did:btco:/);
  }, 180000); // 3 minute timeout
});
```

## Next Steps

- **API Reference**: See [BITCOIN_API_REFERENCE.md](./BITCOIN_API_REFERENCE.md) for complete API documentation
- **Best Practices**: Read [BITCOIN_BEST_PRACTICES.md](./BITCOIN_BEST_PRACTICES.md) for security and optimization tips
- **Troubleshooting**: Check [BITCOIN_TROUBLESHOOTING.md](./BITCOIN_TROUBLESHOOTING.md) for common issues
- **Examples**: Explore the [examples/](../examples/) directory for working code samples

## Support

- **Documentation**: [https://docs.originals.io](https://docs.originals.io)
- **GitHub Issues**: [https://github.com/onionoriginals/sdk/issues](https://github.com/onionoriginals/sdk/issues)
- **Discord**: [https://discord.gg/originals](https://discord.gg/originals)
