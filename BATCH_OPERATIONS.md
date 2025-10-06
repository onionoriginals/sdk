# Batch Operations Guide

## Overview

Batch operations in the Originals SDK enable efficient processing of multiple assets with significant cost savings and improved performance. The batch operations system provides:

- **Cost Savings**: Batch Bitcoin inscriptions can save 30-70% on transaction fees by combining multiple inscriptions into a single transaction
- **Efficiency**: Process hundreds of assets in a single operation with configurable concurrency
- **Reliability**: Robust error handling with partial success tracking and retry logic
- **Observability**: Complete event integration for monitoring and analytics
- **Scalability**: Memory-bounded processing for large batches (1000+ assets)

## Table of Contents

1. [Cost Savings](#cost-savings)
2. [Batch Operations](#batch-operations)
   - [Batch Create Assets](#batch-create-assets)
   - [Batch Publish to Web](#batch-publish-to-web)
   - [Batch Inscribe on Bitcoin](#batch-inscribe-on-bitcoin)
   - [Batch Transfer Ownership](#batch-transfer-ownership)
3. [Configuration Options](#configuration-options)
4. [Error Handling](#error-handling)
5. [Event Integration](#event-integration)
6. [Performance Guidelines](#performance-guidelines)
7. [Cost Analysis](#cost-analysis)

## Cost Savings

The primary value proposition of batch operations is the dramatic cost savings for Bitcoin inscriptions. When using the `singleTransaction: true` option, multiple assets are combined into a single Bitcoin transaction, eliminating redundant transaction overhead.

### How It Works

```
Individual Inscriptions:
Asset 1: TX overhead (200 bytes) + Asset data (100 bytes) = 300 bytes
Asset 2: TX overhead (200 bytes) + Asset data (150 bytes) = 350 bytes
Asset 3: TX overhead (200 bytes) + Asset data (120 bytes) = 320 bytes
Total: 970 bytes

Batch Inscription (Single Transaction):
Batch: TX overhead (200 bytes) + All asset data (370 bytes) = 570 bytes
Savings: 400 bytes (41% reduction)

At 10 sat/vB:
- Individual cost: 9,700 sats
- Batch cost: 5,700 sats
- Savings: 4,000 sats (41%)
```

### Real-World Examples

| Assets | Individual Cost | Batch Cost | Savings | Savings % |
|--------|----------------|------------|---------|-----------|
| 5      | 15,000 sats    | 10,000 sats| 5,000   | 33%       |
| 10     | 30,000 sats    | 18,000 sats| 12,000  | 40%       |
| 20     | 60,000 sats    | 35,000 sats| 25,000  | 42%       |
| 50     | 150,000 sats   | 85,000 sats| 65,000  | 43%       |

**Note**: Actual savings depend on asset data sizes and network fee rates. Larger batches generally achieve higher percentage savings.

## Batch Operations

### Batch Create Assets

Create multiple assets in a single operation with configurable concurrency.

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K'
});

// Define resources for each asset
const resourcesList = [
  // Asset 1
  [
    {
      id: 'image-1',
      type: 'image',
      contentType: 'image/png',
      hash: 'abc123...',
      content: '...' // or fetch from URL
    }
  ],
  // Asset 2
  [
    {
      id: 'document-1',
      type: 'document',
      contentType: 'application/pdf',
      hash: 'def456...',
      content: '...'
    }
  ],
  // Asset 3
  [
    {
      id: 'metadata-1',
      type: 'data',
      contentType: 'application/json',
      hash: 'ghi789...',
      content: JSON.stringify({ title: 'NFT Metadata' })
    }
  ]
];

// Create assets in batch
const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
  maxConcurrent: 5,        // Process 5 assets at a time
  continueOnError: true,   // Continue even if some fail
  retryCount: 2,           // Retry failed operations twice
  retryDelay: 1000         // Wait 1 second between retries (exponential backoff)
});

// Check results
console.log(`Created: ${result.successful.length} assets`);
console.log(`Failed: ${result.failed.length} assets`);
console.log(`Total duration: ${result.totalDuration}ms`);

// Access created assets
const assets = result.successful.map(item => item.result);

// Handle failures
if (result.failed.length > 0) {
  for (const failure of result.failed) {
    console.error(`Asset ${failure.index} failed:`, failure.error.message);
    console.error(`Retry attempts: ${failure.retryAttempts}`);
  }
}
```

### Batch Publish to Web

Publish multiple assets to web storage in a single operation.

```typescript
// Create some assets first
const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);
const assets = createResult.successful.map(item => item.result);

// Publish all to the same domain
const publishResult = await sdk.lifecycle.batchPublishToWeb(
  assets,
  'my-nft-collection.com',
  {
    maxConcurrent: 10,
    continueOnError: true
  }
);

// All assets now have web URLs
for (const item of publishResult.successful) {
  const asset = item.result;
  console.log(`Asset ${asset.id}:`);
  for (const resource of asset.resources) {
    console.log(`  - ${resource.url}`);
  }
}
```

### Batch Inscribe on Bitcoin

Inscribe multiple assets on Bitcoin with significant cost savings.

#### Option 1: Single Transaction (Recommended for Cost Savings)

```typescript
// Best for: Maximum cost savings (30-70% reduction)
// Trade-off: All assets succeed or all fail (atomic operation)

const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
  singleTransaction: true,  // KEY: Combine into one transaction
  feeRate: 10,             // sat/vB
  continueOnError: false   // Atomic: all succeed or all fail
});

// Access cost savings data
console.log(`Inscribed: ${inscribeResult.successful.length} assets`);
console.log(`Cost savings: ${inscribeResult.results.costSavings?.percentage}%`);
console.log(`Saved: ${inscribeResult.results.costSavings?.amount} sats`);

// All assets share the same batch transaction
const batchId = inscribeResult.successful[0].result.getProvenance().migrations[0].batchId;
console.log(`Batch ID: ${batchId}`);
```

#### Option 2: Individual Transactions

```typescript
// Best for: Maximum reliability (partial success possible)
// Trade-off: Higher costs (no batch savings)

const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
  singleTransaction: false,  // Each asset gets its own transaction
  feeRate: 10,
  continueOnError: true,     // Continue even if some fail
  maxConcurrent: 3,          // Process 3 at a time
  retryCount: 2              // Retry failed inscriptions
});

// Partial success is possible
if (inscribeResult.failed.length > 0) {
  console.log(`Partial success: ${inscribeResult.successful.length}/${assets.length}`);
  
  // Retry just the failed ones
  const failedAssets = inscribeResult.failed.map(f => assets[f.index]);
  const retryResult = await sdk.lifecycle.batchInscribeOnBitcoin(failedAssets, {
    singleTransaction: false,
    continueOnError: true
  });
}
```

#### Dry Run: Estimate Costs Before Inscribing

```typescript
// Calculate estimated costs without actually inscribing
const assets = /* your assets */;
const feeRate = 10; // sat/vB

// Estimate batch cost
const batchSize = assets.reduce((total, asset) => {
  return total + JSON.stringify({
    assetId: asset.id,
    resources: asset.resources.map(r => ({ id: r.id, hash: r.hash }))
  }).length;
}, 0);

const batchTxSize = 200 + batchSize; // Base TX overhead + data
const batchFee = batchTxSize * feeRate;

// Estimate individual costs
const individualFees = assets.reduce((total, asset) => {
  const assetSize = JSON.stringify({
    assetId: asset.id,
    resources: asset.resources.map(r => ({ id: r.id, hash: r.hash }))
  }).length;
  const txSize = 200 + assetSize;
  return total + (txSize * feeRate);
}, 0);

const savings = individualFees - batchFee;
const savingsPercentage = (savings / individualFees) * 100;

console.log(`Batch cost: ${batchFee} sats`);
console.log(`Individual cost: ${individualFees} sats`);
console.log(`Savings: ${savings} sats (${savingsPercentage.toFixed(2)}%)`);
```

### Batch Transfer Ownership

Transfer ownership of multiple inscribed assets in batch.

```typescript
// Assets must be inscribed on Bitcoin first
const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
  singleTransaction: true,
  feeRate: 10
});

