# PRD: BitcoinManager - Bitcoin Blockchain Integration for Originals SDK

**Status:** 🔴 Critical - Immediate Priority  
**Timeline:** ASAP (Immediate)  
**Team:** 1-2 engineers  
**Created:** October 16, 2025

---

## Executive Summary

The Originals SDK requires robust Bitcoin blockchain integration to enable immutable asset anchoring, cryptographic provenance verification, and permanent record-keeping for digital assets across diverse use cases—from high-value art and tradable collectibles to scientific data and supply chain records.

**Current State:**  
The SDK has a `BitcoinManager` class (~326 lines) providing basic Bitcoin/Ordinals integration through provider adapters. It supports inscription creation, tracking, transfer, and front-running prevention.

**The Gap:**  
While functional for basic operations, the BitcoinManager needs enhanced capabilities for production-grade asset anchoring, including comprehensive transaction monitoring, advanced anchor verification, complete error handling, and seamless integration with the SDK's lifecycle event system.

**Business Value:**  
- **Permanent Provenance:** Assets anchored to Bitcoin cannot be tampered with or lost
- **Universal Trust:** Bitcoin's security model provides trustless verification for anyone
- **High-Value Protection:** Critical for assets worth thousands to millions of dollars
- **Composability:** Generic anchoring supports any asset type (art, data, credentials, etc.)
- **Economic Gravity:** Users pay $75-200 per anchor, ensuring only valuable assets use Bitcoin layer

---

## Introduction

The BitcoinManager is the bridge between the Originals SDK's multi-layer asset lifecycle (`did:peer` → `did:webvh` → `did:btco`) and the Bitcoin blockchain. It enables developers to:

1. **Anchor Asset Manifests:** Permanently inscribe asset metadata to Bitcoin via Ordinals
2. **Verify Anchors:** Cryptographically prove asset existence and authenticity on-chain
3. **Track History:** Retrieve complete anchor history for provenance auditing
4. **Transfer Ownership:** Move asset ownership via Bitcoin transactions
5. **Monitor Transactions:** Track confirmation status and handle network events

**Why Bitcoin + Ordinals:**
- **Immutability:** Bitcoin's proof-of-work ensures data permanence
- **Decentralization:** No central authority can censor or modify anchored data
- **Satoshi-Level Addressing:** Each satoshi can uniquely identify an asset (did:btco:123456789)
- **Native Integration:** Ordinals inscriptions are native Bitcoin data, not sidechains

**Who Benefits:**
- **Artists & Creators:** Anchor high-value digital art for permanent provenance
- **Enterprises:** Anchor supply chain records, compliance documents, audit trails
- **Researchers:** Anchor scientific datasets for reproducibility and attribution
- **DAOs:** Anchor governance decisions for immutable organizational history
- **Developers:** Build applications with trustless asset verification

---

## Goals

1. **Enable Production-Ready Bitcoin Anchoring** - Developers can reliably inscribe assets on mainnet and signet with confidence
2. **Provide Generic Asset Support** - Any asset type (art, data, credentials) can be anchored without asset-specific logic
3. **Ensure Transaction Reliability** - Robust error handling, retry logic, and confirmation tracking prevent failures
4. **Integrate Lifecycle Events** - Bitcoin operations emit structured events for monitoring and orchestration
5. **Optimize Economics** - Transparent fee management and batch inscription support minimize costs
6. **Maintain Security** - Private keys never exposed, testnet/mainnet separation enforced, front-running prevented

---

## Use Cases

### Use Case 1: High-Value Digital Art Anchoring

**Scenario:**  
An artist creates a limited-edition digital artwork worth $50,000. They want permanent provenance proof that survives platform failures.

**Flow:**
1. Artist creates asset in `did:peer` layer (private, offline)
2. Artist publishes to `did:webvh` layer (discoverable via HTTPS)
3. Artist anchors to Bitcoin via `BitcoinManager.inscribeData()`
4. Asset manifest (metadata + resource hashes) inscribed as Ordinals inscription
5. Inscription assigned unique satoshi → `did:btco:123456789`
6. Buyer verifies authenticity via `BitcoinManager.verifyAnchor()`
7. Ownership transferred via `BitcoinManager.transferInscription()`

**Why Bitcoin:**  
$50,000 asset justifies ~$100 inscription cost. Bitcoin immutability protects investment.

---

### Use Case 2: Supply Chain Audit Trail

**Scenario:**  
A pharmaceutical company must prove drug manufacturing records haven't been tampered with for regulatory compliance.

**Flow:**
1. Each batch produces asset with timestamp, location, quality metrics
2. Batch records anchored to Bitcoin at production milestones
3. Regulators verify anchor history via `BitcoinManager.getAnchorHistory()`
4. Tampering detected if hashes don't match on-chain records

**Why Bitcoin:**  
Regulatory compliance requires proof data existed at specific time and hasn't changed.

---

### Use Case 3: Scientific Data Integrity

**Scenario:**  
Researchers publish climate study dataset. They need proof dataset wasn't altered post-publication.

**Flow:**
1. Dataset resources hashed during collection
2. Asset manifest anchored to Bitcoin at publication time
3. Peer reviewers verify via `BitcoinManager.verifyAnchor()`
4. Future citations include Bitcoin transaction ID for verification

**Why Bitcoin:**  
Academic integrity requires immutable timestamps and cryptographic proof of data authenticity.

---

### Use Case 4: DAO Governance Immutability

**Scenario:**  
A DAO makes critical governance decision (e.g., treasury allocation of $2M). Members want permanent, tamper-proof record.

**Flow:**
1. Governance proposal asset created with vote results
2. After vote completion, result anchored to Bitcoin
3. `did:btco:` identifier embedded in DAO smart contract
4. Disputes resolved by verifying on-chain governance record

**Why Bitcoin:**  
Multi-million dollar decisions require highest-security record-keeping.

---

### Use Case 5: Batch Inscription for NFT Collections

**Scenario:**  
An artist launches 100-piece NFT collection. Anchoring each individually costs $10,000 in fees.

**Flow:**
1. Artist creates 100 assets in batch
2. Uses `LifecycleManager.batchInscribeOnBitcoin()` with `singleTransaction: true`
3. All 100 manifests combined into single Bitcoin transaction
4. Costs reduced by 30%+ due to shared transaction overhead
5. Each asset still gets unique inscription ID

**Why Batch:**  
$10,000 → $7,000 in fees makes Bitcoin economically viable for entire collection.

---

## Technical Architecture

### System Design

```
┌─────────────────────────────────────────────────────────────┐
│                      Originals SDK                           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │ LifecycleManager │────────▶│  BitcoinManager  │          │
│  └──────────────────┘         └────────┬─────────┘          │
│         │                              │                     │
│         │ Events                       │                     │
│         ▼                              ▼                     │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  EventEmitter    │         │  OrdinalsProvider│          │
│  └──────────────────┘         │    (Adapter)     │          │
│                                └────────┬─────────┘          │
└─────────────────────────────────────────┼──────────────────┘
                                          │
                                          ▼
                        ┌─────────────────────────────┐
                        │    Bitcoin Network          │
                        │  (Mainnet / Signet)         │
                        │                             │
                        │  ┌──────────────────────┐   │
                        │  │  Ordinals Protocol   │   │
                        │  │  (Inscriptions)      │   │
                        │  └──────────────────────┘   │
                        └─────────────────────────────┘
```

### Component Relationships

