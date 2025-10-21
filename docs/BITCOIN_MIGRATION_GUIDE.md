# Bitcoin Operations Migration Guide

This guide helps you migrate from other Bitcoin and Ordinals libraries to the Originals SDK.

## Table of Contents

- [Overview](#overview)
- [Migrating from bitcoinjs-lib](#migrating-from-bitcoinjs-lib)
- [Migrating from Ordinals API Direct Integration](#migrating-from-ordinals-api-direct-integration)
- [Migrating from Custom UTXO Management](#migrating-from-custom-utxo-management)
- [Migrating from Other Ordinals SDKs](#migrating-from-other-ordinals-sdks)
- [Breaking Changes and Compatibility](#breaking-changes-and-compatibility)
- [Migration Checklist](#migration-checklist)

## Overview

The Originals SDK provides a high-level, security-focused API for Bitcoin operations with built-in support for:

- Ordinals inscriptions (creation, transfer, tracking)
- Intelligent UTXO selection (resource-aware)
- Transaction building with automatic fee estimation
- Multiple Bitcoin networks (mainnet, testnet, signet, regtest)
- External signer integration for enterprise security
- Pluggable provider architecture for flexibility

### Key Differences

| Feature | Traditional Approach | Originals SDK |
|---------|---------------------|---------------|
| UTXO Selection | Manual or basic algorithms | Resource-aware (preserves inscriptions) |
| Fee Estimation | Manual or external API | Built-in with fallback chain |
| Inscription Operations | Direct API calls | Abstracted provider pattern |
| Key Management | Custom implementation | External signer support |
| Network Support | Often single network | All networks with unified API |
| Transaction Building | Low-level PSBT construction | High-level abstraction |

## Migrating from bitcoinjs-lib

### Before: Low-Level Transaction Building

```typescript
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

const ECPair = ECPairFactory(ecc);
const network = bitcoin.networks.testnet;

// Manual UTXO selection
const utxos = await fetchUtxos(address);
let inputSum = 0;
const selectedUtxos = [];

for (const utxo of utxos) {
  selectedUtxos.push(utxo);
  inputSum += utxo.value;
  if (inputSum >= amount + estimatedFee) break;
}

// Manual PSBT construction
const psbt = new bitcoin.Psbt({ network });

for (const utxo of selectedUtxos) {
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: bitcoin.address.toOutputScript(address, network),
      value: utxo.value,
    },
  });
}

psbt.addOutput({
  address: recipientAddress,
  value: amount,
});

// Sign and finalize
const keyPair = ECPair.fromWIF(privateKey, network);
psbt.signAllInputs(keyPair);
psbt.finalizeAllInputs();

const tx = psbt.extractTransaction();
const txHex = tx.toHex();
```

### After: High-Level SDK API

```typescript
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'testnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});

// Automatic UTXO selection, fee estimation, and transaction building
const inscription = await sdk.bitcoin.inscribeData(
  data,
  'application/json',
  feeRate // Optional - auto-estimated if not provided
);

console.log('Inscription ID:', inscription.inscriptionId);
console.log('Transaction ID:', inscription.txid);
```

### Migration Steps

1. **Replace manual UTXO selection**:
   ```typescript
   // Before: Custom selection logic
   const selected = selectUtxos(utxos, amount);

   // After: SDK handles it
   import { selectUtxosForPayment } from '@originals/sdk';
   const result = selectUtxosForPayment(utxos, amount, feeRate);
   ```

2. **Replace PSBT construction**:
   ```typescript
   // Before: bitcoinjs-lib PSBT
   const psbt = new bitcoin.Psbt({ network });
   // ... manual input/output management

   // After: SDK transaction builder
   import { buildTransferTransaction } from '@originals/sdk';
   const { tx, selection } = buildTransferTransaction(
     utxos,
     recipientAddress,
     amountSats,
     feeRateSatsPerVb
   );
   ```

3. **Replace key management**:
   ```typescript
   // Before: Direct WIF/private key usage
   const keyPair = ECPair.fromWIF(privateKey, network);

   // After: External signer (recommended for production)
   const signer = {
     sign: async ({ document, proof }) => {
       // Use HSM, AWS KMS, or Privy
       return { proofValue: await yourSigningService.sign(document) };
     },
     getVerificationMethodId: () => verificationMethodId
   };
   ```

## Migrating from Ordinals API Direct Integration

### Before: Direct HTTP Calls

```typescript
import axios from 'axios';

// Create inscription
const createResponse = await axios.post(`${ordApiUrl}/inscribe`, {
  file: Buffer.from(data).toString('base64'),
  fee: feeRate,
  address: destinationAddress
});

const inscriptionId = createResponse.data.inscriptionId;

// Poll for confirmation
let confirmed = false;
while (!confirmed) {
  await sleep(10000);
  const statusResponse = await axios.get(`${ordApiUrl}/inscription/${inscriptionId}`);
  confirmed = statusResponse.data.confirmed;
}

// Transfer inscription
const transferResponse = await axios.post(`${ordApiUrl}/transfer`, {
  inscriptionId,
  destination: newOwnerAddress,
  fee: feeRate
});
```

### After: SDK Provider Pattern

```typescript
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});

// Create inscription (automatic confirmation tracking)
const inscription = await sdk.bitcoin.inscribeData(data, 'image/png');

// Transfer inscription
const transferTx = await sdk.bitcoin.transferInscription(
  inscription,
  newOwnerAddress
);

console.log('Transfer TX:', transferTx.txid);
```

### Migration Steps

1. **Replace HTTP client with OrdinalsProvider**:
   - Remove direct `axios`/`fetch` calls
   - Use `OrdinalsClient` or implement custom `OrdinalsProvider`
   - SDK handles retries, error handling, and response parsing

2. **Use built-in confirmation tracking**:
   ```typescript
   // Before: Manual polling
   while (!confirmed) {
     const status = await checkStatus(txid);
     confirmed = status.confirmed;
     await sleep(interval);
   }

   // After: SDK handles it
   const inscription = await sdk.bitcoin.inscribeData(data, contentType);
   // Returns when confirmed or throws timeout error
   ```

3. **Leverage provider abstraction**:
   ```typescript
   // Custom provider for your Ordinals service
   class MyOrdinalsProvider implements OrdinalsProvider {
     async createInscription(params) {
       // Your custom logic
       return { inscriptionId, txid, vout };
     }

     async getInscriptionById(id) {
       // Your custom logic
       return { inscriptionId, satoshi, content, contentType };
     }

     // ... implement other methods
   }

   const sdk = OriginalsSDK.create({
     network: 'mainnet',
     ordinalsProvider: new MyOrdinalsProvider()
   });
   ```

## Migrating from Custom UTXO Management

### Before: Basic Coin Selection

```typescript
function selectCoins(utxos, targetAmount) {
  utxos.sort((a, b) => b.value - a.value);

  let total = 0;
  const selected = [];

  for (const utxo of utxos) {
    selected.push(utxo);
    total += utxo.value;

    if (total >= targetAmount) {
      return { selected, change: total - targetAmount };
    }
  }

  throw new Error('Insufficient funds');
}

const { selected, change } = selectCoins(utxos, amount + fee);
```

### After: Resource-Aware Selection

```typescript
import { selectResourceUtxos, selectUtxosForPayment } from '@originals/sdk';

// Automatically avoids spending inscribed UTXOs
const result = selectUtxosForPayment(
  utxos,
  requiredAmount,
  feeRate
);

console.log('Selected UTXOs:', result.selectedUtxos);
console.log('Change amount:', result.change);
console.log('Estimated fee:', result.estimatedFee);

// Advanced: Custom selection with preferences
const advancedResult = selectResourceUtxos(utxos, {
  requiredAmount,
  feeRate,
  strategy: 'minimize_inputs', // or 'minimize_change', 'optimize_size'
  preference: 'closest',        // or 'oldest'
  allowPartial: false
});
```

### Migration Steps

1. **Replace basic selection algorithms**:
   ```typescript
   // Before: Simple sorting and accumulation
   const selected = selectCoins(utxos, amount);

   // After: Resource-aware with strategies
   import { selectResourceUtxos } from '@originals/sdk';
   const result = selectResourceUtxos(utxos, {
     requiredAmount: amount,
     feeRate,
     strategy: 'optimize_size'
   });
   ```

2. **Add inscription awareness**:
   ```typescript
   // Tag UTXOs with inscription data
   import { tagResourceUtxos } from '@originals/sdk';

   const inscriptionData = await fetchInscriptions(address);
   const taggedUtxos = tagResourceUtxos(utxos, inscriptionData);

   // Selection automatically preserves inscribed UTXOs
   const result = selectResourceUtxos(taggedUtxos, options);
   ```

3. **Implement dust protection**:
   ```typescript
   // SDK enforces 546 sat dust limit automatically
   const result = selectResourceUtxos(utxos, {
     requiredAmount,
     feeRate,
     dustThreshold: 546 // Built-in, but configurable
   });

   // Throws error if change would be dust
   if (result.change < 546) {
     // SDK adds change to fee automatically
   }
   ```

## Migrating from Other Ordinals SDKs

### Common Patterns

#### Pattern 1: Service-Specific SDKs

If you're using a service-specific SDK (e.g., Xverse SDK, Magic Eden SDK):

```typescript
// Before: Vendor-specific SDK
import { XverseSDK } from '@xverse/sdk';
const xverse = new XverseSDK(apiKey);
const inscription = await xverse.inscribe(data);

// After: Vendor-agnostic with custom provider
class XverseProvider implements OrdinalsProvider {
  constructor(private xverseClient: XverseSDK) {}

  async createInscription(params) {
    const result = await this.xverseClient.inscribe(params.data);
    return {
      inscriptionId: result.id,
      txid: result.txid,
      vout: result.vout
    };
  }

  // ... implement other methods
}

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new XverseProvider(xverseClient)
});
```

#### Pattern 2: Wallet-Based SDKs

For wallet-based SDKs that require user interaction:

```typescript
// Before: Browser wallet integration
const wallet = await window.unisat.requestAccounts();
const txid = await window.unisat.inscribeText(text);

// After: External signer pattern
class UnisatSigner implements ExternalSigner {
  async sign({ document, proof }) {
    const signature = await window.unisat.signMessage(
      JSON.stringify(document)
    );
    return { proofValue: signature };
  }

  getVerificationMethodId() {
    return `did:btc:${address}#key-1`;
  }
}

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: customProvider,
  externalSigner: new UnisatSigner()
});
```

## Breaking Changes and Compatibility

### Network Configuration

**Breaking Change**: Network must be explicitly specified

```typescript
// Before: Defaults to mainnet (dangerous)
const sdk = new SomeSDK();

// After: Explicit network required
const sdk = OriginalsSDK.create({
  network: 'mainnet' // Required parameter
});
```

### Fee Rates

**Breaking Change**: Fee rates in sat/vB (not sat/byte)

```typescript
// Before: May use sat/byte
const fee = calculateFee(txSize, 10); // 10 sat/byte

// After: Always sat/vB
import { calculateFee } from '@originals/sdk';
const fee = calculateFee(txVsize, 10); // 10 sat/vB
```

### UTXO Format

**Compatible**: Standard UTXO format

```typescript
interface Utxo {
  txid: string;
  vout: number;
  value: number;              // satoshis
  scriptPubKey?: string;
  address?: string;
  inscriptions?: string[];    // Optional: inscription IDs
  locked?: boolean;           // Optional: wallet lock
}
```

Existing UTXO data structures should work with minimal changes:
- Ensure `value` is in satoshis (not BTC)
- Add `inscriptions` array if you have Ordinals
- Remove any vendor-specific fields

### Transaction Format

**Compatible**: Standard Bitcoin transaction format

```typescript
interface BitcoinTransaction {
  txid: string;
  vin: TransactionInput[];
  vout: TransactionOutput[];
  fee: number;                 // satoshis
  blockHeight?: number;
  confirmations?: number;
}
```

## Migration Checklist

### Pre-Migration

- [ ] Audit current Bitcoin operations and dependencies
- [ ] Identify all inscription-related code
- [ ] Document custom UTXO selection logic
- [ ] Review key management and signing processes
- [ ] Catalog all network endpoints and API keys

### During Migration

- [ ] Install Originals SDK: `npm install @originals/sdk`
- [ ] Set up test environment with regtest or signet network
- [ ] Configure `OrdinalsProvider` (use `OrdMockProvider` for testing)
- [ ] Replace UTXO selection with SDK functions
- [ ] Replace transaction building with SDK methods
- [ ] Migrate inscription operations to `BitcoinManager`
- [ ] Implement external signer if using hardware/KMS
- [ ] Update fee estimation to use SDK or fee oracle
- [ ] Replace network-specific code with unified API
- [ ] Update error handling for new error types

### Testing

- [ ] Unit test UTXO selection with various scenarios
- [ ] Integration test inscription creation on testnet
- [ ] Test inscription transfer workflow
- [ ] Verify fee estimation accuracy
- [ ] Test resource-aware UTXO selection (don't spend inscriptions)
- [ ] Test dust threshold handling
- [ ] Test external signer integration
- [ ] Load test with production-like data

### Post-Migration

- [ ] Monitor mainnet operations closely
- [ ] Set up alerts for failed transactions
- [ ] Document any custom provider implementations
- [ ] Train team on new SDK patterns
- [ ] Update CI/CD pipelines
- [ ] Archive old dependencies safely
- [ ] Measure performance improvements

## Support and Resources

- **API Reference**: [BITCOIN_API_REFERENCE.md](./BITCOIN_API_REFERENCE.md)
- **Integration Guide**: [BITCOIN_INTEGRATION_GUIDE.md](./BITCOIN_INTEGRATION_GUIDE.md)
- **Best Practices**: [BITCOIN_BEST_PRACTICES.md](./BITCOIN_BEST_PRACTICES.md)
- **Troubleshooting**: [BITCOIN_TROUBLESHOOTING.md](./BITCOIN_TROUBLESHOOTING.md)
- **GitHub Issues**: [https://github.com/onionoriginals/sdk/issues](https://github.com/onionoriginals/sdk/issues)

## Example Migration Project

See the [examples/migration](../examples/migration) directory for a complete before/after migration example showing:

- bitcoinjs-lib → SDK transaction building
- Direct API calls → OrdinalsProvider pattern
- Custom UTXO selection → Resource-aware selection
- WIF keys → External signer integration

Each example includes tests demonstrating equivalent functionality.