const inscribedAssets = inscribeResult.successful.map(item => item.result);

// Define transfers
const transfers = inscribedAssets.map(asset => ({
  asset,
  to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' // Recipient address
}));

// Or transfer to different addresses
const transfers = [
  { asset: inscribedAssets[0], to: 'bc1q...' },
  { asset: inscribedAssets[1], to: 'bc1q...' },
  { asset: inscribedAssets[2], to: 'bc1q...' }
];

// Execute batch transfer
const transferResult = await sdk.lifecycle.batchTransferOwnership(transfers, {
  maxConcurrent: 5,
  continueOnError: true,
  retryCount: 2
});

// Verify transfers
for (const item of transferResult.successful) {
  const transaction = item.result;
  console.log(`Transfer TX: ${transaction.txid}`);
}
```

## Configuration Options

All batch operations support the following options:

```typescript
interface BatchOperationOptions {
  // Continue processing even if some operations fail
  // Default: false (fail fast - stop on first error)
  continueOnError?: boolean;
  
  // Maximum number of concurrent operations
  // Default: 1 (sequential processing)
  // Recommended: 5-10 for most use cases
  maxConcurrent?: number;
  
  // Number of retry attempts for failed operations
  // Default: 0 (no retries)
  retryCount?: number;
  
  // Base delay between retries in milliseconds
  // Uses exponential backoff: baseDelay * 2^attempt
  // Default: 1000ms
  retryDelay?: number;
  