**BitcoinManager → OrdinalsProvider:**
- BitcoinManager delegates Bitcoin operations to pluggable provider
- Provider handles network-specific logic (mainnet, testnet, signet)
- Supports multiple implementations:
  - `OrdMockProvider` (testing)
  - `OrdHttpProvider` (production)
  - Custom providers (user's own node, third-party APIs)

**BitcoinManager → FeeOracleAdapter:**
- Optional adapter for dynamic fee estimation
- Queries mempool.space, blockstream, or custom oracle
- Falls back to provider's estimateFee() if not configured

**LifecycleManager → BitcoinManager:**
- LifecycleManager.inscribeOnBitcoin() orchestrates high-level flow
- BitcoinManager handles low-level Bitcoin operations
- Events emitted to both managers' EventEmitters

**BitcoinManager → EventEmitter:**
- Emits `asset:migrated` events when inscriptions complete
- Emits `batch:completed` events for batch operations
- Telemetry events for fee estimation, errors

### Data Flow: Asset Inscription

```
1. User calls lifecycle.inscribeOnBitcoin(asset, feeRate?)
                    ↓
2. LifecycleManager creates asset manifest:
   {
     assetId: "did:peer:abc123",
     resources: [{ id, hash, contentType, url }],
     timestamp: "2025-10-16T..."
   }
                    ↓
3. BitcoinManager.inscribeData(manifest, 'application/json', feeRate)
                    ↓
4. Fee resolution (FeeOracle → Provider → provided)
                    ↓
5. OrdinalsProvider.createInscription()
   → Commit transaction (P2TR output)
   → Reveal transaction (inscription witness)
                    ↓
6. Transaction broadcast & confirmation tracking
                    ↓
7. BitcoinManager returns OrdinalsInscription:
   {
     inscriptionId: "abc123i0",
     satoshi: "1234567890",
     txid: "reveal-tx-id",
     commitTxId: "commit-tx-id",
     revealTxId: "reveal-tx-id",
     feeRate: 15
   }
                    ↓
8. Asset migrated to did:btco layer
   → Binding: "did:btco:1234567890"
   → Provenance updated with Bitcoin metadata
```

---

## API Contract Details

### Core Methods

#### `inscribeData(data: Buffer, contentType: string, feeRate?: number): Promise<OrdinalsInscription>`

**Purpose:** Inscribe arbitrary data to Bitcoin via Ordinals protocol

**Parameters:**
- `data: Buffer` - Content to inscribe (asset manifest, image data, JSON, etc.)
  - **Validation:** Must not be null/undefined
  - **Max size:** Typically 400KB (provider-dependent)
- `contentType: string` - MIME type describing data format
  - **Validation:** Must match RFC 6838 format (e.g., `application/json`, `image/png`)
  - **Examples:** `text/plain`, `application/json`, `image/png`, `application/octet-stream`
- `feeRate?: number` - Optional fee rate in sat/vB
  - **Validation:** Must be positive, finite number between 1-1000000 sat/vB
  - **Default:** Resolved via FeeOracle → Provider → undefined

**Returns:** `Promise<OrdinalsInscription>`
```typescript
{
  satoshi: string;           // Unique satoshi identifier (e.g., "1234567890")
  inscriptionId: string;     // Ordinals inscription ID (e.g., "abc123i0")
  content: Buffer;           // Inscribed content
  contentType: string;       // MIME type
  txid: string;              // Bitcoin transaction ID (reveal tx)
  vout: number;              // Output index
  blockHeight?: number;      // Block height (if confirmed)
  revealTxId?: string;       // Reveal transaction ID
  commitTxId?: string;       // Commit transaction ID
  feeRate?: number;          // Actual fee rate used
}
```

**Error Handling:**
| Error Code | Condition | User Action |
|------------|-----------|-------------|
| `INVALID_INPUT` | Data null/undefined | Provide valid data |
| `INVALID_INPUT` | Invalid MIME type | Use valid MIME format |
| `INVALID_INPUT` | feeRate ≤ 0 or non-finite | Provide positive fee rate |
| `ORD_PROVIDER_REQUIRED` | No ordinalsProvider configured | Add provider to SDK config |
| `ORD_PROVIDER_UNSUPPORTED` | Provider doesn't support createInscription | Use different provider |
| `ORD_PROVIDER_INVALID_RESPONSE` | Provider returns incomplete data | Check provider implementation |
| `INVALID_SATOSHI` | Provider returns invalid satoshi format | Report to provider maintainer |

**Rate Limiting:**
- Depends on OrdinalsProvider implementation
- Recommended: 1 inscription per block (~10 minutes) for confirmation reliability
- Batch inscriptions bypass per-inscription rate limits

**Retry Logic:**
- Provider-level retries handled internally by OrdinalsProvider
- SDK does NOT automatically retry failed inscriptions
- Users should implement application-level retry with exponential backoff

**Example:**
```typescript
const manifest = Buffer.from(JSON.stringify({
  assetId: 'did:peer:abc123',
  resources: [{ id: 'img1', hash: 'sha256-...', contentType: 'image/png' }]
}));

const inscription = await sdk.bitcoin.inscribeData(
  manifest,
  'application/json',
  10 // 10 sat/vB
);

console.log(`Inscribed: ${inscription.inscriptionId}`);
console.log(`Satoshi: ${inscription.satoshi}`);
console.log(`DID: did:btco:${inscription.satoshi}`);
```

---

#### `verifyAnchor(assetId: string, txId: string): Promise<boolean>`

**Purpose:** Verify that an asset's anchor exists on Bitcoin and matches expected data

**Parameters:**
- `assetId: string` - Asset identifier (DID or hash)
  - **Validation:** Must be non-empty string
  - **Format:** `did:peer:*`, `did:webvh:*`, or raw identifier
- `txId: string` - Bitcoin transaction ID to verify
  - **Validation:** Must be valid 64-character hex string
  - **Format:** `[0-9a-fA-F]{64}`

**Returns:** `Promise<boolean>`
- `true` - Anchor exists on-chain and data integrity verified
- `false` - Anchor missing, data mismatch, or transaction invalid

**Verification Steps:**
1. Fetch transaction from Bitcoin network via OrdinalsProvider
2. Extract inscription data from transaction witness
3. Parse inscription content as JSON (assuming asset manifest)
4. Compare `assetId` field in manifest with provided `assetId`
5. Verify inscription confirmed (blockHeight exists)
6. Return true if all checks pass

**Error Handling:**
| Error Code | Condition | User Action |
|------------|-----------|-------------|
| `INVALID_INPUT` | assetId empty | Provide valid asset ID |
| `INVALID_INPUT` | txId not 64-char hex | Provide valid transaction ID |
| `ORD_PROVIDER_REQUIRED` | No provider configured | Add provider to SDK config |
| `TRANSACTION_NOT_FOUND` | Transaction doesn't exist | Check transaction ID or wait for propagation |

**Example:**
```typescript
const verified = await sdk.bitcoin.verifyAnchor(
  'did:peer:abc123',
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
);

if (verified) {
  console.log('✅ Asset anchor verified on Bitcoin');
} else {
  console.log('❌ Anchor verification failed');
}
```

---

#### `getAnchorHistory(assetId: string): Promise<AnchorRecord[]>`

**Purpose:** Retrieve complete history of Bitcoin anchors for an asset

**Parameters:**
- `assetId: string` - Asset identifier
  - **Validation:** Must be non-empty string
  - **Format:** Any valid DID or identifier

**Returns:** `Promise<AnchorRecord[]>`
```typescript
interface AnchorRecord {
  txid: string;                // Bitcoin transaction ID
  inscriptionId: string;       // Ordinals inscription ID
  satoshi: string;             // Satoshi identifier
  blockHeight: number;         // Block height of confirmation
  timestamp: string;           // ISO 8601 timestamp
  contentHash: string;         // SHA-256 hash of inscribed content
  confirmations: number;       // Number of confirmations
  feeRate?: number;            // Fee rate used (sat/vB)
}
```

**Sorting:** Records returned in chronological order (oldest → newest)

**Performance Considerations:**
- Query time proportional to number of anchors
- Expected: <1s for assets with <10 anchors
- Expected: <5s for assets with <100 anchors
- For high-volume assets (1000+ anchors), consider pagination

**Error Handling:**
| Error Code | Condition | User Action |
|------------|-----------|-------------|
| `INVALID_INPUT` | assetId empty | Provide valid asset ID |
| `ORD_PROVIDER_REQUIRED` | No provider configured | Add provider to SDK config |
| `ANCHOR_LOOKUP_FAILED` | Provider query failed | Retry or check provider status |

**Example:**
```typescript
const history = await sdk.bitcoin.getAnchorHistory('did:peer:abc123');

console.log(`Found ${history.length} anchors:`);
history.forEach(record => {
  console.log(`- Block ${record.blockHeight}: ${record.inscriptionId}`);
  console.log(`  Confirmations: ${record.confirmations}`);
  console.log(`  Hash: ${record.contentHash}`);
});
```

---

#### `broadcastTransaction(tx: string): Promise<string>`

**Purpose:** Broadcast a signed Bitcoin transaction to the network

**Parameters:**
- `tx: string` - Raw transaction hex
  - **Validation:** Must be valid hex string
  - **Format:** Bitcoin raw transaction format

**Returns:** `Promise<string>` - Transaction ID (txid)

**Broadcasting Strategy:**
1. Attempt broadcast via primary OrdinalsProvider
2. If broadcast fails with temporary error, retry up to 3 times
3. Exponential backoff: 1s, 2s, 4s between retries
4. If permanent error (e.g., double-spend), fail immediately
5. Return txid if successful

**Error Categories:**
- **Temporary (retry):** Network timeout, node unavailable, mempool full
- **Permanent (fail):** Invalid transaction, double-spend, insufficient fee

**Error Handling:**
| Error Code | Condition | User Action |
|------------|-----------|-------------|
| `INVALID_INPUT` | tx not valid hex | Provide raw transaction hex |
| `TX_BROADCAST_FAILED` | Permanent error | Check transaction validity |
| `TX_BROADCAST_TIMEOUT` | All retries exhausted | Retry later or increase fee |
| `ORD_PROVIDER_REQUIRED` | No provider configured | Add provider to SDK config |

**Example:**
```typescript
const rawTxHex = '0200000001...'; // Signed transaction hex

const txid = await sdk.bitcoin.broadcastTransaction(rawTxHex);
console.log(`Broadcast successful: ${txid}`);
```

---

#### `monitorTransaction(txId: string): Promise<TransactionStatus>`

**Purpose:** Monitor transaction confirmation status with polling

**Parameters:**
- `txId: string` - Bitcoin transaction ID
  - **Validation:** Must be valid 64-character hex string

**Returns:** `Promise<TransactionStatus>`
```typescript
interface TransactionStatus {
  txid: string;                // Transaction ID
  confirmed: boolean;          // Whether transaction is confirmed
  confirmations: number;       // Number of confirmations
  blockHeight?: number;        // Block height (if confirmed)
  blockHash?: string;          // Block hash (if confirmed)
  timestamp?: string;          // ISO 8601 timestamp
  inMempool: boolean;          // Whether transaction is in mempool
}
```

**Monitoring Behavior:**
1. Poll transaction status every 10 seconds (configurable)
2. Stop polling when:
   - Transaction reaches 1 confirmation (default target)
   - Maximum polling time reached (30 minutes default)
   - Transaction rejected by network
3. Emit events at key milestones:
   - `transaction:mempool` - Transaction seen in mempool
   - `transaction:confirmed` - First confirmation
   - `transaction:finalized` - Target confirmations reached

**Timeout Configuration:**
```typescript
// Via SDK config
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  bitcoinMonitoring: {
    pollInterval: 10000,      // 10 seconds
    maxPollTime: 1800000,     // 30 minutes
    targetConfirmations: 1     // Stop after 1 confirmation
  }
});
```

**Error Handling:**
| Error Code | Condition | User Action |
|------------|-----------|-------------|
| `INVALID_INPUT` | txId invalid | Provide valid transaction ID |
| `TX_MONITORING_TIMEOUT` | Max poll time exceeded | Transaction may be stuck, check mempool |
| `TX_MONITORING_FAILED` | Provider query failed | Retry or check provider status |
| `ORD_PROVIDER_REQUIRED` | No provider configured | Add provider to SDK config |

**Example:**
```typescript
const status = await sdk.bitcoin.monitorTransaction(
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
);

console.log(`Confirmed: ${status.confirmed}`);
console.log(`Confirmations: ${status.confirmations}`);
console.log(`Block: ${status.blockHeight}`);
```

---

### Supporting Methods (Existing)

#### `trackInscription(inscriptionId: string): Promise<OrdinalsInscription | null>`

**Purpose:** Retrieve inscription details by ID

**Implementation:** Already exists in BitcoinManager (lines 163-178)

---

#### `transferInscription(inscription: OrdinalsInscription, toAddress: string): Promise<BitcoinTransaction>`

**Purpose:** Transfer inscription ownership to new Bitcoin address

**Implementation:** Already exists in BitcoinManager (lines 180-247)

**Key Features:**
- Validates Bitcoin address format and checksum
- Uses fee oracle/provider for fee estimation
- Returns BitcoinTransaction with transfer details
- Updates inscription.satoshi if provider returns new satoshi

---

#### `preventFrontRunning(satoshi: string): Promise<boolean>`

**Purpose:** Check if satoshi has multiple inscriptions (front-running protection)

**Implementation:** Already exists in BitcoinManager (lines 249-257)

**Returns:** `true` if satoshi has ≤1 inscription (safe), `false` if multiple (front-run risk)

---

#### `getSatoshiFromInscription(inscriptionId: string): Promise<string | null>`

**Purpose:** Resolve inscription ID to satoshi identifier

**Implementation:** Already exists in BitcoinManager (lines 259-276)

**Validation:** Returns null if satoshi format invalid

---

#### `validateBTCODID(didId: string): Promise<boolean>`

**Purpose:** Validate did:btco DID exists on Bitcoin

**Implementation:** Already exists in BitcoinManager (lines 278-290)

**Supports:**
- `did:btco:123456789` (mainnet)
- `did:btco:test:123456789` (testnet)
- `did:btco:sig:123456789` (signet)

---

## Data Models

### OrdinalsInscription (Existing)

```typescript
interface OrdinalsInscription {
  satoshi: string;           // Unique satoshi identifier
  inscriptionId: string;     // Ordinals inscription ID
  content: Buffer;           // Inscribed content
  contentType: string;       // MIME type
  txid: string;              // Bitcoin transaction ID
  vout: number;              // Output index
  blockHeight?: number;      // Block height (if confirmed)
}
```

**Extensions in BitcoinManager:**
```typescript
interface ExtendedOrdinalsInscription extends OrdinalsInscription {
  revealTxId?: string;       // Reveal transaction ID
  commitTxId?: string;       // Commit transaction ID
  feeRate?: number;          // Fee rate used (sat/vB)
}
```

---

### AnchorRecord (NEW - To Be Defined)

```typescript
interface AnchorRecord {
  txid: string;                // Bitcoin transaction ID
  inscriptionId: string;       // Ordinals inscription ID
  satoshi: string;             // Satoshi identifier
  blockHeight: number;         // Block height of confirmation
  timestamp: string;           // ISO 8601 timestamp
  contentHash: string;         // SHA-256 hash of inscribed content
  confirmations: number;       // Number of confirmations
  feeRate?: number;            // Fee rate used (sat/vB)
  assetId?: string;            // Asset identifier (if manifest)
  metadata?: {                 // Optional metadata
    batchId?: string;          // Batch inscription ID
    batchIndex?: number;       // Index in batch
  };
}
```

**Location:** `src/types/bitcoin.ts`

---

### TransactionStatus (NEW - To Be Defined)

```typescript
interface TransactionStatus {
  txid: string;                // Transaction ID
  confirmed: boolean;          // Whether transaction is confirmed
  confirmations: number;       // Number of confirmations
  blockHeight?: number;        // Block height (if confirmed)
  blockHash?: string;          // Block hash (if confirmed)
  timestamp?: string;          // ISO 8601 timestamp (block time)
  inMempool: boolean;          // Whether transaction is in mempool
  fee?: number;                // Transaction fee in satoshis
  size?: number;               // Transaction size in bytes
  vsize?: number;              // Virtual size in vbytes
  weight?: number;             // Transaction weight
}
```

**Location:** `src/types/bitcoin.ts`

---

### BitcoinTransaction (Existing)

```typescript
interface BitcoinTransaction {
  txid: string;                // Transaction ID
  vin: TransactionInput[];     // Inputs
  vout: TransactionOutput[];   // Outputs
  fee: number;                 // Fee in satoshis
  blockHeight?: number;        // Block height (if confirmed)
  confirmations?: number;      // Number of confirmations
}

interface TransactionInput {
  txid: string;                // Previous transaction ID
  vout: number;                // Previous output index
  scriptSig?: string;          // Signature script
  witness?: string[];          // Witness data (SegWit)
}

interface TransactionOutput {
  value: number;               // Value in satoshis
  scriptPubKey: string;        // Script public key
  address?: string;            // Bitcoin address (decoded)
}
```

**Location:** `src/types/bitcoin.ts` (already exists)

---

### OrdinalsProvider Adapter Interface (Existing)

```typescript
interface OrdinalsProvider {
  createInscription(params: {
    data: Buffer;
    contentType: string;
    feeRate?: number;
  }): Promise<{
    inscriptionId: string;
    revealTxId?: string;
    commitTxId?: string;
    satoshi?: string;
    txid: string;
    vout: number;
    blockHeight?: number;
    content?: Buffer;
    contentType?: string;
    feeRate?: number;
  }>;

  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    content: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
  } | null>;

  transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<{
    txid: string;
    vin?: TransactionInput[];
    vout?: TransactionOutput[];
    fee?: number;
    satoshi?: string;
    blockHeight?: number;
    confirmations?: number;
  }>;

  getInscriptionsBySatoshi(satoshi: string): Promise<{ inscriptionId: string }[]>;

  broadcastTransaction(rawTx: string): Promise<string>;

  getTransactionStatus(txid: string): Promise<{ confirmed: boolean; confirmations?: number }>;

  estimateFee(targetBlocks?: number): Promise<number>;
}
```

**Location:** `src/adapters/types.ts`

---

### FeeOracleAdapter Interface (Existing)

```typescript
interface FeeOracleAdapter {
  estimateFeeRate(targetBlocks: number): Promise<number>;
}
```

**Location:** `src/adapters/types.ts`

---

## Security Requirements

### 1. Private Key Management

**CRITICAL:** BitcoinManager MUST NEVER handle private keys directly.

**Design Principles:**
- **External Signing:** All transaction signing delegated to OrdinalsProvider
- **Provider Responsibility:** Provider manages keys (hardware wallet, software wallet, KMS, etc.)
- **SDK Scope:** SDK only constructs unsigned transactions (PSBTs) and coordinates flow

**Implementation in Code:**
```typescript
// ❌ NEVER DO THIS
class BitcoinManager {
  private privateKey: string; // SECURITY VIOLATION
}

// ✅ CORRECT APPROACH
class BitcoinManager {
  constructor(private config: OriginalsConfig) {
    // No private key storage
    // Signing delegated to config.ordinalsProvider
  }
}
```

**User Responsibility:**
- Users provide OrdinalsProvider implementation with signing capability
- SDK trusts provider to handle keys securely
- Examples:
  - Hardware wallet integration (Ledger, Trezor)
  - AWS KMS
  - HSM
  - Software wallet (user's responsibility to secure)

---

### 2. Testnet vs Mainnet Separation

**CRITICAL:** Prevent accidental mainnet operations during testing.

**Network Configuration:**
```typescript
type BitcoinNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

interface OriginalsConfig {
  network: BitcoinNetwork;   // REQUIRED - explicit network selection
  ordinalsProvider?: OrdinalsProvider;
  feeOracle?: FeeOracleAdapter;
}
```

**Enforcement:**
1. **Config Validation:** SDK validates network matches provider's network
2. **DID Prefix Validation:** `did:btco:` (mainnet), `did:btco:test:`, `did:btco:sig:`
3. **Address Validation:** Bitcoin address format checked against configured network
4. **Fail-Safe:** Operations abort if network mismatch detected

**Example:**
```typescript
// ✅ SAFE: Explicit network
const sdk = OriginalsSDK.create({
  network: 'signet',
  ordinalsProvider: new OrdinalsClient({ network: 'signet', ... })
});

// ❌ UNSAFE: Network mismatch (SDK would reject)
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({ network: 'testnet', ... })
  // ERROR: Network mismatch
});
```

---

### 3. Front-Running Prevention

**Threat:** Attacker inscribes data on same satoshi before honest user, invalidating their asset.

**Mitigation - Implemented:**
```typescript
async preventFrontRunning(satoshi: string): Promise<boolean> {
  // Check if satoshi already has inscriptions
  const inscriptions = await this.ord.getInscriptionsBySatoshi(satoshi);
  return inscriptions.length <= 1; // Safe if ≤1 inscription
}
```

**Usage Pattern:**
```typescript
// Before inscribing with specific satoshi
const satoshi = '1234567890';
const isSafe = await sdk.bitcoin.preventFrontRunning(satoshi);

if (!isSafe) {
  console.warn('⚠️ Satoshi already has inscriptions - choose different satoshi');
  // User should select different satoshi or accept risk
}
```

**Limitations:**
- Only prevents known front-running (inscriptions already confirmed)
- Cannot prevent concurrent mempool front-running (race condition)
- Users targeting specific rare satoshis face higher risk

---

### 4. Transaction Verification

**Threat:** Malicious provider returns fake inscription data.

**Mitigation - Required:**
```typescript
async verifyAnchor(assetId: string, txId: string): Promise<boolean> {
  // 1. Fetch transaction from Bitcoin network
  const tx = await this.fetchTransaction(txId);
  
  // 2. Extract inscription data from witness
  const inscription = this.extractInscription(tx);
  
  // 3. Verify data integrity (hash matches)
  const manifest = JSON.parse(inscription.content.toString());
  if (manifest.assetId !== assetId) return false;
  
  // 4. Verify transaction confirmed
  if (!tx.blockHeight) return false;
  
  return true;
}
```

**User Best Practice:**
```typescript
// Don't trust, verify
const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');

// Wait for confirmation
await sdk.bitcoin.monitorTransaction(inscription.txid);

// Verify anchor on-chain
const verified = await sdk.bitcoin.verifyAnchor(assetId, inscription.txid);
assert(verified, 'Anchor verification failed');
```

---

### 5. Input Validation

**All public methods MUST validate inputs rigorously:**

| Input | Validation Rules |
|-------|------------------|
| `data: Buffer` | Not null/undefined |
| `contentType: string` | Valid MIME type regex |
| `feeRate: number` | Positive, finite, 1-1000000 sat/vB |
| `assetId: string` | Non-empty string |
| `txId: string` | 64-char hex string |
| `toAddress: string` | Valid Bitcoin address for configured network |
| `satoshi: string` | Valid satoshi number format |

**Error Response:**
```typescript
throw new StructuredError('INVALID_INPUT', 'Descriptive message');
```

---

### 6. Audit Logging

**All Bitcoin operations MUST be logged for security audits:**

```typescript
// Example: inscribeData logging
emitTelemetry(this.config.telemetry, {
  name: 'bitcoin.inscription.started',
  attributes: {
    contentType,
    dataSize: data.length,
    feeRate: effectiveFeeRate,
    network: this.config.network
  }
});

// ... operation ...

emitTelemetry(this.config.telemetry, {
  name: 'bitcoin.inscription.completed',
  attributes: {
    inscriptionId: result.inscriptionId,
    satoshi: result.satoshi,
    txid: result.txid,
    actualFee: result.feeRate
  }
});
```

**Logged Events:**
- Inscription started/completed/failed
- Fee estimation
- Transaction broadcasting
- Transaction confirmation
- Transfer operations
- Front-running checks

---

## Performance Considerations

### 1. Transaction Confirmation Times

**Reality Check:**
- **Bitcoin Block Time:** ~10 minutes average
- **Mempool Variability:** 1 minute to 24+ hours during congestion
- **Confirmation Target:** 1-6 confirmations (10-60 minutes)

**Implications for SDK:**
- `inscribeData()` is inherently slow (10+ minutes for 1 confirmation)
- `monitorTransaction()` polls for 30 minutes default
- Users must design applications with async confirmation in mind

**Best Practices:**
```typescript
// ❌ BAD: Blocking UI on inscription
const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');
// User waits 10+ minutes...

// ✅ GOOD: Async with progress updates
const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');
console.log('Inscription broadcast:', inscription.txid);

// Monitor in background
sdk.bitcoin.monitorTransaction(inscription.txid).then(status => {
  console.log('Confirmed in block', status.blockHeight);
  // Update UI, notify user
});
```

---

### 2. Fee Estimation Strategy

**Challenge:** Bitcoin fee market volatile (1-500 sat/vB range).

**SDK Fee Resolution Cascade:**
```
1. FeeOracleAdapter.estimateFeeRate()   ← Preferred (real-time mempool data)
       ↓ (if unavailable)
2. OrdinalsProvider.estimateFee()       ← Fallback (provider's estimate)
       ↓ (if unavailable)
3. User-provided feeRate parameter      ← Last resort
       ↓ (if unavailable)
4. undefined (provider uses default)     ← Provider decides
```

**Performance Optimization:**
```typescript
// Cache fee estimates (30-second TTL)
private feeCache: { rate: number; timestamp: number } | null = null;

async resolveFeeRate(targetBlocks: number): Promise<number> {
  const now = Date.now();
  if (this.feeCache && now - this.feeCache.timestamp < 30000) {
    return this.feeCache.rate; // Use cached value
  }
  
  const rate = await this.fetchFeeRate(targetBlocks);
  this.feeCache = { rate, timestamp: now };
  return rate;
}
```

**User Control:**
```typescript
// Override fee for time-sensitive operations
await sdk.bitcoin.inscribeData(data, 'application/json', 50); // 50 sat/vB (high priority)

// Let SDK optimize for cost
await sdk.bitcoin.inscribeData(data, 'application/json'); // SDK estimates optimal rate
```

---

### 3. Batch Inscription Optimization

**Problem:** Inscribing 100 assets individually = 100 commit tx + 100 reveal tx = high fees

**Solution:** Batch commit with individual reveals (already implemented in LifecycleManager)

**Cost Comparison:**
| Method | Commit TX | Reveal TX | Total TX | Cost (10 sat/vB) |
|--------|-----------|-----------|----------|------------------|
| Individual | 100 | 100 | 200 | $200-500 |
| Batch | 1 | 100 | 101 | $140-350 (30% savings) |

**Implementation Detail:**
- `LifecycleManager.batchInscribeOnBitcoin()` already optimizes batches
- BitcoinManager supports single-inscription and batch-inscription flows
- No additional API changes needed (optimization is transparent)

**Example:**
```typescript
// Efficient batch inscription
const assets = [ /* 100 assets */ ];

const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
  singleTransaction: true,  // Enable batch optimization
  feeRate: 10
});

console.log(`Inscribed ${assets.length} assets`);
console.log(`Savings: $${result.costSavings.amount} (${result.costSavings.percentage}%)`);
```

---

### 4. UTXO Selection Performance

**Challenge:** Selecting optimal UTXOs from large UTXO sets (1000+ UTXOs).

**Current Implementation:**
- Basic UTXO selection in BitcoinManager
- Delegates to OrdinalsProvider for actual selection

**Future Enhancement (Out of Scope for This PRD):**
- Resource-aware UTXO selection (protect inscription UTXOs)
- Coin selection algorithms (minimize change, minimize inputs)
- See `prd-port-bitcoin-transaction-infrastructure.md` for details

**Performance Target:**
- UTXO selection: <1 second for 100 UTXOs
- Transaction construction: <2 seconds

---

### 5. Provider Performance Variability

**Reality:** OrdinalsProvider response times vary wildly:
- Local node: 10-100ms
- Public API (mempool.space): 200-2000ms
- Congested network: 5-30 seconds

**SDK Strategy:**
- Timeout all provider calls (default: 30 seconds)
- Emit telemetry warnings for slow providers
- Allow users to configure timeout per operation

**Configuration:**
```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    timeout: 60000 // 60 seconds for slow nodes
  })
});
```

---

## Integration with SDK Lifecycle Events

### Event Flow: Asset Inscription

```
User: lifecycle.inscribeOnBitcoin(asset, feeRate)
              ↓
Event: 'asset:migrated' (from=did:peer, to=did:btco) ← LifecycleManager
              ↓
BitcoinManager: inscribeData(manifest, 'application/json', feeRate)
              ↓
Telemetry: 'bitcoin.inscription.started'
              ↓
Provider: createInscription() [commit + reveal]
              ↓
Telemetry: 'bitcoin.inscription.completed'
              ↓
Return: OrdinalsInscription
              ↓
LifecycleManager: asset.migrate('did:btco', metadata)
              ↓
Event: 'asset:migrated' with Bitcoin metadata
```

### Subscribing to Bitcoin Events

```typescript
// Subscribe to inscription events
sdk.lifecycle.on('asset:migrated', (event) => {
  if (event.asset.toLayer === 'did:btco') {
    console.log('Asset inscribed to Bitcoin!');
    console.log('Transaction:', event.details.transactionId);
    console.log('Inscription:', event.details.inscriptionId);
    console.log('Satoshi:', event.details.satoshi);
    console.log('Fee rate:', event.details.feeRate);
  }
});

// Subscribe to batch inscription events
sdk.lifecycle.on('batch:completed', (event) => {
  if (event.operation === 'inscribe') {
    console.log('Batch inscription complete!');
    console.log('Successful:', event.results.successful);
    console.log('Failed:', event.results.failed);
    console.log('Cost savings:', event.results.costSavings);
  }
});
```

### Event Schema for Bitcoin Operations

**Asset Migrated to Bitcoin:**
```typescript
{
  type: 'asset:migrated',
  timestamp: '2025-10-16T12:34:56.789Z',
  asset: {
    id: 'did:peer:abc123',
    fromLayer: 'did:webvh',
    toLayer: 'did:btco'
  },
  details: {
    transactionId: 'reveal-tx-id',
    inscriptionId: 'abc123i0',
    satoshi: '1234567890',
    commitTxId: 'commit-tx-id',
    revealTxId: 'reveal-tx-id',
    feeRate: 15
  }
}
```

**Batch Inscription Complete:**
```typescript
{
  type: 'batch:completed',
  timestamp: '2025-10-16T12:45:00.000Z',
  batchId: 'batch-xyz789',
  operation: 'inscribe',
  results: {
    successful: 95,
    failed: 5,
    totalDuration: 180000, // 3 minutes
    costSavings: {
      amount: 12500,  // satoshis saved
      percentage: 32  // 32% savings
    }
  }
}
```

**Transaction Monitoring (NEW):**
```typescript
{
  type: 'transaction:confirmed',
  timestamp: '2025-10-16T12:44:00.000Z',
  txid: '4a5e1e4baab...',
  confirmations: 1,
  blockHeight: 850000,
  blockHash: '00000000000000000002...'
}
```

---

## Testing Strategy

### Unit Tests (Target: 95%+ Coverage)

**Test Categories:**

1. **Input Validation Tests**
   - ✅ inscribeData validates data not null/undefined
   - ✅ inscribeData validates contentType is valid MIME
   - ✅ inscribeData validates feeRate is positive number
   - ✅ verifyAnchor validates txId is 64-char hex
   - ✅ transferInscription validates Bitcoin address format
   - ✅ All methods reject invalid inputs with StructuredError

2. **Fee Resolution Tests**
   - ✅ resolveFeeRate prefers FeeOracle over provider
   - ✅ resolveFeeRate falls back to provider estimate
   - ✅ resolveFeeRate falls back to user-provided rate
   - ✅ resolveFeeRate handles oracle/provider failures gracefully

3. **Provider Integration Tests (Mocked)**
   - ✅ inscribeData calls provider.createInscription with correct params
   - ✅ inscribeData returns complete OrdinalsInscription
   - ✅ inscribeData handles provider errors (network, invalid response)
   - ✅ transferInscription calls provider.transferInscription
   - ✅ trackInscription calls provider.getInscriptionById

4. **Front-Running Protection Tests**
   - ✅ preventFrontRunning returns true for satoshi with 0 inscriptions
   - ✅ preventFrontRunning returns true for satoshi with 1 inscription
   - ✅ preventFrontRunning returns false for satoshi with 2+ inscriptions

5. **DID Validation Tests**
   - ✅ validateBTCODID accepts valid mainnet DIDs (did:btco:123456789)
   - ✅ validateBTCODID accepts valid testnet DIDs (did:btco:test:123456789)
   - ✅ validateBTCODID accepts valid signet DIDs (did:btco:sig:123456789)
   - ✅ validateBTCODID rejects invalid network prefixes
   - ✅ validateBTCODID rejects invalid satoshi numbers

6. **Error Handling Tests**
   - ✅ ORD_PROVIDER_REQUIRED thrown when provider missing
   - ✅ ORD_PROVIDER_UNSUPPORTED thrown when provider lacks method
   - ✅ INVALID_SATOSHI thrown when provider returns invalid satoshi
   - ✅ All errors have actionable messages

7. **Telemetry Tests**
   - ✅ inscribeData emits telemetry events (started, completed, error)
   - ✅ Fee estimation emits telemetry events
   - ✅ Telemetry includes relevant attributes (feeRate, network, etc.)

---

### Integration Tests (Bitcoin Network)

**Test Environment: Signet (Testnet)**

1. **End-to-End Inscription Test**
   ```typescript
   test('inscribe asset on signet', async () => {
     const sdk = OriginalsSDK.create({
       network: 'signet',
       ordinalsProvider: new OrdinalsClient({ network: 'signet', ... })
     });
     
     const manifest = Buffer.from(JSON.stringify({
       assetId: 'test-asset-123',
       resources: [{ id: 'img1', hash: 'abc...', contentType: 'image/png' }]
     }));
     
     const inscription = await sdk.bitcoin.inscribeData(manifest, 'application/json');
     
     expect(inscription.inscriptionId).toBeTruthy();
     expect(inscription.satoshi).toMatch(/^\d+$/);
     expect(inscription.txid).toMatch(/^[0-9a-f]{64}$/);
   });
   ```

2. **Transaction Monitoring Test**
   ```typescript
   test('monitor transaction confirmation', async () => {
     const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');
     
     const status = await sdk.bitcoin.monitorTransaction(inscription.txid);
     
     expect(status.confirmed).toBe(true);
     expect(status.confirmations).toBeGreaterThanOrEqual(1);
     expect(status.blockHeight).toBeGreaterThan(0);
   });
   ```

3. **Anchor Verification Test**
   ```typescript
   test('verify anchor on-chain', async () => {
     const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');
     await sdk.bitcoin.monitorTransaction(inscription.txid);
     
     const verified = await sdk.bitcoin.verifyAnchor('test-asset-123', inscription.txid);
     
     expect(verified).toBe(true);
   });
   ```

4. **Transfer Test**
   ```typescript
   test('transfer inscription ownership', async () => {
     const inscription = await sdk.bitcoin.inscribeData(data, 'application/json');
     await sdk.bitcoin.monitorTransaction(inscription.txid);
     
     const recipientAddress = 'tb1q...'; // Signet address
     const transferTx = await sdk.bitcoin.transferInscription(inscription, recipientAddress);
     
     expect(transferTx.txid).toBeTruthy();
     expect(transferTx.vout[0].address).toBe(recipientAddress);
   });
   ```

5. **Batch Inscription Test**
   ```typescript
   test('batch inscribe assets with cost savings', async () => {
     const assets = await Promise.all([
       sdk.lifecycle.createAsset([resource1]),
       sdk.lifecycle.createAsset([resource2]),
       sdk.lifecycle.createAsset([resource3])
     ]);
     
     const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
       singleTransaction: true
     });
     
     expect(result.successful.length).toBe(3);
     expect(result.failed.length).toBe(0);
     expect(result.costSavings.percentage).toBeGreaterThan(25); // 25%+ savings
   });
   ```

---

### Manual Testing Requirements

**Mainnet Validation (Before Production Release):**

1. **Small Test Inscription**
   - Inscribe minimal data (text/plain, <100 bytes)
   - Estimated cost: $5-20 depending on fees
   - Verify in Ordinals explorers:
     - https://ordinals.com/inscription/{inscriptionId}
     - https://ordiscan.com/inscription/{inscriptionId}

2. **Fee Estimation Accuracy**
   - Compare SDK fee estimates vs actual network fees
   - Ensure inscriptions confirm within target time
   - Validate no fee overpayment (>20% above market rate)

3. **Transfer Validation**
   - Transfer test inscription to different address
   - Verify ownership change in explorers
   - Confirm UTXO selection doesn't destroy inscription

4. **Error Handling**
   - Test with invalid provider configuration
   - Test with insufficient wallet balance
   - Test with network timeouts
   - Ensure graceful error messages

---

### Performance Benchmarks

| Operation | Target | Measured |
|-----------|--------|----------|
| inscribeData() | <5s to broadcast | TBD |
| verifyAnchor() | <2s | TBD |
| getAnchorHistory() | <3s for 10 anchors | TBD |
| monitorTransaction() | 10-30 mins (depends on Bitcoin) | TBD |
| Fee estimation | <500ms | TBD |

---

## Acceptance Criteria

This feature is **DONE** when:

### Functional Completeness
- ✅ **AC-1:** `inscribeData()` successfully inscribes asset manifest to Bitcoin signet
- ✅ **AC-2:** `inscribeData()` successfully inscribes asset manifest to Bitcoin mainnet
- ✅ **AC-3:** `verifyAnchor()` correctly verifies on-chain inscriptions against expected data
- ✅ **AC-4:** `getAnchorHistory()` retrieves complete history of asset anchors
- ✅ **AC-5:** `broadcastTransaction()` broadcasts signed transactions with retry logic
- ✅ **AC-6:** `monitorTransaction()` polls transaction status until confirmation
- ✅ **AC-7:** `transferInscription()` transfers inscription ownership without destroying it
- ✅ **AC-8:** `preventFrontRunning()` detects multi-inscription satoshis

### Integration
- ✅ **AC-9:** `LifecycleManager.inscribeOnBitcoin()` successfully uses BitcoinManager
- ✅ **AC-10:** `LifecycleManager.batchInscribeOnBitcoin()` leverages batch optimization
- ✅ **AC-11:** Events emitted for all Bitcoin operations (`asset:migrated`, `batch:completed`)
- ✅ **AC-12:** Telemetry logged for all Bitcoin operations (started, completed, errors)

### Testing
- ✅ **AC-13:** Unit tests achieve 95%+ coverage for BitcoinManager
- ✅ **AC-14:** Integration tests pass for all critical paths (inscribe, verify, transfer)
- ✅ **AC-15:** At least 5 successful test inscriptions on signet
- ✅ **AC-16:** At least 1 successful test inscription on mainnet
- ✅ **AC-17:** No regression in existing SDK functionality

### Security & Reliability
- ✅ **AC-18:** Private keys never stored in BitcoinManager
- ✅ **AC-19:** Network mismatch prevention (testnet vs mainnet)
- ✅ **AC-20:** All inputs validated with StructuredError on failure
- ✅ **AC-21:** Front-running protection prevents accidental multi-inscription
- ✅ **AC-22:** Bitcoin address validation prevents invalid transfers

### Documentation
- ✅ **AC-23:** All public methods have comprehensive JSDoc comments
- ✅ **AC-24:** API documentation covers all parameters, return types, errors
- ✅ **AC-25:** Usage examples provided for common scenarios
- ✅ **AC-26:** Architecture diagram explains component relationships

### Performance
- ✅ **AC-27:** Fee estimation completes in <1 second
- ✅ **AC-28:** Anchor verification completes in <3 seconds
- ✅ **AC-29:** Batch inscriptions demonstrate 25%+ cost savings
- ✅ **AC-30:** Transaction monitoring doesn't block application execution

---

## Dependencies

### External Libraries (Already Available)

✅ **@scure/btc-signer** - Bitcoin transaction signing  
- Version: ^1.8.0
- Purpose: PSBT construction, Taproot support
- Used by: OrdinalsProvider implementations

✅ **@scure/base** - Base encoding/decoding  
- Version: ^1.1.6
- Purpose: Base58, Base64, hex encoding
- Used by: Address encoding, data serialization

✅ **@noble/secp256k1** - Elliptic curve cryptography  
- Version: ^2.0.0
- Purpose: Bitcoin signature verification
- Used by: Transaction verification

✅ **@noble/hashes** - Cryptographic hashing  
- Version: ^2.0.1
- Purpose: SHA-256, RIPEMD-160
- Used by: Address generation, content hashing

✅ **bitcoinjs-lib** - Bitcoin protocol library  
- Version: ^6.1.0
- Purpose: Transaction construction, address validation
- Used by: PSBTBuilder, address utilities

✅ **micro-ordinals** - Ordinals inscription library  
- Version: ^0.2.2 (in legacy codebase)
- Purpose: Ordinals-specific operations
- Status: May need to add to SDK dependencies

---

### Provider Implementations

**Required for Production:**
- `OrdHttpProvider` - HTTP client for Ord API (exists in SDK)
- User's own Bitcoin node integration (custom provider)

**Available for Testing:**
- `OrdMockProvider` - Mock provider for unit tests (exists in SDK)

---

### Network Infrastructure

**Mainnet:**
- Bitcoin node or API access (e.g., mempool.space, blockstream.info)
- Ord node for inscription queries (optional, depends on provider)

**Signet:**
- Signet node or API access
- Signet faucet for test BTC (https://signetfaucet.com)

**Testnet (Optional):**
- Testnet node or API access
- Testnet faucet

---

### SDK Internal Dependencies

**Required Modules:**
- `LifecycleManager` - Orchestrates asset lifecycle
- `EventEmitter` - Event system for lifecycle events
- `StructuredError` - Error handling
- `Telemetry` - Logging and monitoring
- `PSBTBuilder` - PSBT construction (if exists)

**Type Definitions:**
- `src/types/bitcoin.ts` - Bitcoin-specific types
- `src/types/common.ts` - SDK configuration
- `src/adapters/types.ts` - Adapter interfaces

---

## Error Handling

### Error Categories

**1. Input Validation Errors**
```typescript
// INVALID_INPUT
throw new StructuredError('INVALID_INPUT', 'Data to inscribe cannot be null or undefined');
throw new StructuredError('INVALID_INPUT', 'Content type must be a non-empty string');
throw new StructuredError('INVALID_INPUT', `Invalid MIME type format: ${contentType}`);
throw new StructuredError('INVALID_INPUT', 'Fee rate must be a positive number');
throw new StructuredError('INVALID_INPUT', 'Invalid Bitcoin address for ownership transfer: ...');
```

**2. Configuration Errors**
```typescript
// ORD_PROVIDER_REQUIRED
throw new StructuredError(
  'ORD_PROVIDER_REQUIRED',
  'Ordinals provider must be configured to inscribe data on Bitcoin. ' +
  'Please provide an ordinalsProvider in your SDK configuration. ' +
  'For testing, use: import { OrdMockProvider } from \'@originals/sdk\';'
);

// ORD_PROVIDER_UNSUPPORTED
throw new StructuredError(
  'ORD_PROVIDER_UNSUPPORTED',
  'Configured ordinals provider does not support inscription creation'
);

// NETWORK_MISMATCH
throw new StructuredError(
  'NETWORK_MISMATCH',
  'Provider network (testnet) does not match SDK configuration (mainnet)'
);
```

**3. Provider Errors**
```typescript
// ORD_PROVIDER_INVALID_RESPONSE
throw new StructuredError(
  'ORD_PROVIDER_INVALID_RESPONSE',
  'Ordinals provider did not return a valid inscription identifier or transaction id'
);

// INVALID_SATOSHI
throw new StructuredError(
  'INVALID_SATOSHI',
  `Ordinals provider returned invalid satoshi identifier: ${validation.error}`
);
```

**4. Transaction Errors**
```typescript
// TX_BROADCAST_FAILED
throw new StructuredError(
  'TX_BROADCAST_FAILED',
  'Failed to broadcast transaction after 3 attempts: Network timeout'
);

// TX_CONFIRMATION_TIMEOUT
throw new StructuredError(
  'TX_CONFIRMATION_TIMEOUT',
  'Transaction did not confirm within 30 minutes'
);
```

**5. Security Errors**
```typescript
// INVALID_ADDRESS
throw new StructuredError(
  'INVALID_ADDRESS',
  'Invalid Bitcoin address: checksum verification failed'
);

// FRONT_RUN_RISK
throw new StructuredError(
  'FRONT_RUN_RISK',
  'Satoshi already has multiple inscriptions - front-running detected'
);
```

---

### Error Response Format

```typescript
try {
  await sdk.bitcoin.inscribeData(data, contentType, feeRate);
} catch (error) {
  if (error instanceof StructuredError) {
    console.error('Error code:', error.code);
    console.error('Message:', error.message);
    console.error('Context:', error.context);
    
    // Take action based on error code
    switch (error.code) {
      case 'ORD_PROVIDER_REQUIRED':
        // Configure provider
        break;
      case 'INVALID_INPUT':
        // Fix input validation
        break;
      case 'TX_BROADCAST_FAILED':
        // Retry later or increase fee
        break;
    }
  }
}
```

---

### Mitigation Strategies

| Error Code | Mitigation |
|------------|------------|
| `INVALID_INPUT` | Validate inputs before calling SDK methods |
| `ORD_PROVIDER_REQUIRED` | Configure ordinalsProvider in SDK config |
| `ORD_PROVIDER_UNSUPPORTED` | Use provider with required capabilities |
| `ORD_PROVIDER_INVALID_RESPONSE` | Report bug to provider maintainer |
| `INVALID_SATOSHI` | Report bug to provider maintainer |
| `TX_BROADCAST_FAILED` | Retry with higher fee or later |
| `TX_CONFIRMATION_TIMEOUT` | Check mempool, may need to RBF (replace-by-fee) |
| `INVALID_ADDRESS` | Use valid Bitcoin address for network |
| `FRONT_RUN_RISK` | Choose different satoshi or accept risk |
| `NETWORK_MISMATCH` | Ensure provider network matches SDK config |

---

## Migration Path

### For Existing SDK Users

**Current State:**
- BitcoinManager already exists with basic functionality
- `inscribeData()`, `transferInscription()`, `trackInscription()` working
- Used by `LifecycleManager.inscribeOnBitcoin()`

**New Features (Additive, Non-Breaking):**
- `verifyAnchor()` - NEW method
- `getAnchorHistory()` - NEW method
- `broadcastTransaction()` - NEW method
- `monitorTransaction()` - NEW method

**Breaking Changes:**
- **NONE** - All existing APIs remain unchanged

---

### Adoption Strategy

**Phase 1: Existing Functionality (Already Deployed)**
- Users currently using `inscribeData()` continue working unchanged
- No migration required

**Phase 2: New Methods (Additive)**
- Users opt-in to new methods (`verifyAnchor()`, `monitorTransaction()`, etc.)
- No disruption to existing applications

**Phase 3: Enhanced Providers (Optional)**
- Users upgrade to providers supporting new features (e.g., `getTransactionStatus()`)
- Legacy providers continue working with reduced functionality

---

### Backward Compatibility Guarantees

✅ **Guaranteed:**
- Existing method signatures unchanged
- Existing return types unchanged
- Existing error codes unchanged
- Existing behavior unchanged

❌ **Not Guaranteed:**
- Internal implementation details may change
- Provider adapter interface may extend (additive only)
- Telemetry event attributes may change

---

## Open Questions

### Engineering Questions

**Q1:** Should `monitorTransaction()` be blocking (await until confirmed) or non-blocking (return promise that resolves later)?
- **Recommendation:** Non-blocking with event emission
- **Rationale:** Bitcoin confirmations take 10+ minutes, blocking would freeze applications

**Q2:** What should `getAnchorHistory()` return if no anchors exist?
- **Option A:** Empty array `[]`
- **Option B:** `null`
- **Recommendation:** Empty array (consistent with array return type)

**Q3:** Should `verifyAnchor()` require minimum confirmations (e.g., 6) before returning `true`?
- **Recommendation:** Yes, make confirmations configurable (default: 1)
- **Rationale:** 1 confirmation sufficient for most use cases, but security-critical apps may want 6+

**Q4:** How should `broadcastTransaction()` handle RBF (Replace-By-Fee) scenarios?
- **Recommendation:** Detect RBF conflict, return specific error code
- **Out of scope:** Automatic RBF handling (user's responsibility)

**Q5:** Should `getAnchorHistory()` support pagination for assets with 1000+ anchors?
- **Recommendation:** Yes, add optional `offset` and `limit` parameters
- **Default:** Return all anchors (for simplicity)

---

### Product Questions

**Q6:** What's the priority order for new methods?
- **Must Have:** `verifyAnchor()` (critical for trust)
- **Should Have:** `monitorTransaction()` (UX improvement)
- **Nice to Have:** `getAnchorHistory()` (advanced use case)
- **Can Defer:** `broadcastTransaction()` (low-level utility)

**Q7:** Should we support transaction batching beyond existing `batchInscribeOnBitcoin()`?
- **Recommendation:** No, existing batch support sufficient
- **Rationale:** Batch inscription already optimized in LifecycleManager

**Q8:** What's the testing budget for mainnet validation?
- **Recommendation:** $100-200 for 3-5 test inscriptions
- **Purpose:** Validate mainnet operations before production release

---

### Risk Questions

**Q9:** What's the fallback if OrdinalsProvider fails during inscription?
- **Mitigation:** Users must handle provider failures at application level
- **SDK provides:** Clear error codes and retry guidance

**Q10:** How do we prevent users from accidentally inscribing to mainnet during testing?
- **Mitigation:** Explicit network configuration required
- **SDK validates:** Network matches provider's network

---

## Risk Assessment

### Critical Risks 🔴

**Risk 1: Inscription Data Loss (Provider Failure)**
- **Probability:** Low (providers generally reliable)
- **Impact:** CRITICAL (permanent data loss, funds wasted)
- **Mitigation:**
  - Use battle-tested providers (OrdHttpProvider)
  - Test extensively on signet before mainnet
  - Provide clear error codes for debugging
  - Document recommended providers

**Risk 2: Front-Running Vulnerability**
- **Probability:** Medium (for rare satoshi targeting)
- **Impact:** High (asset claim invalidated)
- **Mitigation:**
  - `preventFrontRunning()` check before inscription
  - Warn users about race conditions
  - Recommend users avoid targeting specific satoshis

**Risk 3: Fee Volatility (Cost Explosion)**
- **Probability:** Medium (Bitcoin fee market volatile)
- **Impact:** High (user inscriptions fail due to cost)
- **Mitigation:**
  - FeeOracle integration for real-time estimates
  - Allow user to set max fee budget
  - Batch inscriptions for cost optimization
  - Warn users before high-fee periods

---

### High Risks 🟡

**Risk 4: Network Congestion (Confirmation Delays)**
- **Probability:** Medium (happens during bull markets)
- **Impact:** Medium (UX degradation, not data loss)
- **Mitigation:**
  - Set realistic confirmation timeout (30 minutes default)
  - Allow users to bump fees (RBF) if stuck
  - Document expected confirmation times

**Risk 5: Provider API Changes**
- **Probability:** Low (APIs generally stable)
- **Impact:** Medium (requires SDK updates)
- **Mitigation:**
  - Adapter pattern isolates provider logic
  - Version provider implementations
  - Test against multiple providers

---

### Medium Risks 🟢

**Risk 6: Type Safety Issues**
- **Probability:** Low (TypeScript prevents most issues)
- **Impact:** Low (caught in testing)
- **Mitigation:**
  - Strict TypeScript mode
  - Comprehensive unit tests
  - Integration tests with real providers

**Risk 7: Documentation Gaps**
- **Probability:** Medium (common in complex systems)
- **Impact:** Low (user confusion, not data loss)
- **Mitigation:**
  - JSDoc for all public methods
  - Usage examples for common scenarios
  - Troubleshooting guide

---

## Resources

### Bitcoin & Ordinals Documentation

**Ordinals Protocol:**
- Ordinals Theory: https://docs.ordinals.com/
- Ordinals GitHub: https://github.com/ordinals/ord

**Bitcoin Improvement Proposals (BIPs):**
- BIP-340 (Schnorr Signatures): https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
- BIP-341 (Taproot): https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki
- BIP-342 (Tapscript): https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki

**Bitcoin Core:**
- Developer Guide: https://developer.bitcoin.org/devguide/
- Transaction Format: https://developer.bitcoin.org/reference/transactions.html

---

### Existing SDK Code

**BitcoinManager:**
- `src/bitcoin/BitcoinManager.ts` (326 lines) - Main implementation

**Types:**
- `src/types/bitcoin.ts` - Bitcoin-specific types
- `src/types/common.ts` - SDK configuration

**Adapters:**
- `src/adapters/providers/OrdMockProvider.ts` - Mock provider for testing
- `src/adapters/providers/OrdHttpProvider.ts` - HTTP provider for production

**Integration:**
- `src/lifecycle/LifecycleManager.ts` - Uses BitcoinManager for inscription
- `src/lifecycle/BatchOperations.ts` - Batch inscription logic

---

### Testing Resources

**Bitcoin Networks:**
- Signet Faucet: https://signetfaucet.com/
- Signet Explorer: https://mempool.space/signet
- Testnet Faucet: https://testnet-faucet.com/btc-testnet/

**Ordinals Explorers:**
- Mainnet: https://ordinals.com/
- Ordiscan: https://ordiscan.com/
- Signet: https://signet.ordinals.com/

---

### Related PRDs

**Dependency:**
- `prd-port-bitcoin-transaction-infrastructure.md` - Transaction building logic
  - Status: In Progress
  - Relationship: BitcoinManager depends on transaction infrastructure

**Future Work:**
- Enhanced UTXO selection
- RBF (Replace-By-Fee) support
- Lightning Network integration
- Multi-sig support

---

## Timeline & Milestones

### Week 1: Core Methods Implementation

**Days 1-2: verifyAnchor()**
- [ ] Design verification algorithm
- [ ] Implement transaction fetching
- [ ] Implement inscription extraction
- [ ] Write unit tests
- [ ] Test on signet

**Days 3-4: getAnchorHistory()**
- [ ] Design history query strategy
- [ ] Implement pagination (optional)
- [ ] Write unit tests
- [ ] Test with mock data

**Day 5: broadcastTransaction()**
- [ ] Implement retry logic
- [ ] Add exponential backoff
- [ ] Write unit tests
- [ ] Document retry strategy

---

### Week 2: Monitoring & Testing

**Days 6-8: monitorTransaction()**
- [ ] Implement polling mechanism
- [ ] Add timeout handling
- [ ] Emit lifecycle events
- [ ] Write unit tests
- [ ] Test with real transactions

**Days 9-10: Integration Testing**
- [ ] Write end-to-end tests
- [ ] Test on signet (5+ inscriptions)
- [ ] Test batch inscriptions
- [ ] Performance benchmarking

---

### Week 3: Production Validation

**Days 11-12: Mainnet Testing**
- [ ] Small test inscription on mainnet
- [ ] Verify in explorers
- [ ] Test anchor verification
- [ ] Test transaction monitoring

**Days 13-14: Documentation & Polish**
- [ ] Complete JSDoc comments
- [ ] Write usage examples
- [ ] Update README
- [ ] Review error messages

**Day 15: Final Review**
- [ ] Code review
- [ ] Security review
- [ ] Performance review
- [ ] Acceptance criteria checklist

---

## Success Definition

**This PRD is SUCCESSFUL when:**

A developer can run this code and successfully verify a Bitcoin-anchored asset:

```typescript
import { OriginalsSDK } from '@originals/sdk';

// 1. Configure SDK
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.MAINNET_ORD_NODE_URL
  })
});

// 2. Create and inscribe asset
const asset = await sdk.lifecycle.createAsset([{
  id: 'my-artwork',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256-abc123...'
}]);

const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset);
console.log('Inscribed:', inscribed.id); // did:btco:123456789

// 3. Monitor confirmation
const status = await sdk.bitcoin.monitorTransaction(
  inscribed.getProvenance().migrations[0].transactionId
);
console.log('Confirmed in block:', status.blockHeight);

// 4. Verify anchor (anytime in future)
const verified = await sdk.bitcoin.verifyAnchor(
  asset.id,
  inscribed.getProvenance().migrations[0].transactionId
);
console.log('Verified:', verified); // true

// 5. Get anchor history
const history = await sdk.bitcoin.getAnchorHistory(asset.id);
console.log('Anchors:', history.length);
history.forEach(record => {
  console.log(`- Block ${record.blockHeight}: ${record.inscriptionId}`);
});
```

**And all of the following are true:**
- ✅ Asset verifiable on Bitcoin blockchain
- ✅ Inscription visible in Ordinals explorers
- ✅ No funds lost
- ✅ No inscriptions destroyed
- ✅ Confirmation times reasonable (<30 mins)

---

**END OF PRD**

*Next Steps: Review with engineering team, prioritize implementation, begin Week 1 tasks.*

