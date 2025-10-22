# Bitcoin Operations Guide

A comprehensive guide to understanding Bitcoin operations in the Originals SDK, covering core concepts, workflows, and advanced patterns.

## Table of Contents

- [Core Concepts](#core-concepts)
- [Understanding UTXOs](#understanding-utxos)
- [Ordinals Inscriptions](#ordinals-inscriptions)
- [Transaction Lifecycle](#transaction-lifecycle)
- [Fee Management](#fee-management)
- [Address Types and Networks](#address-types-and-networks)
- [Resource-Aware Operations](#resource-aware-operations)
- [Advanced Workflows](#advanced-workflows)

## Core Concepts

### The Bitcoin UTXO Model

Bitcoin uses an **Unspent Transaction Output (UTXO)** model, fundamentally different from account-based systems like Ethereum.

#### Key Principles

1. **No Balances**: Bitcoin doesn't track account balances. Your "balance" is the sum of all UTXOs you can spend.

2. **Immutable Outputs**: Once created, a UTXO can only be:
   - Spent in full (creating new UTXOs)
   - Left unspent

3. **No Partial Spending**: You can't spend "part" of a UTXO. You must spend the entire UTXO and create change.

#### Example

```
Alice has 2 UTXOs:
  - UTXO A: 0.5 BTC
  - UTXO B: 0.3 BTC
  Total: 0.8 BTC

Alice wants to send 0.6 BTC to Bob:
  1. Select UTXOs totaling ≥ 0.6 BTC + fees
  2. Spend UTXO A (0.5 BTC) + UTXO B (0.3 BTC) = 0.8 BTC
  3. Create outputs:
     - Output 1: 0.6 BTC to Bob
     - Output 2: 0.1995 BTC to Alice (change)
     - Fee: 0.0005 BTC to miners
```

### Satoshis and Ordinals

**Satoshi** is the smallest Bitcoin unit: 1 BTC = 100,000,000 satoshis

**Ordinals Theory** assigns a unique identity to each satoshi based on its mining order. This enables:
- NFT-like inscriptions on individual satoshis
- Tracking specific satoshis through transactions
- Creating digital artifacts with Bitcoin-level security

```
Satoshi #2099994106992659 (the 2,099,994,106,992,659th satoshi ever mined)
  └─ Can have data "inscribed" on it
  └─ Transferred with the UTXO containing it
  └─ Uniquely identifiable forever
```

### DID:BTCO Identifiers

The SDK uses `did:btco` DIDs to represent assets inscribed on Bitcoin:

```
did:btco:2099994106992659
         └─ Satoshi identifier
```

This DID:
- Points to a specific satoshi
- Resolves to all inscriptions on that satoshi
- Enables cryptographic asset ownership verification
- Persists as long as Bitcoin exists

## Understanding UTXOs

### UTXO Structure

```typescript
interface Utxo {
  txid: string;              // Transaction that created this output
  vout: number;              // Output index in that transaction
  value: number;             // Value in satoshis
  scriptPubKey?: string;     // Locking script
  address?: string;          // Bitcoin address (if standard)
  inscriptions?: string[];   // Inscription IDs (if any)
  locked?: boolean;          // Wallet lock status
}
```

### UTXO Lifecycle

```
1. Creation
   └─ Transaction output becomes UTXO
   └─ Added to UTXO set

2. Unspent State
   └─ Available for spending
   └─ Part of network's UTXO set

3. Spending
   └─ Consumed as transaction input
   └─ Removed from UTXO set
   └─ Creates new UTXOs for recipients and change

4. Confirmation
   └─ Included in block
   └─ Gains confirmations as new blocks added
   └─ 6+ confirmations = very secure
```

### UTXO Selection Strategies

The SDK provides three selection strategies:

#### 1. Minimize Inputs

**Goal**: Use fewest UTXOs possible

**Best For**:
- Reducing transaction size
- Minimizing fees
- Privacy (fewer input addresses revealed)

**Algorithm**: Select largest UTXOs first

```typescript
import { selectUtxos } from '@originals/sdk';

const result = selectUtxos(utxos, {
  requiredAmount: 100000,
  strategy: 'minimize_inputs'
});

// Example: Requires 100,000 sats
// Has UTXOs: [150000, 80000, 50000, 30000]
// Selects: [150000]
// Minimizes inputs (1 instead of 2+)
```

#### 2. Minimize Change

**Goal**: Produce least change output value

**Best For**:
- Reducing UTXO fragmentation
- Cleaner UTXO set management
- Avoiding dust

**Algorithm**: Find combination closest to required amount

```typescript
const result = selectUtxos(utxos, {
  requiredAmount: 100000,
  strategy: 'minimize_change'
});

// Example: Requires 100,000 sats
// Has UTXOs: [150000, 80000, 50000, 30000]
// Selects: [80000, 30000] = 110,000
// Change: 10,000 (vs 50,000 with minimize_inputs)
```

#### 3. Optimize Size

**Goal**: Balance between inputs and change

**Best For**:
- General-purpose transactions
- Balanced fee optimization
- Most common use case

**Algorithm**: Heuristic combining both strategies

```typescript
const result = selectUtxos(utxos, {
  requiredAmount: 100000,
  strategy: 'optimize_size'
});
```

### Resource-Aware Selection

**CRITICAL**: Regular UTXO selection might accidentally spend inscribed satoshis, losing your NFTs!

The SDK provides **resource-aware selection** that automatically preserves inscribed UTXOs:

```typescript
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// Step 1: Tag UTXOs with inscription data
const inscriptionData = [
  {
    utxo: { txid: 'abc...', vout: 0 },
    resourceType: 'inscription',
    resourceId: 'inscription_id_1'
  }
];

const taggedUtxos = tagResourceUtxos(utxos, inscriptionData);

// Step 2: Selection automatically avoids inscribed UTXOs
const result = selectResourceUtxos(taggedUtxos, {
  requiredAmount: 50000,
  feeRate: 10,
  strategy: 'optimize_size'
});

console.log('Spent:', result.selectedUtxos);      // Regular UTXOs only
console.log('Preserved:', result.resourceUtxos);  // Inscribed UTXOs safe
```

## Ordinals Inscriptions

### What Are Inscriptions?

Inscriptions are data stored on specific satoshis using Bitcoin's witness data structure. Think of them as NFTs, but:
- Stored directly on Bitcoin (not IPFS or other storage)
- Immutable and permanent
- No smart contracts needed
- Transferable with the satoshi

### Inscription Anatomy

```
Inscription
├─ Satoshi: 2099994106992659 (unique identifier)
├─ Content: [Binary data, text, JSON, image, etc.]
├─ Content Type: image/png, text/plain, application/json, etc.
├─ Genesis Transaction: txid where it was created
├─ Current Location: txid:vout where it currently resides
└─ Block Height: When it was confirmed (if confirmed)
```

### Creating Inscriptions

```typescript
// Text inscription
const textInscription = await sdk.bitcoin.inscribeData(
  'Hello, Bitcoin!',
  'text/plain;charset=utf-8'
);

// JSON inscription (metadata)
const jsonInscription = await sdk.bitcoin.inscribeData(
  JSON.stringify({
    p: 'btco',
    op: 'mint',
    tick: 'RARE',
    amt: '1000'
  }),
  'application/json'
);

// Image inscription
import { readFile } from 'fs/promises';
const imageData = await readFile('./art.png');
const imageInscription = await sdk.bitcoin.inscribeData(
  imageData,
  'image/png'
);

// SVG inscription
const svgInscription = await sdk.bitcoin.inscribeData(
  '<svg>...</svg>',
  'image/svg+xml'
);
```

### Supported Content Types

| Category | MIME Type | Example |
|----------|-----------|---------|
| **Text** | `text/plain` | Plain text notes |
| | `text/html` | HTML pages |
| | `text/markdown` | Markdown documents |
| **Data** | `application/json` | Metadata, protocols |
| | `application/yaml` | Configuration |
| | `application/pdf` | Documents |
| **Images** | `image/png` | PNG images |
| | `image/jpeg` | JPEG photos |
| | `image/gif` | GIF animations |
| | `image/svg+xml` | Vector graphics |
| | `image/webp` | WebP images |
| **Audio** | `audio/mpeg` | MP3 audio |
| | `audio/wav` | WAV audio |
| | `audio/flac` | FLAC audio |
| **Video** | `video/mp4` | MP4 video |
| | `video/webm` | WebM video |
| **3D** | `model/gltf+json` | 3D models |

### Tracking Inscriptions

```typescript
// Get inscription details
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);

if (inscription) {
  console.log('Satoshi:', inscription.satoshi);
  console.log('Content Type:', inscription.contentType);
  console.log('Location:', `${inscription.txid}:${inscription.vout}`);
  console.log('Confirmed:', inscription.blockHeight ? 'Yes' : 'No');

  // Get content
  const content = inscription.content.toString('utf-8');
  console.log('Content:', content);
}
```

**Note:** To query all inscriptions on a specific satoshi, you would need to access the Ordinals provider directly. The SDK's `preventFrontRunning()` method uses this functionality internally to check for multiple inscriptions.

### Front-Running Protection

Multiple inscriptions can exist on the same satoshi. The SDK provides front-running detection:

```typescript
const isSafe = await sdk.bitcoin.preventFrontRunning(satoshi);

if (!isSafe) {
  console.warn('WARNING: Multiple inscriptions detected!');
  console.warn('This satoshi may have been front-run');
  console.warn('Use external Ordinals explorer to inspect all inscriptions');
}
```

### Transferring Inscriptions

Inscriptions transfer with the satoshi they're on:

```typescript
// Get inscription to transfer
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);

// Transfer to new owner
const transferTx = await sdk.bitcoin.transferInscription(
  inscription,
  'bc1qnewowner...'
);

console.log('Transfer TX:', transferTx.txid);

// The inscription is now at the new address
// Verify after confirmation
setTimeout(async () => {
  const updated = await sdk.bitcoin.trackInscription(inscriptionId);
  console.log('New location:', updated.txid);
}, 60000);
```

## Transaction Lifecycle

### 1. Construction

```typescript
import { buildTransferTransaction } from '@originals/sdk';

// Build transaction with automatic UTXO selection
const { tx, selection } = buildTransferTransaction(
  availableUtxos,
  recipientAddress,
  amountSats,
  feeRateSatsPerVb
);
```

**What Happens:**
1. UTXO selection algorithm runs
2. Inputs selected to cover amount + estimated fee
3. Outputs created (recipient + change if needed)
4. Fee calculated based on actual tx size
5. Change calculation adjusted for precise fee

### 2. Signing

**With SDK-managed keys:**
```typescript
// Signing happens automatically in provider
const inscription = await sdk.bitcoin.inscribeData(data, contentType);
```

**With external signer:**
```typescript
const signer = new MyExternalSigner();
const signedTx = await signer.sign({
  document: tx,
  proof: { /* signing parameters */ }
});
```

### 3. Broadcasting

```typescript
// Automatic broadcast through provider
const inscription = await sdk.bitcoin.inscribeData(data, contentType);
// Returns when transaction is broadcast and confirmed
```

**Manual broadcast (advanced):**
```typescript
const txid = await ordinalsProvider.broadcastTransaction(signedTxHex);
console.log('Broadcast TX:', txid);
```

### 4. Confirmation

```
Broadcast
  ↓
Mempool (unconfirmed)
  ↓
Block 1 (1 confirmation)  ← First confirmation
  ↓
Block 2 (2 confirmations)
  ↓
Block 3 (3 confirmations)
  ↓
Block 4 (4 confirmations)
  ↓
Block 5 (5 confirmations)
  ↓
Block 6 (6 confirmations) ← Generally considered final
```

**Confirmation Levels:**
- **0 confirmations**: In mempool, can be replaced (RBF)
- **1 confirmation**: In a block, but could be orphaned
- **3 confirmations**: Very unlikely to reverse (~30 min)
- **6 confirmations**: Standard for high-value (~1 hour)
- **100 confirmations**: Coinbase maturity (newly mined BTC)

### 5. Verification

```typescript
// Check transaction status
const status = await ordinalsProvider.getTransactionStatus(txid);

console.log('Confirmed:', status.confirmed);
console.log('Block Height:', status.blockHeight);
console.log('Confirmations:', status.confirmations);

// For inscriptions specifically
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);
console.log('Inscription confirmed:', inscription?.blockHeight !== undefined);
```

## Fee Management

### Understanding Bitcoin Fees

Fees are determined by:
1. **Transaction size** (in virtual bytes, vBytes)
2. **Fee rate** (satoshis per vByte, sat/vB)

```
Total Fee = Transaction Size (vBytes) × Fee Rate (sat/vB)
```

### Fee Rate Guidelines

| Priority | Fee Rate | Confirmation Time | Use Case |
|----------|----------|-------------------|----------|
| Low | 1-3 sat/vB | Hours to days | Non-urgent |
| Medium | 4-10 sat/vB | 1-6 hours | Normal operations |
| High | 11-20 sat/vB | 10-60 minutes | Time-sensitive |
| Urgent | 20+ sat/vB | Next block (~10 min) | Critical transfers |

**Network Conditions**: These are guidelines. Actual confirmation times depend on mempool congestion.

### Fee Estimation

The SDK uses a three-tier fallback system:

```typescript
// 1. Fee Oracle (if configured)
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider,
  feeOracle: {
    estimateFeeRate: async (targetBlocks = 6) => {
      const response = await fetch(
        'https://mempool.space/api/v1/fees/recommended'
      );
      const fees = await response.json();
      return targetBlocks <= 1 ? fees.fastestFee : fees.halfHourFee;
    }
  }
});

// 2. Ordinals Provider estimateFee() method (fallback)

// 3. Manual fee rate or minimum (1.1 sat/vB) (last resort)
```

### Manual Fee Control

```typescript
// Specify exact fee rate
const inscription = await sdk.bitcoin.inscribeData(
  data,
  contentType,
  25 // 25 sat/vB - high priority
);

// Calculate fee for planning
import { estimateFeeSats } from '@originals/sdk';

const estimatedFee = estimateFeeSats(
  3, // inputs
  2, // outputs
  15 // fee rate
);

console.log('Estimated fee:', estimatedFee.toString(), 'sats');
console.log('In BTC:', Number(estimatedFee) / 100_000_000);
```

### Dust Limits

**Dust**: Outputs too small to be economically spendable

**Dust Threshold**: 546 satoshis (enforced by Bitcoin network)

```typescript
// SDK automatically handles dust
const result = selectResourceUtxos(utxos, {
  requiredAmount: 100000,
  feeRate: 10,
  dustThreshold: 546 // Default
});

// If change < 546 sats, it's added to fee instead of creating dust output
if (result.change < 546) {
  console.log('Change added to fee to avoid dust');
}
```

## Address Types and Networks

### Address Types

| Type | Prefix | Example | SegWit | Best For |
|------|--------|---------|--------|----------|
| **Legacy (P2PKH)** | `1` | `1A1zP1e...` | No | Legacy compatibility |
| **P2SH** | `3` | `3J98t1W...` | Sometimes | Multi-sig, scripts |
| **Native SegWit (Bech32)** | `bc1` | `bc1qxyz...` | Yes | Lowest fees |
| **Taproot (Bech32m)** | `bc1p` | `bc1pxyz...` | Yes | Privacy, efficiency |

**Recommendation**: Use **Native SegWit (bc1...)** for:
- Lower transaction fees (40% cheaper than legacy)
- Better security
- Modern wallet support
- Ordinals compatibility

### Network Prefixes

| Network | Native SegWit | Legacy | Purpose |
|---------|---------------|--------|---------|
| **Mainnet** | `bc1...` | `1...` / `3...` | Production |
| **Testnet** | `tb1...` | `m...` / `2...` | Testing |
| **Signet** | `tb1...` | `m...` / `2...` | Controlled testing |
| **Regtest** | `bcrt1...` | - | Local development |

### Address Validation

```typescript
// Validate address for specific network
const isValid = sdk.bitcoin.validateBitcoinAddress(
  'bc1qxyz...',
  'mainnet'
);

if (!isValid) {
  throw new Error('Invalid mainnet address');
}

// Common mistakes caught:
// ❌ Using testnet address on mainnet
const wrong1 = sdk.bitcoin.validateBitcoinAddress('tb1q...', 'mainnet');
console.log(wrong1); // false

// ❌ Typos in address
const wrong2 = sdk.bitcoin.validateBitcoinAddress('bc1qxyzABC', 'mainnet');
console.log(wrong2); // false (checksum fails)

// ✅ Correct
const correct = sdk.bitcoin.validateBitcoinAddress(
  'bc1q...[valid address]',
  'mainnet'
);
console.log(correct); // true
```

### Network Selection

```typescript
// Development: regtest with mock provider
const devSdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider()
});

// Testing: signet or testnet
const testSdk = OriginalsSDK.create({
  network: 'signet',
  ordinalsProvider: new OrdinalsClient({
    network: 'signet',
    apiUrl: process.env.SIGNET_API_URL,
    walletPrivateKey: process.env.SIGNET_PRIVATE_KEY
  })
});

// Production: mainnet
const prodSdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.MAINNET_API_URL,
    walletPrivateKey: process.env.MAINNET_PRIVATE_KEY
  })
});
```

## Resource-Aware Operations

### The Problem

Without resource awareness, coin selection might accidentally:
- Spend UTXOs containing valuable inscriptions
- Transfer NFTs when trying to send regular Bitcoin
- Fragment or lose rare satoshis

### The Solution

Resource-aware selection distinguishes between:
- **Resource UTXOs**: Contain inscriptions, runes, or rare sats
- **Regular UTXOs**: Plain Bitcoin, safe to spend

### Workflow

```typescript
import {
  selectResourceUtxos,
  tagResourceUtxos,
  selectUtxosForPayment
} from '@originals/sdk';

// 1. Fetch your UTXOs
const utxos = await fetchUtxosFromWallet(address);

// 2. Fetch inscription data
const inscriptions = await fetchInscriptionsForAddress(address);

// 3. Tag UTXOs with resource information
const resourceData = inscriptions.map(ins => ({
  utxo: { txid: ins.txid, vout: ins.vout },
  resourceType: 'inscription',
  resourceId: ins.inscriptionId
}));

const taggedUtxos = tagResourceUtxos(utxos, resourceData);

// 4. Select for payment (automatically avoids resources)
const result = selectUtxosForPayment(
  taggedUtxos,
  100000, // amount
  10      // fee rate
);

// 5. Build transaction with selected UTXOs
const { tx } = buildTransferTransaction(
  result.selectedUtxos, // Only regular UTXOs
  recipientAddress,
  100000,
  10
);

console.log('Resources preserved:', result.resourceUtxos.length);
console.log('Regular UTXOs spent:', result.selectedUtxos.length);
```

### Resource Types

```typescript
// Inscriptions
{
  utxo: { txid: 'abc...', vout: 0 },
  resourceType: 'inscription',
  resourceId: 'abc...i0'
}

// Runes (future)
{
  utxo: { txid: 'def...', vout: 1 },
  resourceType: 'rune',
  resourceId: 'UNCOMMON•GOODS'
}

// Rare satoshis (future)
{
  utxo: { txid: 'ghi...', vout: 2 },
  resourceType: 'rare_sat',
  resourceId: 'first_sat_of_block'
}
```

## Advanced Workflows

### Batch Inscriptions

```typescript
async function batchInscribe(items: Array<{ data: any; contentType: string }>) {
  const inscriptions = [];

  for (const item of items) {
    try {
      const inscription = await sdk.bitcoin.inscribeData(
        item.data,
        item.contentType
      );
      inscriptions.push(inscription);

      console.log('Inscribed:', inscription.inscriptionId);

      // Rate limiting to avoid overwhelming the network
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.error('Failed to inscribe:', error.message);
      // Continue with next item
    }
  }

  return inscriptions;
}

// Usage
const items = [
  { data: 'Item 1', contentType: 'text/plain' },
  { data: 'Item 2', contentType: 'text/plain' },
  { data: 'Item 3', contentType: 'text/plain' }
];

const results = await batchInscribe(items);
console.log(`Inscribed ${results.length} of ${items.length} items`);
```

### Collection Management

```typescript
class InscriptionCollection {
  constructor(private sdk: OriginalsSDK) {}

  async createCollection(metadata: any, items: any[]) {
    // 1. Inscribe collection metadata
    const collectionInscription = await this.sdk.bitcoin.inscribeData(
      JSON.stringify({
        p: 'btco',
        op: 'collection',
        name: metadata.name,
        description: metadata.description,
        itemCount: items.length
      }),
      'application/json'
    );

    // 2. Inscribe each item with reference to collection
    const itemInscriptions = [];
    for (const item of items) {
      const itemInscription = await this.sdk.bitcoin.inscribeData(
        JSON.stringify({
          p: 'btco',
          op: 'item',
          collection: collectionInscription.inscriptionId,
          ...item
        }),
        'application/json'
      );
      itemInscriptions.push(itemInscription);
    }

    return {
      collection: collectionInscription,
      items: itemInscriptions
    };
  }

  async getCollection(collectionId: string) {
    const collection = await this.sdk.bitcoin.trackInscription(collectionId);
    // Fetch all items referencing this collection
    // Implementation depends on your indexer
    return collection;
  }
}
```

### Provenance Chain

```typescript
async function createProvenanceChain(assetId: string, events: any[]) {
  const provenanceInscriptions = [];

  for (const event of events) {
    const inscription = await sdk.bitcoin.inscribeData(
      JSON.stringify({
        p: 'btco',
        op: 'provenance',
        asset: assetId,
        event: event.type,
        timestamp: new Date().toISOString(),
        data: event.data
      }),
      'application/json'
    );

    provenanceInscriptions.push(inscription);
  }

  return provenanceInscriptions;
}

// Usage
const events = [
  { type: 'created', data: { creator: 'alice' } },
  { type: 'verified', data: { verifier: 'bob' } },
  { type: 'transferred', data: { from: 'alice', to: 'carol' } }
];

const provenance = await createProvenanceChain(assetId, events);
```

### Atomic Swaps (Conceptual)

```typescript
// Atomic swap requires coordination between parties
// This is a conceptual example

interface SwapParameters {
  party1: {
    inscription: OrdinalsInscription;
    address: string;
  };
  party2: {
    bitcoinAmount: number;
    address: string;
  };
}

async function coordinateAtomicSwap(params: SwapParameters) {
  // 1. Party 1 creates transaction sending inscription to Party 2
  const tx1 = await buildInscriptionTransfer(
    params.party1.inscription,
    params.party2.address
  );

  // 2. Party 2 creates transaction sending Bitcoin to Party 1
  const tx2 = await buildPaymentTransaction(
    params.party2.bitcoinAmount,
    params.party1.address
  );

  // 3. Both parties verify transactions
  // 4. Both parties sign
  // 5. Broadcast simultaneously

  // Note: Real atomic swaps require more complex HTLC constructions
  // or coordination through escrow services
}
```

## Related Documentation

- **API Reference**: [BITCOIN_API_REFERENCE.md](./BITCOIN_API_REFERENCE.md) - Complete API documentation
- **Integration Guide**: [BITCOIN_INTEGRATION_GUIDE.md](./BITCOIN_INTEGRATION_GUIDE.md) - Step-by-step integration
- **Best Practices**: [BITCOIN_BEST_PRACTICES.md](./BITCOIN_BEST_PRACTICES.md) - Security and optimization
- **Troubleshooting**: [BITCOIN_TROUBLESHOOTING.md](./BITCOIN_TROUBLESHOOTING.md) - Common issues and solutions
- **Migration Guide**: [BITCOIN_MIGRATION_GUIDE.md](./BITCOIN_MIGRATION_GUIDE.md) - Migrating from other libraries

## Additional Resources

- **Bitcoin Ordinals Theory**: [ordinals.com](https://ordinals.com)
- **Ordinals Handbook**: [docs.ordinals.com](https://docs.ordinals.com)
- **Bitcoin Developer Guide**: [bitcoin.org/en/developer-guide](https://bitcoin.org/en/developer-guide)
- **Bitcoin Improvement Proposals**: [github.com/bitcoin/bips](https://github.com/bitcoin/bips)