  // Timeout for each individual operation in milliseconds
  // Default: 30000ms (30 seconds)
  timeoutMs?: number;
  
  // Validate all items before processing
  // Default: true
  validateFirst?: boolean;
}
```

### Batch Inscription Options

Additional options for `batchInscribeOnBitcoin`:

```typescript
interface BatchInscriptionOptions extends BatchOperationOptions {
  // Combine all assets into a single Bitcoin transaction
  // KEY FEATURE for cost savings
  // Default: false
  singleTransaction?: boolean;
  
  // Fee rate in satoshis per virtual byte
  // Default: uses fee oracle if configured
  feeRate?: number;
}
```

## Error Handling

### Fail Fast Mode

Stop processing on the first error (default behavior):

```typescript
try {
  const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
    continueOnError: false // Default
  });
  
  // All succeeded
  console.log(`All ${result.successful.length} assets created`);
} catch (error) {
  // First error encountered
  console.error('Batch failed:', error.message);
}
```

### Continue on Error Mode

Process all items, tracking successes and failures:

```typescript
const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
  continueOnError: true
});

// Partial success is possible
console.log(`Succeeded: ${result.successful.length}`);
console.log(`Failed: ${result.failed.length}`);

// Handle failures
for (const failure of result.failed) {
  console.error(`Item ${failure.index} failed:`, failure.error.message);
  console.error(`Duration: ${failure.duration}ms`);
  console.error(`Retry attempts: ${failure.retryAttempts || 0}`);
}

// Process successful results
const successfulAssets = result.successful.map(item => item.result);
```

### Retry Logic

Automatically retry failed operations with exponential backoff:

```typescript
const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
  continueOnError: true,
  retryCount: 3,           // Retry up to 3 times
  retryDelay: 1000         // Start with 1 second delay
});

// Retry delays: 1s, 2s, 4s
// Total attempts per item: 1 initial + 3 retries = 4 attempts
```

### Batch Error Objects

When a batch operation fails in fail-fast mode:

```typescript
import { BatchError } from '@originals/sdk';

try {
  await sdk.lifecycle.batchCreateAssets(resourcesList, {
    continueOnError: false
  });
} catch (error) {
  if (error instanceof BatchError) {
    console.error('Batch ID:', error.batchId);
    console.error('Operation:', error.operation);
    console.error('Partial results:', error.partialResults);
    // partialResults: { successful: 5, failed: 1 }
  }
}
```

## Event Integration

Batch operations emit events that you can subscribe to for monitoring and analytics.

### Batch Event Types

```typescript
// Emitted when a batch operation starts
interface BatchStartedEvent {
  type: 'batch:started';
  timestamp: string;
  operation: 'create' | 'publish' | 'inscribe' | 'transfer';
  batchId: string;
  itemCount: number;
}

// Emitted when a batch operation completes successfully
interface BatchCompletedEvent {
  type: 'batch:completed';
  timestamp: string;
  batchId: string;
  operation: string;
  results: {
    successful: number;
    failed: number;
    totalDuration: number;
    costSavings?: {
      amount: number;
      percentage: number;
    };
  };
}

// Emitted when a batch operation fails
interface BatchFailedEvent {
  type: 'batch:failed';
  timestamp: string;
  batchId: string;
  operation: string;
  error: string;
  partialResults?: {
    successful: number;
    failed: number;
  };
}
```

### Subscribing to Events

```typescript
// Monitor batch progress
sdk.lifecycle.on('batch:started', (event) => {
  console.log(`Batch ${event.batchId} started: ${event.operation}`);
  console.log(`Processing ${event.itemCount} items`);
});

