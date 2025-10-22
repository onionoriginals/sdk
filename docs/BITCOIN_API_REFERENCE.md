# Bitcoin Operations API Reference

Complete API reference for Bitcoin operations in the Originals SDK.

## Table of Contents

- [BitcoinManager](#bitcoinmanager)
- [UTXO Selection](#utxo-selection)
- [Transaction Building](#transaction-building)
- [Fee Calculation](#fee-calculation)
- [Providers](#providers)
- [Types](#types)
- [Errors](#errors)

## BitcoinManager

The `BitcoinManager` class is the main interface for Bitcoin operations.

### Constructor

**Note:** `BitcoinManager` is created internally by `OriginalsSDK`. You typically don't instantiate it directly.

```typescript
constructor(config: OriginalsConfig)
```

**Parameters:**
- `config` (OriginalsConfig): SDK configuration object containing:
  - `network` (BitcoinNetwork): Bitcoin network ('mainnet' | 'testnet' | 'signet' | 'regtest')
  - `ordinalsProvider` (OrdinalsProvider, optional): Provider for Ordinals operations
  - `feeOracle` (FeeOracleAdapter, optional): Fee estimation service
  - `enableLogging` (boolean, optional): Enable logging
  - Other SDK configuration options

**Example (via OriginalsSDK):**
```typescript
import { OriginalsSDK, OrdinalsClient } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  }),
  feeOracle: {
    estimateFeeRate: async (targetBlocks) => {
      const response = await fetch('https://mempool.space/api/v1/fees/recommended');
      const fees = await response.json();
      return targetBlocks <= 1 ? fees.fastestFee : fees.halfHourFee;
    }
  }
});

// Access BitcoinManager through sdk.bitcoin
const inscription = await sdk.bitcoin.inscribeData(data, contentType);
```

**Advanced (Direct Instantiation):**
```typescript
import { BitcoinManager } from '@originals/sdk';

const config = {
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  ordinalsProvider: ordinalsClient,
  feeOracle: feeOracle
};

const bitcoinManager = new BitcoinManager(config);
```

### inscribeData()

Creates a new Ordinals inscription on Bitcoin.

```typescript
async inscribeData(
  data: any,
  contentType: string,
  feeRate?: number
): Promise<OrdinalsInscription>
```

**Parameters:**
- `data` (any): Data to inscribe (string, Buffer, or object)
- `contentType` (string): MIME type (e.g., 'text/plain', 'application/json', 'image/png')
- `feeRate` (number, optional): Fee rate in sat/vB (auto-estimated if not provided)

**Returns:**
- `Promise<OrdinalsInscription>`: Created inscription details

**Throws:**
- `StructuredError` with code:
  - `'ORD_PROVIDER_REQUIRED'`: No provider configured
  - `'INVALID_CONTENT_TYPE'`: Invalid MIME type
  - `'INSUFFICIENT_FUNDS'`: Wallet has insufficient Bitcoin
  - `'FEE_TOO_LOW'`: Fee rate below network minimum

**Example:**
```typescript
// Text inscription
const inscription = await sdk.bitcoin.inscribeData(
  'Hello, Bitcoin!',
  'text/plain;charset=utf-8',
  10
);

// JSON inscription
const jsonInscription = await sdk.bitcoin.inscribeData(
  { name: 'My NFT', properties: { rarity: 'rare' } },
  'application/json'
);

// Image inscription
const imageBuffer = await fs.readFile('./art.png');
const imageInscription = await sdk.bitcoin.inscribeData(
  imageBuffer,
  'image/png',
  15
);
```

**Location:** `src/bitcoin/BitcoinManager.ts:45`

---

### transferInscription()

Transfers an Ordinals inscription to a new Bitcoin address.

```typescript
async transferInscription(
  inscription: OrdinalsInscription,
  toAddress: string
): Promise<BitcoinTransaction>
```

**Parameters:**
- `inscription` (OrdinalsInscription): Inscription to transfer
- `toAddress` (string): Recipient Bitcoin address

**Returns:**
- `Promise<BitcoinTransaction>`: Transfer transaction details

**Throws:**
- `StructuredError` with code:
  - `'INVALID_ADDRESS'`: Invalid Bitcoin address
  - `'INSCRIPTION_NOT_FOUND'`: Inscription doesn't exist
  - `'INSUFFICIENT_FUNDS'`: Can't pay transfer fee

**Note:** Fee rate is automatically determined using the configured fee oracle or provider. The fee rate cannot be manually specified via this method. To control fees, configure a `feeOracle` when creating the SDK.

**Example:**
```typescript
const inscription = await sdk.bitcoin.trackInscription(inscriptionId);

const transferTx = await sdk.bitcoin.transferInscription(
  inscription,
  'bc1qxyz...' // Recipient address
);

console.log('Transfer TX:', transferTx.txid);
```

**Location:** `src/bitcoin/BitcoinManager.ts:180`

---

### trackInscription()

Retrieves inscription details by ID.

```typescript
async trackInscription(
  inscriptionId: string
): Promise<OrdinalsInscription | null>
```

**Parameters:**
- `inscriptionId` (string): Inscription ID to track

**Returns:**
- `Promise<OrdinalsInscription | null>`: Inscription details or null if not found

**Example:**
```typescript
const inscription = await sdk.bitcoin.trackInscription(
  'abc123...i0'
);

if (inscription) {
  console.log('Satoshi:', inscription.satoshi);
  console.log('Content Type:', inscription.contentType);
  console.log('Block Height:', inscription.blockHeight);
} else {
  console.log('Inscription not found');
}
```

**Location:** `src/bitcoin/BitcoinManager.ts:163`

---

### preventFrontRunning()

Checks if a satoshi has multiple inscriptions (front-running detection).

```typescript
async preventFrontRunning(
  satoshi: string
): Promise<boolean>
```

**Parameters:**
- `satoshi` (string): Satoshi identifier to check

**Returns:**
- `Promise<boolean>`: `true` if safe (0-1 inscriptions), `false` if front-run (2+ inscriptions)

**Note:** This method uses the configured Ordinals provider's `getInscriptionsBySatoshi()` method internally. To query inscriptions on a satoshi directly, use `provider.getInscriptionsBySatoshi()` instead (see [OrdinalsProvider Interface](#ordinalsProvider-interface)).

**Example:**
```typescript
const isSafe = await sdk.bitcoin.preventFrontRunning(
  inscription.satoshi
);

if (!isSafe) {
  console.warn('WARNING: Front-running detected!');
  console.warn('Multiple inscriptions on same satoshi');
}
```

**Location:** `src/bitcoin/BitcoinManager.ts:249`

---

### validateBitcoinAddress()

Validates a Bitcoin address for a specific network.

```typescript
validateBitcoinAddress(
  address: string,
  network: BitcoinNetwork
): boolean
```

**Parameters:**
- `address` (string): Bitcoin address to validate
- `network` (BitcoinNetwork): Network to validate against

**Returns:**
- `boolean`: `true` if valid, `false` otherwise

**Example:**
```typescript
// Mainnet addresses
const isValid1 = sdk.bitcoin.validateBitcoinAddress(
  'bc1qxyz...', // Native SegWit
  'mainnet'
);

const isValid2 = sdk.bitcoin.validateBitcoinAddress(
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Legacy
  'mainnet'
);

const isValid3 = sdk.bitcoin.validateBitcoinAddress(
  '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy', // P2SH
  'mainnet'
);

// Testnet address
const isValid4 = sdk.bitcoin.validateBitcoinAddress(
  'tb1qxyz...',
  'testnet'
);

// Cross-network check (fails)
const isValid5 = sdk.bitcoin.validateBitcoinAddress(
  'tb1qxyz...', // Testnet address
  'mainnet'    // Mainnet network
); // Returns false
```

**Location:** `src/bitcoin/BitcoinManager.ts:178`

---

### validateBTCODID()

Validates a did:btco DID identifier.

```typescript
async validateBTCODID(
  didId: string
): Promise<boolean>
```

**Parameters:**
- `didId` (string): DID to validate (format: `did:btco:{satoshi}`)

**Returns:**
- `Promise<boolean>`: `true` if valid and inscription exists

**Example:**
```typescript
const isValid = await sdk.bitcoin.validateBTCODID(
  'did:btco:2099994106992659'
);

if (isValid) {
  console.log('Valid did:btco identifier');
} else {
  console.log('Invalid or inscription not found');
}
```

**Location:** `src/bitcoin/BitcoinManager.ts:198`

---

### getSatoshiFromInscription()

Extracts satoshi identifier from inscription ID.

```typescript
getSatoshiFromInscription(
  inscriptionId: string
): string
```

**Parameters:**
- `inscriptionId` (string): Full inscription ID

**Returns:**
- `string`: Satoshi identifier

**Example:**
```typescript
const satoshi = sdk.bitcoin.getSatoshiFromInscription(
  'abc123...i0'
);

console.log('Satoshi:', satoshi);
// Output: Satoshi: 2099994106992659
```

**Location:** `src/bitcoin/BitcoinManager.ts:221`

---

## UTXO Selection

Functions for selecting UTXOs for transactions.

### selectUtxos()

Basic UTXO selection with multiple strategies.

```typescript
function selectUtxos(
  utxos: Utxo[],
  options: number | SimpleUtxoSelectionOptions
): SimpleUtxoSelectionResult
```

**Parameters:**
- `utxos` (Utxo[]): Available UTXOs
- `options` (number | object):
  - If `number`: Required amount in satoshis
  - If `object`:
    - `requiredAmount` (number): Amount needed in satoshis
    - `strategy` ('minimize_inputs' | 'minimize_change' | 'optimize_size'): Selection strategy
    - `allowPartial` (boolean, optional): Allow partial selection (default: false)

**Returns:**
- `SimpleUtxoSelectionResult`:
  - `selectedUtxos` (Utxo[]): Selected UTXOs
  - `totalInput` (number): Total value of selected UTXOs
  - `change` (number): Change amount
  - `success` (boolean): Whether selection succeeded
  - `error` (string, optional): Error message if failed

**Example:**
```typescript
import { selectUtxos } from '@originals/sdk';

// Simple amount-based selection
const result1 = selectUtxos(utxos, 100000);

// Strategy-based selection
const result2 = selectUtxos(utxos, {
  requiredAmount: 100000,
  strategy: 'minimize_inputs',
  allowPartial: false
});

if (result2.success) {
  console.log('Selected:', result2.selectedUtxos.length, 'UTXOs');
  console.log('Total:', result2.totalInput, 'sats');
  console.log('Change:', result2.change, 'sats');
} else {
  console.error('Selection failed:', result2.error);
}
```

**Location:** `src/bitcoin/utxo.ts:23`

---

### selectResourceUtxos()

Resource-aware UTXO selection that preserves inscribed UTXOs.

```typescript
function selectResourceUtxos(
  availableUtxos: ResourceUtxo[],
  options: ResourceUtxoSelectionOptions
): ResourceUtxoSelectionResult
```

**Parameters:**
- `availableUtxos` (ResourceUtxo[]): UTXOs with resource tags
- `options` (ResourceUtxoSelectionOptions):
  - `requiredAmount` (number): Amount needed in satoshis
  - `feeRate` (number): Fee rate in sat/vB
  - `strategy` ('minimize_inputs' | 'minimize_change' | 'optimize_size'): Selection strategy
  - `preference` ('oldest' | 'closest', optional): UTXO preference
  - `allowPartial` (boolean, optional): Allow partial selection
  - `dustThreshold` (number, optional): Minimum output value (default: 546)

**Returns:**
- `ResourceUtxoSelectionResult`:
  - `selectedUtxos` (ResourceUtxo[]): Selected regular UTXOs
  - `resourceUtxos` (ResourceUtxo[]): Preserved resource UTXOs
  - `totalInput` (number): Total selected value
  - `change` (number): Change amount
  - `estimatedFee` (number): Estimated transaction fee
  - `success` (boolean): Selection succeeded
  - `error` (string, optional): Error message if failed

**Example:**
```typescript
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

// Tag UTXOs with inscription data
const taggedUtxos = tagResourceUtxos(utxos, inscriptionData);

// Select with resource awareness
const result = selectResourceUtxos(taggedUtxos, {
  requiredAmount: 50000,
  feeRate: 10,
  strategy: 'optimize_size',
  preference: 'oldest',
  allowPartial: false
});

if (result.success) {
  console.log('Selected UTXOs:', result.selectedUtxos.length);
  console.log('Preserved inscriptions:', result.resourceUtxos.length);
  console.log('Estimated fee:', result.estimatedFee);
} else {
  console.error('Failed:', result.error);
}
```

**Location:** `src/bitcoin/utxo-selection.ts:45`

---

### selectUtxosForPayment()

Optimized UTXO selection for payments.

```typescript
function selectUtxosForPayment(
  availableUtxos: ResourceUtxo[],
  requiredAmount: number,
  feeRate: number
): ResourceUtxoSelectionResult
```

**Parameters:**
- `availableUtxos` (ResourceUtxo[]): Available UTXOs
- `requiredAmount` (number): Payment amount in satoshis
- `feeRate` (number): Fee rate in sat/vB

**Returns:**
- `ResourceUtxoSelectionResult`: Selection result

**Example:**
```typescript
import { selectUtxosForPayment } from '@originals/sdk';

const result = selectUtxosForPayment(
  utxos,
  75000, // 0.00075 BTC
  12     // 12 sat/vB
);

if (result.success) {
  // Use selected UTXOs for payment
  const tx = buildTransaction(result.selectedUtxos, recipient, amount);
}
```

**Location:** `src/bitcoin/utxo-selection.ts:123`

---

### tagResourceUtxos()

Tags UTXOs with resource information (inscriptions, runes, etc.).

```typescript
function tagResourceUtxos(
  utxos: Utxo[],
  resourceData: Array<{
    utxo: { txid: string; vout: number };
    resourceType: string;
    resourceId: string;
  }>
): ResourceUtxo[]
```

**Parameters:**
- `utxos` (Utxo[]): UTXOs to tag
- `resourceData` (Array): Resource information
  - `utxo`: UTXO identifier (txid + vout)
  - `resourceType`: Type of resource ('inscription', 'rune', etc.)
  - `resourceId`: Resource identifier

**Returns:**
- `ResourceUtxo[]`: UTXOs with resource tags

**Example:**
```typescript
import { tagResourceUtxos } from '@originals/sdk';

const inscriptions = [
  {
    utxo: { txid: 'abc...', vout: 0 },
    resourceType: 'inscription',
    resourceId: 'abc...i0'
  },
  {
    utxo: { txid: 'def...', vout: 1 },
    resourceType: 'inscription',
    resourceId: 'def...i1'
  }
];

const taggedUtxos = tagResourceUtxos(utxos, inscriptions);

// Now selection will preserve these UTXOs
const result = selectResourceUtxos(taggedUtxos, options);
```

**Location:** `src/bitcoin/utxo-selection.ts:178`

---

## Transaction Building

### buildTransferTransaction()

Builds a complete Bitcoin transfer transaction with automatic UTXO selection.

```typescript
function buildTransferTransaction(
  availableUtxos: Utxo[],
  recipientAddress: string,
  amountSats: number,
  feeRateSatsPerVb: number,
  options?: BuildTransferOptions
): {
  tx: BitcoinTransaction;
  selection: SelectionResult;
}
```

**Parameters:**
- `availableUtxos` (Utxo[]): Available UTXOs
- `recipientAddress` (string): Recipient Bitcoin address
- `amountSats` (number): Amount to send in satoshis
- `feeRateSatsPerVb` (number): Fee rate in sat/vB
- `options` (BuildTransferOptions, optional):
  - `excludeUtxos` (Array<{txid: string, vout: number}>, optional): UTXOs to exclude
  - `changeAddress` (string, optional): Change address (defaults to first input address)
  - `dustThreshold` (number, optional): Minimum output (default: 546)

**Returns:**
- Object with:
  - `tx` (BitcoinTransaction): Built transaction
  - `selection` (SelectionResult): UTXO selection details

**Throws:**
- `UtxoSelectionError`: If UTXO selection fails

**Example:**
```typescript
import { buildTransferTransaction } from '@originals/sdk';

const { tx, selection } = buildTransferTransaction(
  utxos,
  'bc1qxyz...', // Recipient
  100000,      // 0.001 BTC
  15,          // 15 sat/vB
  {
    changeAddress: 'bc1qabc...', // Custom change address
    dustThreshold: 546
  }
);

console.log('Transaction ID:', tx.txid);
console.log('Inputs:', tx.vin.length);
console.log('Outputs:', tx.vout.length);
console.log('Fee:', tx.fee, 'sats');
console.log('Selected:', selection.selectedUtxos.length, 'UTXOs');
```

**Location:** `src/bitcoin/transfer.ts:34`

---

### estimateTransactionSize()

Estimates virtual size of a transaction in vBytes.

```typescript
function estimateTransactionSize(
  inputCount: number,
  outputCount: number
): number
```

**Parameters:**
- `inputCount` (number): Number of inputs
- `outputCount` (number): Number of outputs

**Returns:**
- `number`: Estimated size in vBytes

**Example:**
```typescript
import { estimateTransactionSize, calculateFee } from '@originals/sdk';

const vsize = estimateTransactionSize(2, 2); // 2 inputs, 2 outputs
const fee = calculateFee(vsize, 10); // 10 sat/vB

console.log('Estimated size:', vsize, 'vBytes');
console.log('Estimated fee:', fee, 'sats');
```

**Location:** `src/bitcoin/utxo-selection.ts:234`

---

## Fee Calculation

### calculateFee()

Calculates transaction fee based on size and rate.

```typescript
function calculateFee(
  vsize: number,
  feeRateSatsPerVb: number
): bigint
```

**Parameters:**
- `vsize` (number): Transaction virtual size in vBytes
- `feeRateSatsPerVb` (number): Fee rate in sat/vB

**Returns:**
- `bigint`: Fee in satoshis

**Example:**
```typescript
import { calculateFee } from '@originals/sdk';

const fee = calculateFee(250, 15);
console.log('Fee:', fee.toString(), 'sats');
// Output: Fee: 3750 sats
```

**Location:** `src/bitcoin/fee-calculation.ts:12`

---

### estimateFeeSats()

Estimates fee for a transaction with given parameters.

```typescript
function estimateFeeSats(
  inputCount: number,
  outputCount: number,
  feeRate: number
): bigint
```

**Parameters:**
- `inputCount` (number): Number of inputs
- `outputCount` (number): Number of outputs
- `feeRate` (number): Fee rate in sat/vB

**Returns:**
- `bigint`: Estimated fee in satoshis

**Example:**
```typescript
import { estimateFeeSats } from '@originals/sdk';

const fee = estimateFeeSats(3, 2, 12);
console.log('Estimated fee:', fee.toString(), 'sats');
```

**Location:** `src/bitcoin/fee-calculation.ts:28`

---

## Providers

### OrdinalsProvider Interface

```typescript
interface OrdinalsProvider {
  /**
   * Get inscription by ID
   */
  getInscriptionById(
    id: string
  ): Promise<InscriptionDetails | null>;

  /**
   * Get inscriptions on a satoshi
   */
  getInscriptionsBySatoshi(
    satoshi: string
  ): Promise<Array<{ inscriptionId: string }>>;

  /**
   * Create new inscription
   */
  createInscription(params: {
    data: Buffer;
    contentType: string;
    feeRate?: number;
  }): Promise<InscriptionResult>;

  /**
   * Transfer inscription to new address
   */
  transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<TransferResult>;

  /**
   * Broadcast transaction to network
   */
  broadcastTransaction(
    txHexOrObj: unknown
  ): Promise<string>;

  /**
   * Get transaction status
   */
  getTransactionStatus(
    txid: string
  ): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  }>;

  /**
   * Estimate network fee
   */
  estimateFee(blocks?: number): Promise<number>;
}
```

**Example Implementation:**

```typescript
class CustomOrdinalsProvider implements OrdinalsProvider {
  async getInscriptionById(id: string) {
    const response = await fetch(`${this.apiUrl}/inscription/${id}`);
    const data = await response.json();

    return {
      inscriptionId: data.id,
      satoshi: data.sat,
      content: Buffer.from(data.content, 'base64'),
      contentType: data.content_type,
      txid: data.genesis_transaction,
      vout: data.output_index,
      blockHeight: data.block_height
    };
  }

  // ... implement other methods
}
```

**Location:** `src/types/bitcoin.ts:89`

---

### FeeOracleAdapter Interface

```typescript
interface FeeOracleAdapter {
  /**
   * Estimate fee rate for target confirmation time
   */
  estimateFeeRate(targetBlocks?: number): Promise<number>;
}
```

**Example Implementation:**

```typescript
class MempoolSpaceFeeOracle implements FeeOracleAdapter {
  async estimateFeeRate(targetBlocks = 6): Promise<number> {
    const response = await fetch(
      'https://mempool.space/api/v1/fees/recommended'
    );
    const fees = await response.json();

    if (targetBlocks <= 1) return fees.fastestFee;
    if (targetBlocks <= 3) return fees.halfHourFee;
    return fees.hourFee;
  }
}
```

**Location:** `src/types/bitcoin.ts:167`

---

### OrdMockProvider

Mock provider for testing and development.

```typescript
class OrdMockProvider implements OrdinalsProvider {
  constructor(options?: {
    network?: BitcoinNetwork;
    initialState?: MockProviderState;
  })
}
```

**Example:**
```typescript
import { OrdMockProvider } from '@originals/sdk';

const mockProvider = new OrdMockProvider({
  network: 'regtest'
});

const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: mockProvider
});

// All operations work in-memory
const inscription = await sdk.bitcoin.inscribeData(
  'test data',
  'text/plain'
);
```

**Location:** `src/adapters/providers/OrdMockProvider.ts:12`

---

## Types

### BitcoinNetwork

```typescript
type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';
```

---

### Utxo

```typescript
interface Utxo {
  txid: string;              // Transaction ID
  vout: number;              // Output index
  value: number;             // Value in satoshis
  scriptPubKey?: string;     // Script public key
  address?: string;          // Bitcoin address
  inscriptions?: string[];   // Inscription IDs (if any)
  locked?: boolean;          // Wallet lock status
}
```

---

### ResourceUtxo

```typescript
interface ResourceUtxo extends Utxo {
  isResource?: boolean;      // Has inscription/rune
  resourceType?: string;     // 'inscription', 'rune', etc.
  resourceId?: string;       // Resource identifier
}
```

---

### OrdinalsInscription

```typescript
interface OrdinalsInscription {
  satoshi: string;           // Satoshi identifier
  inscriptionId: string;     // Full inscription ID
  content: Buffer;           // Inscription content
  contentType: string;       // MIME type
  txid: string;              // Genesis transaction
  vout: number;              // Output index
  blockHeight?: number;      // Block height (if confirmed)
}
```

---

### BitcoinTransaction

```typescript
interface BitcoinTransaction {
  txid: string;
  vin: TransactionInput[];
  vout: TransactionOutput[];
  fee: number;               // Fee in satoshis
  blockHeight?: number;
  confirmations?: number;
}

interface TransactionInput {
  txid: string;
  vout: number;
  scriptSig?: string;
  sequence?: number;
}

interface TransactionOutput {
  value: number;             // Satoshis
  scriptPubKey: string;
  address?: string;
}
```

---

## Errors

### StructuredError

All SDK errors extend `StructuredError` with a `code` property.

```typescript
class StructuredError extends Error {
  code: string;
  details?: any;
}
```

### Bitcoin Error Codes

| Code | Description | Recovery |
|------|-------------|----------|
| `ORD_PROVIDER_REQUIRED` | No Ordinals provider configured | Configure provider in SDK setup |
| `INVALID_ADDRESS` | Invalid Bitcoin address | Validate address format and network |
| `INVALID_CONTENT_TYPE` | Invalid MIME type | Use valid MIME type |
| `INSUFFICIENT_FUNDS` | Not enough Bitcoin in wallet | Add funds or reduce amount |
| `FEE_TOO_LOW` | Fee rate below minimum | Increase fee rate (min 1.1 sat/vB) |
| `INSCRIPTION_NOT_FOUND` | Inscription doesn't exist | Verify inscription ID |
| `NETWORK_ERROR` | Network request failed | Retry or check connectivity |
| `UTXO_SELECTION_FAILED` | Can't select UTXOs for amount | Check available UTXOs |
| `DUST_OUTPUT` | Output below dust threshold | Increase amount or combine with change |

**Example Error Handling:**

```typescript
try {
  const inscription = await sdk.bitcoin.inscribeData(data, contentType);
} catch (error) {
  if (error instanceof StructuredError) {
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS':
        console.error('Need more Bitcoin');
        break;
      case 'FEE_TOO_LOW':
        console.error('Increase fee rate');
        break;
      case 'NETWORK_ERROR':
        // Retry logic
        await retryOperation();
        break;
      default:
        console.error('Unexpected error:', error.message);
    }
  } else {
    throw error;
  }
}
```

---

### UtxoSelectionError

Specific error for UTXO selection failures.

```typescript
class UtxoSelectionError extends StructuredError {
  code: 'UTXO_SELECTION_FAILED';
  details: {
    requiredAmount: number;
    availableAmount: number;
    selectedUtxos: Utxo[];
  };
}
```

**Example:**
```typescript
import { selectUtxos, UtxoSelectionError } from '@originals/sdk';

try {
  const result = selectUtxos(utxos, { requiredAmount: 1000000 });
} catch (error) {
  if (error instanceof UtxoSelectionError) {
    console.error('Required:', error.details.requiredAmount);
    console.error('Available:', error.details.availableAmount);
    console.error('Shortfall:',
      error.details.requiredAmount - error.details.availableAmount
    );
  }
}
```

**Location:** `src/bitcoin/utxo.ts:189`

---

## Related Documentation

- **Integration Guide**: [BITCOIN_INTEGRATION_GUIDE.md](./BITCOIN_INTEGRATION_GUIDE.md)
- **Migration Guide**: [BITCOIN_MIGRATION_GUIDE.md](./BITCOIN_MIGRATION_GUIDE.md)
- **Best Practices**: [BITCOIN_BEST_PRACTICES.md](./BITCOIN_BEST_PRACTICES.md)
- **Troubleshooting**: [BITCOIN_TROUBLESHOOTING.md](./BITCOIN_TROUBLESHOOTING.md)

## Source Code Locations

All Bitcoin operations are located in the `src/bitcoin/` directory:

- `BitcoinManager.ts` - Main manager class
- `utxo.ts` - Basic UTXO selection
- `utxo-selection.ts` - Resource-aware selection
- `transfer.ts` - Transaction building
- `fee-calculation.ts` - Fee estimation
- `PSBTBuilder.ts` - PSBT construction
- `BroadcastClient.ts` - Transaction broadcasting
- `OrdinalsClient.ts` - HTTP client for Ordinals APIs

Type definitions are in `src/types/bitcoin.ts`.
