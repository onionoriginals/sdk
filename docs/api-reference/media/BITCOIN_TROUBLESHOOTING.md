# Bitcoin Operations Troubleshooting Guide

Solutions to common issues when working with Bitcoin operations in the Originals SDK.

## Table of Contents

- [Configuration Issues](#configuration-issues)
- [Transaction Failures](#transaction-failures)
- [Fee-Related Problems](#fee-related-problems)
- [UTXO Selection Errors](#utxo-selection-errors)
- [Inscription Issues](#inscription-issues)
- [Network Connectivity](#network-connectivity)
- [Address Validation](#address-validation)
- [External Signer Problems](#external-signer-problems)
- [Performance Issues](#performance-issues)
- [Debugging Tips](#debugging-tips)

## Configuration Issues

### Error: "Ordinals provider must be configured"

**Symptom:**
```
StructuredError: Ordinals provider must be configured to inscribe data on Bitcoin.
Code: ORD_PROVIDER_REQUIRED
```

**Cause:** No Ordinals provider configured in SDK initialization.

**Solution:**

```typescript
// ❌ Wrong: Missing provider
const sdk = OriginalsSDK.create({
  network: 'mainnet'
});

// ✅ Correct: Provider configured
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});
```

**For Testing:**
```typescript
import { OrdMockProvider } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider()
});
```

---

### Error: Network Mismatch

**Symptom:**
```
Error: Network mismatch: provider is configured for 'testnet' but SDK is using 'mainnet'
```

**Cause:** Provider network doesn't match SDK network.

**Solution:**

```typescript
// ❌ Wrong: Mismatched networks
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'testnet', // Mismatch!
    apiUrl: '...'
  })
});

// ✅ Correct: Matching networks
const network = process.env.BITCOIN_NETWORK as 'mainnet' | 'testnet';

const sdk = OriginalsSDK.create({
  network,
  ordinalsProvider: new OrdinalsClient({
    network, // Same network
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});
```

---

### Error: Missing Environment Variables

**Symptom:**
```
TypeError: Cannot read property of undefined
```

**Cause:** Required environment variables not set.

**Solution:**

```typescript
// Validate environment variables at startup
const requiredEnvVars = [
  'BITCOIN_NETWORK',
  'ORD_API_URL',
  'BITCOIN_PRIVATE_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Use with fallbacks
const config = {
  network: (process.env.BITCOIN_NETWORK || 'testnet') as BitcoinNetwork,
  apiUrl: process.env.ORD_API_URL || 'http://localhost:8080',
  privateKey: process.env.BITCOIN_PRIVATE_KEY!
};
```

---

## Transaction Failures

### Error: Insufficient Funds

**Symptom:**
```
StructuredError: Insufficient funds to complete transaction
Code: INSUFFICIENT_FUNDS
Details: {
  required: 100000,
  available: 50000
}
```

**Diagnosis:**

```typescript
// Check available balance
const utxos = await fetchUtxos(address);
const totalBalance = utxos.reduce((sum, utxo) => sum + utxo.value, 0);

console.log('Total balance:', totalBalance, 'sats');
console.log('Required:', requiredAmount + estimatedFee, 'sats');
console.log('Shortfall:', (requiredAmount + estimatedFee) - totalBalance, 'sats');
```

**Solutions:**

1. **Add more Bitcoin to wallet**
   ```bash
   # For testnet, use a faucet:
   # https://testnet-faucet.mempool.co/
   # https://bitcoinfaucet.uo1.net/
   ```

2. **Reduce transaction amount**
   ```typescript
   const availableAmount = totalBalance - estimatedFee - 1000; // Buffer
   const inscription = await sdk.bitcoin.inscribeData(
     smallerData,
     contentType
   );
   ```

3. **Check for locked/inscribed UTXOs**
   ```typescript
   import { tagResourceUtxos } from '@originals/sdk';

   // Tag inscribed UTXOs
   const taggedUtxos = tagResourceUtxos(utxos, inscriptionData);

   // Count spendable UTXOs
   const spendableUtxos = taggedUtxos.filter(u => !u.isResource && !u.locked);
   const spendableBalance = spendableUtxos.reduce(
     (sum, utxo) => sum + utxo.value,
     0
   );

   console.log('Spendable balance:', spendableBalance, 'sats');
   ```

---

### Error: Transaction Broadcast Failed

**Symptom:**
```
Error: Transaction broadcast failed: mandatory-script-verify-flag-failed
```

**Common Causes:**

1. **Invalid signature**
   ```typescript
   // Verify private key format
   console.log('Private key format:', privateKey.startsWith('L') || privateKey.startsWith('K') ? 'WIF' : 'Unknown');

   // Ensure correct network
   const keyNetwork = privateKey.startsWith('c') ? 'testnet' : 'mainnet';
   console.log('Key network:', keyNetwork);
   ```

2. **Incorrect script type**
   ```typescript
   // Check UTXO has correct witness data for SegWit
   const hasWitness = utxo.scriptPubKey?.startsWith('0014') ||
                      utxo.scriptPubKey?.startsWith('0020');
   console.log('Is SegWit UTXO:', hasWitness);
   ```

3. **UTXO already spent**
   ```typescript
   // Verify UTXO is still unspent
   const status = await checkUtxoStatus(utxo.txid, utxo.vout);
   if (status.spent) {
     console.error('UTXO already spent in tx:', status.spentInTxid);
   }
   ```

**Solution:**

```typescript
// Retry with fresh UTXO data
const freshUtxos = await fetchUtxos(address);
const { tx } = buildTransferTransaction(
  freshUtxos,
  recipientAddress,
  amount,
  feeRate
);
```

---

### Error: Transaction Stuck in Mempool

**Symptom:** Transaction broadcast but not confirming after several hours.

**Diagnosis:**

```typescript
const status = await ordinalsProvider.getTransactionStatus(txid);

console.log('Confirmed:', status.confirmed);
console.log('In block:', status.blockHeight);

// Check if still in mempool
if (!status.confirmed) {
  console.log('Transaction stuck in mempool');

  // Check current mempool fee rates
  const response = await fetch('https://mempool.space/api/v1/fees/recommended');
  const fees = await response.json();

  console.log('Current fast fee:', fees.fastestFee, 'sat/vB');
  console.log('Your tx fee rate:', txFeeRate, 'sat/vB');
}
```

**Solutions:**

1. **Wait longer** - Low fee transactions can take hours or days

2. **Replace-By-Fee (RBF)** - If transaction was marked as replaceable:
   ```typescript
   // Create replacement transaction with higher fee
   const { tx: replacementTx } = buildTransferTransaction(
     sameUtxos,
     sameRecipient,
     sameAmount,
     higherFeeRate // Increase by at least 1 sat/vB
   );
   ```

3. **Child-Pays-For-Parent (CPFP)** - Spend the unconfirmed output with high fee:
   ```typescript
   // Use the unconfirmed UTXO as input with high fee
   const { tx: cpfpTx } = buildTransferTransaction(
     [unconfirmedUtxo],
     yourAddress, // Send back to yourself
     unconfirmedUtxo.value,
     highFeeRate // High enough to pay for both transactions
   );
   ```

---

## Fee-Related Problems

### Error: Fee Too Low

**Symptom:**
```
StructuredError: Fee rate too low for network relay
Code: FEE_TOO_LOW
Details: { minimumFee: 1.1, providedFee: 0.5 }
```

**Solution:**

```typescript
// Use minimum relay fee or higher
const MIN_FEE_RATE = 1.1; // sat/vB

const inscription = await sdk.bitcoin.inscribeData(
  data,
  contentType,
  Math.max(yourFeeRate, MIN_FEE_RATE)
);
```

---

### Error: Fee Estimation Failed

**Symptom:**
```
Error: Could not estimate fee rate from any source
```

**Cause:** All fee estimation sources failed (oracle, provider, fallback).

**Solution:**

```typescript
// Provide manual fee rate as fallback
const FALLBACK_FEE_RATE = 10; // Conservative 10 sat/vB

try {
  const inscription = await sdk.bitcoin.inscribeData(
    data,
    contentType
    // Let SDK estimate
  );
} catch (error) {
  if (error.message.includes('estimate fee')) {
    // Retry with manual fee
    const inscription = await sdk.bitcoin.inscribeData(
      data,
      contentType,
      FALLBACK_FEE_RATE
    );
  }
}
```

**Better: Implement fallback fee oracle**

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider,
  feeOracle: {
    estimateFeeRate: async (targetBlocks = 6) => {
      try {
        // Primary source
        const response = await fetch(
          'https://mempool.space/api/v1/fees/recommended',
          { timeout: 5000 }
        );
        const fees = await response.json();
        return targetBlocks <= 1 ? fees.fastestFee : fees.halfHourFee;

      } catch (error) {
        // Fallback to conservative default
        console.warn('Fee oracle failed, using fallback');
        return 10; // Conservative 10 sat/vB
      }
    }
  }
});
```

---

### Error: Overpaying Fees

**Symptom:** Transactions consistently have very high fees relative to network conditions.

**Diagnosis:**

```typescript
import { calculateFee, estimateTransactionSize } from '@originals/sdk';

const vsize = estimateTransactionSize(inputCount, outputCount);
const fee = calculateFee(vsize, feeRate);

console.log('Transaction size:', vsize, 'vBytes');
console.log('Fee rate:', feeRate, 'sat/vB');
console.log('Total fee:', fee.toString(), 'sats');
console.log('Fee in BTC:', Number(fee) / 100_000_000);

// Check if excessive
const feePercentage = (Number(fee) / totalValue) * 100;
console.log('Fee as % of transaction:', feePercentage.toFixed(2), '%');

if (feePercentage > 5) {
  console.warn('Fee exceeds 5% of transaction value');
}
```

**Solution:**

```typescript
// Use dynamic fee estimation
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider,
  feeOracle: {
    estimateFeeRate: async () => {
      const response = await fetch(
        'https://mempool.space/api/v1/fees/recommended'
      );
      const fees = await response.json();

      // Use economical fee for non-urgent transactions
      return fees.economyFee; // Instead of fastestFee
    }
  }
});
```

---

## UTXO Selection Errors

### Error: UTXO Selection Failed

**Symptom:**
```
UtxoSelectionError: Could not select UTXOs for required amount
Code: UTXO_SELECTION_FAILED
Details: {
  requiredAmount: 100000,
  availableAmount: 150000,
  selectedUtxos: []
}
```

**Diagnosis:**

```typescript
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// Check if all UTXOs are locked/inscribed
const taggedUtxos = tagResourceUtxos(utxos, inscriptionData);

const regularUtxos = taggedUtxos.filter(u => !u.isResource && !u.locked);
const resourceUtxos = taggedUtxos.filter(u => u.isResource);
const lockedUtxos = taggedUtxos.filter(u => u.locked);

console.log('Total UTXOs:', utxos.length);
console.log('Regular (spendable):', regularUtxos.length);
console.log('Resource (inscribed):', resourceUtxos.length);
console.log('Locked:', lockedUtxos.length);

const regularBalance = regularUtxos.reduce((sum, u) => sum + u.value, 0);
console.log('Spendable balance:', regularBalance, 'sats');
```

**Solutions:**

1. **All funds in inscribed UTXOs**
   ```typescript
   // Transfer some Bitcoin to yourself to create regular UTXOs
   // Use a different wallet or receive Bitcoin from elsewhere
   ```

2. **Dust fragmentation**
   ```typescript
   // Consolidate dust UTXOs
   const dustUtxos = utxos.filter(u => u.value < 10000);

   if (dustUtxos.length > 10) {
     console.log('Consolidating', dustUtxos.length, 'dust UTXOs');

     const { tx } = buildTransferTransaction(
       dustUtxos,
       yourAddress, // Send to yourself
       dustUtxos.reduce((sum, u) => sum + u.value, 0),
       5 // Low fee for consolidation
     );
   }
   ```

3. **Fees too high for available UTXOs**
   ```typescript
   // Try with lower fee rate
   const result = selectResourceUtxos(utxos, {
     requiredAmount,
     feeRate: 3, // Lower fee rate
     strategy: 'minimize_inputs'
   });
   ```

---

### Error: Accidentally Spending Inscribed UTXO

**Symptom:** Inscription transferred when trying to send regular Bitcoin.

**Prevention:**

```typescript
// ALWAYS use resource-aware selection
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// 1. Fetch inscriptions for address
const inscriptions = await fetchInscriptions(address);

// 2. Tag UTXOs
const resourceData = inscriptions.map(ins => ({
  utxo: { txid: ins.txid, vout: ins.vout },
  resourceType: 'inscription',
  resourceId: ins.inscriptionId
}));

const taggedUtxos = tagResourceUtxos(utxos, resourceData);

// 3. Use tagged UTXOs for selection
const result = selectResourceUtxos(taggedUtxos, {
  requiredAmount,
  feeRate,
  strategy: 'optimize_size'
});

// 4. Verify no resources spent
if (result.resourceUtxos.length !== inscriptions.length) {
  throw new Error('Resource UTXO count mismatch - unsafe to proceed');
}

// 5. Build transaction with only regular UTXOs
const { tx } = buildTransferTransaction(
  result.selectedUtxos, // Regular UTXOs only
  recipientAddress,
  amount,
  feeRate
);
```

---

## Inscription Issues

### Error: Inscription Not Found

**Symptom:**
```typescript
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);
console.log(inscription); // null
```

**Diagnosis:**

```typescript
// Verify inscription ID format
console.log('Inscription ID:', inscriptionId);
console.log('Format:', /^[a-f0-9]{64}i\d+$/.test(inscriptionId) ? 'Valid' : 'Invalid');

// Check if it's actually a satoshi number
if (/^\d+$/.test(inscriptionId)) {
  console.log('ERROR: This looks like a satoshi number, not an inscription ID');
  console.log('Inscription IDs have format: {txid}i{index}');
  console.log('Use an Ordinals explorer to find inscriptions on this satoshi');
}

// Check provider endpoint
try {
  const response = await fetch(
    `${process.env.ORD_API_URL}/inscription/${inscriptionId}`
  );
  console.log('Provider status:', response.status);
  const data = await response.json();
  console.log('Provider response:', data);
} catch (error) {
  console.error('Provider error:', error);
}
```

**Solutions:**

1. **Wrong inscription ID format**
   ```typescript
   // Correct format: {txid}i{index}
   const correctId = `${txid}i0`;
   const inscription = await sdk.bitcoin.trackInscription(correctId);
   ```

2. **Inscription not yet indexed**
   ```typescript
   // Wait for indexer to catch up
   async function waitForInscription(id: string, maxAttempts = 10) {
     for (let i = 0; i < maxAttempts; i++) {
       const inscription = await sdk.bitcoin.trackInscription(id);
       if (inscription) return inscription;

       console.log(`Attempt ${i + 1}/${maxAttempts}: Waiting for indexer...`);
       await new Promise(resolve => setTimeout(resolve, 10000));
     }
     throw new Error('Inscription not found after waiting');
   }
   ```

3. **Wrong network**
   ```typescript
   // Verify you're querying the same network where inscription was created
   console.log('SDK network:', sdk.config.network);
   console.log('Provider network:', ordinalsProvider.network);
   ```

---

### Error: Front-Running Detected

**Symptom:**
```typescript
const isSafe = await sdk.bitcoin.preventFrontRunning(satoshi);
console.log(isSafe); // false
```

**Diagnosis:**

```typescript
// The preventFrontRunning method detected multiple inscriptions
console.log(`Front-running detected on satoshi ${satoshi}`);
console.log('Multiple inscriptions exist on this satoshi');

// To inspect all inscriptions, use an Ordinals explorer:
// - https://ordinals.com/sat/{satoshi}
// - Or access the provider directly if you have it configured
```

**Solutions:**

1. **Use different satoshi**
   ```typescript
   // Re-inscribe on a fresh satoshi
   const newInscription = await sdk.bitcoin.inscribeData(data, contentType);
   const isSafe = await sdk.bitcoin.preventFrontRunning(newInscription.satoshi);

   if (!isSafe) {
     throw new Error('Front-run again - possible network issue');
   }
   ```

2. **Accept the front-running**
   ```typescript
   // Front-running may not always be malicious
   // If your inscription was successfully created, you can proceed
   // Use Ordinals explorers to verify which inscription is first
   console.log('Inscription created, but satoshi has multiple inscriptions');
   console.log('Verify your inscription at: https://ordinals.com');
   ```

---

### Error: Content Type Mismatch

**Symptom:** Inscription created but content type is wrong.

**Diagnosis:**

```typescript
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);
console.log('Expected:', 'image/png');
console.log('Actual:', inscription.contentType);
```

**Solution:**

```typescript
// Ensure correct MIME type
const contentTypeMap = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain;charset=utf-8',
  '.html': 'text/html;charset=utf-8',
  '.json': 'application/json'
};

const ext = path.extname(filename).toLowerCase();
const contentType = contentTypeMap[ext] || 'application/octet-stream';

const inscription = await sdk.bitcoin.inscribeData(data, contentType);
```

---

## Network Connectivity

### Error: Provider Timeout

**Symptom:**
```
Error: Request timeout after 30000ms
```

**Solution:**

```typescript
// Increase timeout
class CustomOrdinalsClient extends OrdinalsClient {
  constructor(config) {
    super(config);
    this.timeout = 60000; // 60 seconds
  }
}

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new CustomOrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});
```

**Retry Logic:**

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      const delay = 1000 * Math.pow(2, i); // Exponential backoff
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// Usage
const inscription = await withRetry(() =>
  sdk.bitcoin.inscribeData(data, contentType)
);
```

---

### Error: API Rate Limiting

**Symptom:**
```
Error: 429 Too Many Requests
Retry-After: 60
```

**Solution:**

```typescript
// Implement rate limiting
import pLimit from 'p-limit';

const limit = pLimit(3); // Max 3 concurrent requests

const inscriptions = await Promise.all(
  items.map(item =>
    limit(() => sdk.bitcoin.inscribeData(item.data, item.contentType))
  )
);

// Add delays between requests
async function inscribeWithDelay(data: any, contentType: string) {
  const inscription = await sdk.bitcoin.inscribeData(data, contentType);
  await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
  return inscription;
}
```

---

## Address Validation

### Error: Invalid Address

**Symptom:**
```
StructuredError: Invalid Bitcoin address
Code: INVALID_ADDRESS
```

**Diagnosis:**

```typescript
const address = 'bc1qxyz...';

console.log('Address:', address);
console.log('Length:', address.length);
console.log('Prefix:', address.substring(0, 4));

// Check network match
const networkPrefixes = {
  mainnet: ['1', '3', 'bc1'],
  testnet: ['m', 'n', '2', 'tb1'],
  signet: ['tb1'],
  regtest: ['bcrt1']
};

const isValid = sdk.bitcoin.validateBitcoinAddress(address, 'mainnet');
console.log('Valid for mainnet:', isValid);
```

**Common Issues:**

1. **Testnet address on mainnet**
   ```typescript
   // ❌ Wrong
   const address = 'tb1qxyz...'; // Testnet
   const tx = await sdk.bitcoin.transferInscription(ins, address); // SDK on mainnet

   // ✅ Correct
   const address = 'bc1qxyz...'; // Mainnet
   const tx = await sdk.bitcoin.transferInscription(ins, address);
   ```

2. **Typos in address**
   ```typescript
   // Addresses have checksums - even one character wrong will fail
   const address = 'bc1qxyz...ABC'; // Last 3 chars are wrong

   if (!sdk.bitcoin.validateBitcoinAddress(address, 'mainnet')) {
     throw new Error('Invalid address - please verify');
   }
   ```

3. **Unsupported address type**
   ```typescript
   // Very old addresses might not be supported
   const p2pkAddress = '04ae1a...'; // Raw public key (very old)

   // Use standard address types:
   // - P2PKH: 1...
   // - P2SH: 3...
   // - Native SegWit: bc1q...
   // - Taproot: bc1p...
   ```

---

## External Signer Problems

### Error: Signer Not Responding

**Symptom:**
```
Error: External signer timeout
```

**Diagnosis:**

```typescript
// Test external signer separately
async function testExternalSigner(signer: ExternalSigner) {
  try {
    const testDoc = { test: 'document' };
    const testProof = { type: 'test' };

    console.log('Testing external signer...');
    const result = await signer.sign({
      document: testDoc,
      proof: testProof
    });

    console.log('Signer working:', !!result.proofValue);
    return true;

  } catch (error) {
    console.error('Signer failed:', error);
    return false;
  }
}

// Usage
const signerWorks = await testExternalSigner(mySigner);
if (!signerWorks) {
  console.error('External signer not functioning');
}
```

**Solutions:**

1. **Privy timeout**
   ```typescript
   class PrivySigner implements ExternalSigner {
     private timeout = 30000; // Increase timeout

     async sign({ document, proof }) {
       const controller = new AbortController();
       const timeoutId = setTimeout(
         () => controller.abort(),
         this.timeout
       );

       try {
         const signature = await this.privyClient.wallets.sign({
           userId: this.userId,
           walletId: this.walletId,
           message: JSON.stringify(document)
         }, { signal: controller.signal });

         return { proofValue: signature };

       } finally {
         clearTimeout(timeoutId);
       }
     }
   }
   ```

2. **AWS KMS permissions**
   ```typescript
   // Verify KMS permissions
   import { KMSClient, DescribeKeyCommand } from '@aws-sdk/client-kms';

   const kmsClient = new KMSClient({ region: 'us-east-1' });
   const command = new DescribeKeyCommand({ KeyId: keyId });

   try {
     const response = await kmsClient.send(command);
     console.log('KMS key accessible:', response.KeyMetadata?.KeyId);
   } catch (error) {
     console.error('KMS access denied:', error);
     // Check IAM permissions for kms:Sign, kms:DescribeKey
   }
   ```

---

### Error: Invalid Signature Format

**Symptom:**
```
Error: Invalid signature format from external signer
```

**Solution:**

```typescript
class MySigner implements ExternalSigner {
  async sign({ document, proof }) {
    const signature = await this.signingService.sign(document);

    // Ensure signature is base64 encoded
    const proofValue = Buffer.isBuffer(signature)
      ? signature.toString('base64')
      : signature;

    return { proofValue };
  }

  getVerificationMethodId() {
    return this.verificationMethodId;
  }
}
```

---

## Performance Issues

### Slow UTXO Selection

**Symptom:** UTXO selection takes several seconds with many UTXOs.

**Solution:**

```typescript
// Pre-filter UTXOs before selection
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// Filter out dust and locked UTXOs
const usableUtxos = utxos.filter(u =>
  u.value >= 1000 && // No dust
  !u.locked          // Not locked
);

// Tag only usable UTXOs
const taggedUtxos = tagResourceUtxos(usableUtxos, inscriptionData);

// Select from filtered set
const result = selectResourceUtxos(taggedUtxos, {
  requiredAmount,
  feeRate,
  strategy: 'minimize_inputs' // Faster than other strategies
});
```

---

### Slow Inscription Tracking

**Symptom:** `trackInscription()` takes long time to return.

**Solution:**

```typescript
// Cache inscription data
const inscriptionCache = new Map();

async function getCachedInscription(id: string) {
  if (inscriptionCache.has(id)) {
    return inscriptionCache.get(id);
  }

  const inscription = await sdk.bitcoin.trackInscription(id);
  if (inscription) {
    inscriptionCache.set(id, inscription);
  }

  return inscription;
}

// Clear cache periodically
setInterval(() => {
  inscriptionCache.clear();
}, 60000); // 1 minute
```

---

## Debugging Tips

### Enable SDK Logging

```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  enableLogging: true, // Enable verbose logging
  ordinalsProvider
});

// Logs will show:
// - UTXO selection process
// - Fee calculation details
// - Network requests
// - Transaction construction
```

### Inspect Transactions

```typescript
import { buildTransferTransaction } from '@originals/sdk';

const { tx, selection } = buildTransferTransaction(
  utxos,
  recipientAddress,
  amount,
  feeRate
);

console.log('Transaction Details:');
console.log('  TXID:', tx.txid);
console.log('  Inputs:', tx.vin.length);
console.log('  Outputs:', tx.vout.length);
console.log('  Fee:', tx.fee, 'sats');

console.log('\nInputs:');
tx.vin.forEach((input, i) => {
  console.log(`  ${i}: ${input.txid}:${input.vout}`);
});

console.log('\nOutputs:');
tx.vout.forEach((output, i) => {
  console.log(`  ${i}: ${output.address} - ${output.value} sats`);
});

console.log('\nSelection:');
console.log('  Selected UTXOs:', selection.selectedUtxos.length);
console.log('  Total input:', selection.totalInput, 'sats');
console.log('  Change:', selection.change, 'sats');
```

### Test with Mock Provider

```typescript
import { OrdMockProvider } from '@originals/sdk';

// Use mock provider to isolate SDK behavior
const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider()
});

// Test operations without network calls
const inscription = await sdk.bitcoin.inscribeData('test', 'text/plain');
console.log('Mock inscription:', inscription);
```

### Verify Provider Responses

```typescript
// Log raw provider responses
class DebugOrdinalsProvider implements OrdinalsProvider {
  constructor(private baseProvider: OrdinalsProvider) {}

  async getInscriptionById(id: string) {
    console.log('getInscriptionById:', id);
    const result = await this.baseProvider.getInscriptionById(id);
    console.log('Result:', result);
    return result;
  }

  // ... wrap other methods similarly
}

const debugProvider = new DebugOrdinalsProvider(ordinalsClient);
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: debugProvider
});
```

## Getting Help

If you're still experiencing issues:

1. **Check SDK version**: Ensure you're using the latest version
   ```bash
   npm list @originals/sdk
   npm update @originals/sdk
   ```

2. **Review documentation**:
   - [Integration Guide](./BITCOIN_INTEGRATION_GUIDE.md)
   - [API Reference](./BITCOIN_API_REFERENCE.md)
   - [Best Practices](./BITCOIN_BEST_PRACTICES.md)

3. **GitHub Issues**: [https://github.com/onionoriginals/sdk/issues](https://github.com/onionoriginals/sdk/issues)
   - Search existing issues
   - Create new issue with:
     - SDK version
     - Network (mainnet/testnet/etc.)
     - Code snippet
     - Error message
     - Expected vs actual behavior

4. **Community Support**:
   - Discord: [https://discord.gg/originals](https://discord.gg/originals)
   - Twitter: [@originalsprotocol](https://twitter.com/originalsprotocol)