sdk.lifecycle.on('batch:completed', (event) => {
  console.log(`Batch ${event.batchId} completed`);
  console.log(`Success: ${event.results.successful}, Failed: ${event.results.failed}`);
  console.log(`Duration: ${event.results.totalDuration}ms`);
  
  if (event.results.costSavings) {
    console.log(`Cost savings: ${event.results.costSavings.percentage}%`);
    console.log(`Saved: ${event.results.costSavings.amount} sats`);
  }
});

sdk.lifecycle.on('batch:failed', (event) => {
  console.error(`Batch ${event.batchId} failed: ${event.error}`);
  if (event.partialResults) {
    console.log(`Partial results: ${event.partialResults.successful} succeeded, ${event.partialResults.failed} failed`);
  }
});

// Individual asset events are still emitted
sdk.lifecycle.on('asset:created', (event) => {
  console.log(`Asset created: ${event.asset.id}`);
});

sdk.lifecycle.on('asset:migrated', (event) => {
  console.log(`Asset migrated: ${event.asset.fromLayer} -> ${event.asset.toLayer}`);
});
```

### Progress Tracking Example

```typescript
class BatchProgressTracker {
  private batches = new Map<string, {
    operation: string;
    total: number;
    completed: number;
    failed: number;
    startTime: number;
  }>();

  constructor(sdk: OriginalsSDK) {
    sdk.lifecycle.on('batch:started', (event) => {
      this.batches.set(event.batchId, {
        operation: event.operation,
        total: event.itemCount,
        completed: 0,
        failed: 0,
        startTime: Date.now()
      });
      this.logProgress(event.batchId);
    });

    sdk.lifecycle.on('asset:created', (event) => {
      this.incrementProgress();
    });

    sdk.lifecycle.on('asset:migrated', (event) => {
      this.incrementProgress();
    });

    sdk.lifecycle.on('batch:completed', (event) => {
      const batch = this.batches.get(event.batchId);
      if (batch) {
        batch.completed = event.results.successful;
        batch.failed = event.results.failed;
        this.logProgress(event.batchId);
        this.batches.delete(event.batchId);
      }
    });
  }

  private incrementProgress() {
    // Update progress for active batches
    for (const [batchId, batch] of this.batches) {
      if (batch.completed + batch.failed < batch.total) {
        batch.completed++;
        this.logProgress(batchId);
      }
    }
  }

  private logProgress(batchId: string) {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const progress = ((batch.completed + batch.failed) / batch.total) * 100;
    const elapsed = Date.now() - batch.startTime;
    const eta = batch.completed > 0 
      ? (elapsed / batch.completed) * (batch.total - batch.completed - batch.failed)
      : 0;

    console.log(`[${batchId.slice(0, 8)}] ${batch.operation}: ${progress.toFixed(1)}% (${batch.completed}/${batch.total}) ETA: ${(eta / 1000).toFixed(1)}s`);
  }
}

// Usage
const tracker = new BatchProgressTracker(sdk);

// Now batch operations will show progress
await sdk.lifecycle.batchCreateAssets(largeResourcesList);
```

## Performance Guidelines

### Choosing Concurrency Levels

```typescript
// Small batches (< 10 items): Sequential is fine
await sdk.lifecycle.batchCreateAssets(resourcesList, {
  maxConcurrent: 1
});

// Medium batches (10-50 items): Moderate concurrency
await sdk.lifecycle.batchCreateAssets(resourcesList, {
  maxConcurrent: 5
});

// Large batches (50-200 items): Higher concurrency
await sdk.lifecycle.batchCreateAssets(resourcesList, {
  maxConcurrent: 10
});

// Very large batches (200+ items): Adjust based on system resources
await sdk.lifecycle.batchCreateAssets(resourcesList, {
  maxConcurrent: 20
});
```

### Memory Management

For very large batches (500+ items), consider processing in chunks:

```typescript
async function processBatchInChunks<T>(
  items: T[],
  chunkSize: number,
  processor: (chunk: T[]) => Promise<any>
) {
  const results = [];
  
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const result = await processor(chunk);
    results.push(result);
    
    console.log(`Processed ${Math.min(i + chunkSize, items.length)}/${items.length}`);
  }
  
  return results;
}

// Process 1000 assets in chunks of 100
await processBatchInChunks(
  largeResourcesList,
  100,
  async (chunk) => {
    return await sdk.lifecycle.batchCreateAssets(chunk, {
      maxConcurrent: 10
    });
  }
);
```

### Performance Best Practices

1. **Use single-transaction mode for inscriptions** whenever possible for maximum cost savings
2. **Tune concurrency** based on your network and system resources
3. **Enable retries** for unreliable operations (network I/O)
4. **Use continue-on-error** for large batches where partial success is acceptable
5. **Monitor memory usage** for very large batches (500+ items)
6. **Batch similar operations** together for better efficiency
7. **Process in chunks** for batches larger than 500 items

### Benchmarks

Typical performance on modern hardware (2023):

| Operation       | Batch Size | Concurrency | Duration | Per Item |
|-----------------|-----------|-------------|----------|----------|
| Create Assets   | 100       | 10          | ~2s      | ~20ms    |
| Publish to Web  | 100       | 10          | ~5s      | ~50ms    |
| Inscribe (batch)| 100       | 1           | ~1s      | ~10ms    |
| Inscribe (indiv)| 100       | 5           | ~15s     | ~150ms   |
| Transfer        | 100       | 5           | ~10s     | ~100ms   |

*Note: Actual performance depends on network conditions, asset sizes, and system resources.*

## Cost Analysis

### Fee Structure

Bitcoin transaction fees consist of:

1. **Base transaction overhead**: ~200 bytes (inputs, outputs, signatures)
2. **Inscription data**: Size of the inscribed content
3. **Fee rate**: sat/vB (varies by network congestion)

### Cost Comparison Examples

#### Example 1: Small NFT Collection (10 assets)

**Scenario**: 10 NFTs with metadata, each ~150 bytes

**Individual Inscriptions**:
- Per asset: 200 bytes (overhead) + 150 bytes (data) = 350 bytes
- Total: 10 × 350 = 3,500 bytes
- At 10 sat/vB: 35,000 sats (~$10 at $30k BTC)

**Batch Inscription**:
- Batch: 200 bytes (overhead) + (10 × 150) bytes (data) = 1,700 bytes
- At 10 sat/vB: 17,000 sats (~$5 at $30k BTC)
- **Savings: 18,000 sats (~$5, 51%)**

#### Example 2: Large Collection (100 assets)

**Scenario**: 100 assets with average 200 bytes each

**Individual Inscriptions**:
- Total: 100 × (200 + 200) = 40,000 bytes
- At 10 sat/vB: 400,000 sats (~$120 at $30k BTC)

**Batch Inscription**:
- Batch: 200 + (100 × 200) = 20,200 bytes
- At 10 sat/vB: 202,000 sats (~$60 at $30k BTC)
- **Savings: 198,000 sats (~$60, 50%)**

#### Example 3: High Fee Environment

**Scenario**: 20 assets during network congestion, 50 sat/vB

**Individual Inscriptions**:
- Total: 20 × (200 + 150) = 7,000 bytes
- At 50 sat/vB: 350,000 sats (~$105 at $30k BTC)

**Batch Inscription**:
- Batch: 200 + (20 × 150) = 3,200 bytes
- At 50 sat/vB: 160,000 sats (~$48 at $30k BTC)
- **Savings: 190,000 sats (~$57, 54%)**

### ROI Calculator

```typescript
function calculateBatchROI(
  assetCount: number,
  avgAssetSize: number,
  feeRate: number,
  btcPriceUSD: number
): {
  individualCost: { sats: number; usd: number };
  batchCost: { sats: number; usd: number };
  savings: { sats: number; usd: number; percentage: number };
} {
  const TX_OVERHEAD = 200;
  
  // Individual costs
  const individualBytes = assetCount * (TX_OVERHEAD + avgAssetSize);
  const individualSats = individualBytes * feeRate;
  const individualUSD = (individualSats / 100_000_000) * btcPriceUSD;
  
  // Batch costs
  const batchBytes = TX_OVERHEAD + (assetCount * avgAssetSize);
  const batchSats = batchBytes * feeRate;
  const batchUSD = (batchSats / 100_000_000) * btcPriceUSD;
  
  // Savings
  const savingsSats = individualSats - batchSats;
  const savingsUSD = individualUSD - batchUSD;
  const savingsPercentage = (savingsSats / individualSats) * 100;
  
  return {
    individualCost: { sats: individualSats, usd: individualUSD },
    batchCost: { sats: batchSats, usd: batchUSD },
    savings: { sats: savingsSats, usd: savingsUSD, percentage: savingsPercentage }
  };
}

// Example: 50 assets, 200 bytes each, 15 sat/vB, BTC at $35,000
const roi = calculateBatchROI(50, 200, 15, 35000);
console.log(`Individual: ${roi.individualCost.sats} sats ($${roi.individualCost.usd.toFixed(2)})`);
console.log(`Batch: ${roi.batchCost.sats} sats ($${roi.batchCost.usd.toFixed(2)})`);
console.log(`Savings: ${roi.savings.sats} sats ($${roi.savings.usd.toFixed(2)}) - ${roi.savings.percentage.toFixed(1)}%`);
```

### When to Use Batch Inscriptions

**✅ Use batch inscriptions when:**
- Inscribing 3+ assets at once
- Cost savings are a priority
- All assets are ready to inscribe
- Atomic success/failure is acceptable

**❌ Use individual inscriptions when:**
- Inscribing a single asset
- Need to handle partial failures
- Assets are being inscribed over time
- Maximum reliability is critical

## Advanced Patterns

### Progressive Batch Processing

Process assets in multiple stages with error recovery:

```typescript
async function processCollectionInStages(resources: AssetResource[][]) {
  // Stage 1: Create all assets
  console.log('Stage 1: Creating assets...');
  const createResult = await sdk.lifecycle.batchCreateAssets(resources, {
    maxConcurrent: 10,
    continueOnError: true,
    retryCount: 2
  });
  
  if (createResult.failed.length > 0) {
    console.warn(`${createResult.failed.length} assets failed to create`);
  }
  
  const assets = createResult.successful.map(item => item.result);
  
  // Stage 2: Publish to web
  console.log('Stage 2: Publishing to web...');
  const publishResult = await sdk.lifecycle.batchPublishToWeb(
    assets,
    'my-collection.com',
    {
      maxConcurrent: 10,
      continueOnError: true,
      retryCount: 2
    }
  );
  
  const publishedAssets = publishResult.successful.map(item => item.result);
  
  // Stage 3: Inscribe with cost optimization
  console.log('Stage 3: Inscribing on Bitcoin...');
  const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(
    publishedAssets,
    {
      singleTransaction: true,
      feeRate: 15,
      continueOnError: false // Atomic for cost savings
    }
  );
  
  console.log(`Successfully processed ${inscribeResult.successful.length} assets`);
  console.log(`Total cost savings: ${inscribeResult.results.costSavings?.percentage}%`);
  
  return inscribeResult.successful.map(item => item.result);
}
```

### Conditional Batching

Dynamically choose between batch and individual operations:

```typescript
async function smartInscribe(
  assets: OriginalsAsset[],
  options: { maxCostSats: number; feeRate: number }
) {
  // Calculate costs for both approaches
  const batchCost = estimateBatchCost(assets, options.feeRate);
  const individualCost = estimateIndividualCost(assets, options.feeRate);
  
  // If batch is within budget and saves significantly, use it
  if (batchCost.total <= options.maxCostSats && batchCost.savings > 30) {
    console.log(`Using batch inscription (saves ${batchCost.savings}%)`);
    return await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
      singleTransaction: true,
      feeRate: options.feeRate
    });
  }
  
  // Otherwise, use individual inscriptions with error handling
  console.log('Using individual inscriptions for maximum reliability');
  return await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
    singleTransaction: false,
    feeRate: options.feeRate,
    continueOnError: true,
    maxConcurrent: 3
  });
}
```

## Conclusion

Batch operations in the Originals SDK provide a powerful and efficient way to process multiple assets:

- **30-70% cost savings** on Bitcoin inscriptions
- **Flexible error handling** for different reliability needs
- **Scalable processing** for collections of any size
- **Complete observability** through event integration
- **Production-ready** with retry logic and validation

For maximum value, use **single-transaction batch inscriptions** whenever inscribing multiple assets to dramatically reduce costs while maintaining the security and provenance guarantees of the Bitcoin blockchain.

## Support

For questions or issues with batch operations:
- GitHub Issues: https://github.com/aviarytech/originals-sdk/issues
- Documentation: https://docs.originals.xyz
- Discord: https://discord.gg/originals
