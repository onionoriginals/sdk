# Bitcoin Operations Best Practices

Security guidelines, optimization strategies, and production recommendations for Bitcoin operations in the Originals SDK.

## Table of Contents

- [Security Best Practices](#security-best-practices)
- [External Signer Integration](#external-signer-integration)
- [Key Management](#key-management)
- [Transaction Security](#transaction-security)
- [UTXO Management](#utxo-management)
- [Fee Optimization](#fee-optimization)
- [Error Handling](#error-handling)
- [Testing Strategies](#testing-strategies)
- [Production Deployment](#production-deployment)
- [Compliance and Auditing](#compliance-and-auditing)

## Security Best Practices

### Never Expose Private Keys

**NEVER:**
```typescript
// ❌ NEVER hardcode private keys
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: 'https://api.example.com',
    walletPrivateKey: 'L1234567890abcdef...' // NEVER DO THIS
  })
});

// ❌ NEVER commit keys to version control
// ❌ NEVER log private keys
console.log('Private key:', privateKey);

// ❌ NEVER send private keys over network
fetch('https://api.example.com/sign', {
  body: JSON.stringify({ privateKey })
});
```

**ALWAYS:**
```typescript
// ✅ Use environment variables
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL!,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY!
  })
});

// ✅ Use .env files (and add to .gitignore)
// .env
BITCOIN_PRIVATE_KEY=L1234567890abcdef...

// .gitignore
.env
.env.local
.env.*.local
*.key
*.pem
```

**BEST: Use External Signers**
```typescript
// ✅ Keys never leave secure environment
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL!,
    // No private key - uses external signer instead
  }),
  externalSigner: new PrivySigner(privyClient, userId, walletId)
});
```

---

### Validate All Inputs

```typescript
// Validate addresses
function validateRecipient(address: string, network: BitcoinNetwork): void {
  if (!address) {
    throw new Error('Recipient address is required');
  }

  if (!sdk.bitcoin.validateBitcoinAddress(address, network)) {
    throw new Error(`Invalid ${network} Bitcoin address: ${address}`);
  }
}

// Validate amounts
function validateAmount(amount: number, available: number): void {
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }

  if (amount > available) {
    throw new Error(`Insufficient funds: ${amount} > ${available}`);
  }

  const MIN_AMOUNT = 546; // Dust limit
  if (amount < MIN_AMOUNT) {
    throw new Error(`Amount below dust limit: ${amount} < ${MIN_AMOUNT}`);
  }
}

// Validate content types
function validateContentType(contentType: string): void {
  const validContentTypes = [
    'text/plain',
    'text/html',
    'application/json',
    'image/png',
    'image/jpeg',
    'image/svg+xml',
    // ... etc
  ];

  if (!validContentTypes.includes(contentType)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
}

// Use in transactions
async function safeInscribe(data: any, contentType: string) {
  validateContentType(contentType);

  // Validate data size (inscriptions can be expensive)
  const dataSize = Buffer.byteLength(JSON.stringify(data));
  const MAX_SIZE = 400_000; // 400KB recommended limit

  if (dataSize > MAX_SIZE) {
    throw new Error(`Data too large: ${dataSize} > ${MAX_SIZE} bytes`);
  }

  return await sdk.bitcoin.inscribeData(data, contentType);
}
```

---

### Rate Limiting and DDoS Protection

```typescript
import pLimit from 'p-limit';
import rateLimit from 'express-rate-limit';

// Client-side rate limiting
const concurrencyLimit = pLimit(3);

async function rateLimitedInscribe(items: any[]) {
  return Promise.all(
    items.map(item =>
      concurrencyLimit(() =>
        sdk.bitcoin.inscribeData(item.data, item.contentType)
      )
    )
  );
}

// Server-side rate limiting (Express)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per window
  message: 'Too many requests from this IP'
});

app.use('/api/inscribe', apiLimiter);

// Per-user rate limiting
const userLimits = new Map<string, { count: number; resetAt: number }>();

function checkUserLimit(userId: string): boolean {
  const now = Date.now();
  const limit = userLimits.get(userId);

  if (!limit || now > limit.resetAt) {
    userLimits.set(userId, {
      count: 1,
      resetAt: now + 60000 // 1 minute window
    });
    return true;
  }

  if (limit.count >= 10) { // 10 requests per minute
    return false;
  }

  limit.count++;
  return true;
}
```

---

### Network Isolation

```typescript
// Separate configurations for different networks
const configs = {
  development: {
    network: 'regtest' as const,
    ordinalsProvider: new OrdMockProvider()
  },

  staging: {
    network: 'signet' as const,
    ordinalsProvider: new OrdinalsClient({
      network: 'signet',
      apiUrl: process.env.SIGNET_API_URL!,
      walletPrivateKey: process.env.SIGNET_PRIVATE_KEY!
    })
  },

  production: {
    network: 'mainnet' as const,
    ordinalsProvider: new OrdinalsClient({
      network: 'mainnet',
      apiUrl: process.env.MAINNET_API_URL!,
      walletPrivateKey: process.env.MAINNET_PRIVATE_KEY!
    })
  }
};

// Strict environment validation
const env = process.env.NODE_ENV;
if (!['development', 'staging', 'production'].includes(env)) {
  throw new Error(`Invalid NODE_ENV: ${env}`);
}

const config = configs[env];

// Prevent accidental mainnet operations in development
if (env !== 'production' && config.network === 'mainnet') {
  throw new Error('Mainnet operations not allowed in non-production environment');
}

const sdk = OriginalsSDK.create(config);
```

---

## External Signer Integration

### Why Use External Signers?

**Benefits:**
- **Security**: Private keys never leave secure hardware/environment
- **Compliance**: Meet SOC 2, ISO 27001, PCI DSS requirements
- **Auditing**: All signing operations are logged
- **Multi-party**: Support threshold signatures and MPC wallets
- **Rotation**: Seamless key rotation without code changes

**When to Use:**
- Production applications handling user funds
- Enterprise deployments
- Applications requiring compliance certifications
- Multi-signature wallets
- Hardware security module (HSM) integration

---

### Privy Integration

```typescript
import { PrivyClient } from '@privy-io/server-auth';

class PrivySigner implements ExternalSigner {
  private privyClient: PrivyClient;
  private userId: string;
  private walletId: string;
  private verificationMethodId: string;

  constructor(
    appId: string,
    appSecret: string,
    userId: string,
    walletId: string,
    verificationMethodId: string
  ) {
    this.privyClient = new PrivyClient(appId, appSecret);
    this.userId = userId;
    this.walletId = walletId;
    this.verificationMethodId = verificationMethodId;
  }

  async sign({ document, proof }): Promise<{ proofValue: string }> {
    try {
      // Sign using Privy's embedded wallet
      const signature = await this.privyClient.wallets.sign({
        userId: this.userId,
        walletId: this.walletId,
        message: JSON.stringify(document)
      });

      return { proofValue: signature };

    } catch (error) {
      console.error('Privy signing failed:', error);
      throw new Error(`External signer error: ${error.message}`);
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }
}

// Usage
const signer = new PrivySigner(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!,
  userId,
  walletId,
  verificationMethodId
);

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider,
  externalSigner: signer
});
```

---

### AWS KMS Integration

```typescript
import {
  KMSClient,
  SignCommand,
  GetPublicKeyCommand
} from '@aws-sdk/client-kms';

class AWSKMSSigner implements ExternalSigner {
  private kmsClient: KMSClient;
  private keyId: string;
  private verificationMethodId: string;

  constructor(keyId: string, verificationMethodId: string, region = 'us-east-1') {
    this.kmsClient = new KMSClient({ region });
    this.keyId = keyId;
    this.verificationMethodId = verificationMethodId;
  }

  async sign({ document, proof }): Promise<{ proofValue: string }> {
    try {
      const message = Buffer.from(JSON.stringify(document));

      const command = new SignCommand({
        KeyId: this.keyId,
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256'
      });

      const response = await this.kmsClient.send(command);

      if (!response.Signature) {
        throw new Error('No signature returned from KMS');
      }

      const signature = Buffer.from(response.Signature).toString('base64');

      return { proofValue: signature };

    } catch (error) {
      console.error('KMS signing failed:', error);
      throw new Error(`KMS signer error: ${error.message}`);
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  async getPublicKey(): Promise<Buffer> {
    const command = new GetPublicKeyCommand({ KeyId: this.keyId });
    const response = await this.kmsClient.send(command);

    if (!response.PublicKey) {
      throw new Error('No public key returned from KMS');
    }

    return Buffer.from(response.PublicKey);
  }
}

// Usage with proper IAM permissions
const signer = new AWSKMSSigner(
  process.env.AWS_KMS_KEY_ID!,
  verificationMethodId,
  process.env.AWS_REGION || 'us-east-1'
);

// Required IAM permissions:
// {
//   "Version": "2012-10-17",
//   "Statement": [
//     {
//       "Effect": "Allow",
//       "Action": [
//         "kms:Sign",
//         "kms:GetPublicKey",
//         "kms:DescribeKey"
//       ],
//       "Resource": "arn:aws:kms:region:account:key/key-id"
//     }
//   ]
// }
```

---

### Hardware Security Module (HSM)

```typescript
import { PKCS11Session } from 'pkcs11js';

class HSMSigner implements ExternalSigner {
  private session: PKCS11Session;
  private keyLabel: string;
  private verificationMethodId: string;

  constructor(
    hsmConfig: {
      libraryPath: string;
      slotId: number;
      pin: string;
    },
    keyLabel: string,
    verificationMethodId: string
  ) {
    this.session = this.initializeHSM(hsmConfig);
    this.keyLabel = keyLabel;
    this.verificationMethodId = verificationMethodId;
  }

  private initializeHSM(config: any): PKCS11Session {
    // Initialize PKCS#11 connection to HSM
    // Implementation depends on specific HSM vendor
    // Examples: Thales, Gemalto, AWS CloudHSM
    throw new Error('HSM initialization - implement for your HSM');
  }

  async sign({ document, proof }): Promise<{ proofValue: string }> {
    try {
      const message = Buffer.from(JSON.stringify(document));

      // Sign using HSM
      const signature = await this.session.sign({
        keyLabel: this.keyLabel,
        mechanism: 'CKM_ECDSA_SHA256',
        data: message
      });

      return {
        proofValue: Buffer.from(signature).toString('base64')
      };

    } catch (error) {
      console.error('HSM signing failed:', error);
      throw new Error(`HSM signer error: ${error.message}`);
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
```

---

### Multi-Party Computation (MPC)

```typescript
// Example with Fireblocks MPC
class FireblocksSigner implements ExternalSigner {
  private fireblocksClient: any; // Fireblocks SDK
  private vaultAccountId: string;
  private verificationMethodId: string;

  constructor(
    apiKey: string,
    privateKey: string,
    vaultAccountId: string,
    verificationMethodId: string
  ) {
    // Initialize Fireblocks client
    this.fireblocksClient = new FireblocksSDK(privateKey, apiKey);
    this.vaultAccountId = vaultAccountId;
    this.verificationMethodId = verificationMethodId;
  }

  async sign({ document, proof }): Promise<{ proofValue: string }> {
    const message = JSON.stringify(document);

    // Create signing transaction
    const transaction = await this.fireblocksClient.createTransaction({
      operation: 'RAW',
      source: {
        type: 'VAULT_ACCOUNT',
        id: this.vaultAccountId
      },
      note: 'Originals SDK signing',
      extraParameters: {
        rawMessageData: {
          messages: [{
            content: Buffer.from(message).toString('hex')
          }]
        }
      }
    });

    // Wait for MPC signing ceremony to complete
    const signedTx = await this.waitForCompletion(transaction.id);

    return {
      proofValue: signedTx.signedMessages[0].signature
    };
  }

  private async waitForCompletion(txId: string): Promise<any> {
    // Poll for transaction completion
    while (true) {
      const tx = await this.fireblocksClient.getTransactionById(txId);

      if (tx.status === 'COMPLETED') {
        return tx;
      }

      if (tx.status === 'FAILED' || tx.status === 'REJECTED') {
        throw new Error(`Transaction ${txId} ${tx.status}`);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }
}
```

---

## Key Management

### Key Generation

```typescript
import { generateKeyPair } from '@originals/sdk';

// Generate key pair securely
const keyPair = await generateKeyPair('Ed25519');

console.log('Public key:', keyPair.publicKeyMultibase);
// Store private key securely - NEVER log in production

// Secure storage examples:

// 1. Environment variable (development only)
process.env.PRIVATE_KEY = keyPair.privateKey;

// 2. Encrypted file (better)
import { encrypt } from './encryption';
import { writeFile } from 'fs/promises';

const encrypted = encrypt(keyPair.privateKey, masterPassword);
await writeFile('keys/encrypted.key', encrypted, { mode: 0o600 });

// 3. Secrets manager (production)
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManager({ region: 'us-east-1' });
await secretsManager.createSecret({
  Name: 'originals/bitcoin/private-key',
  SecretString: keyPair.privateKey,
  KmsKeyId: process.env.KMS_KEY_ID
});
```

---

### Key Rotation

```typescript
// Implement regular key rotation
class KeyRotationManager {
  private currentKey: string;
  private nextKey: string;
  private rotationSchedule: number = 90 * 24 * 60 * 60 * 1000; // 90 days

  async rotateKeys(): Promise<void> {
    // Generate new key pair
    const newKeyPair = await generateKeyPair('Ed25519');

    // Store new key as "next" key
    this.nextKey = newKeyPair.privateKey;

    // Update DID document to include new key
    await this.updateDIDDocument({
      addKeys: [newKeyPair.publicKeyMultibase],
      removeKeys: []
    });

    // Grace period: Both keys work
    await this.waitGracePeriod(7 * 24 * 60 * 60 * 1000); // 7 days

    // Promote next key to current
    this.currentKey = this.nextKey;

    // Remove old key from DID document
    await this.updateDIDDocument({
      addKeys: [],
      removeKeys: [this.getOldPublicKey()]
    });
  }

  private async waitGracePeriod(duration: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, duration));
  }

  private async updateDIDDocument(updates: any): Promise<void> {
    // Update DID document with new keys
    // Implementation depends on DID method
  }

  private getOldPublicKey(): string {
    // Return public key of old private key
    throw new Error('Not implemented');
  }
}
```

---

### Secure Key Storage

```typescript
// AWS Secrets Manager
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

class SecureKeyStorage {
  private secretsManager: SecretsManager;

  constructor(region = 'us-east-1') {
    this.secretsManager = new SecretsManager({ region });
  }

  async storeKey(keyId: string, privateKey: string): Promise<void> {
    await this.secretsManager.createSecret({
      Name: `originals/keys/${keyId}`,
      SecretString: privateKey,
      KmsKeyId: process.env.KMS_KEY_ID,
      Tags: [
        { Key: 'Purpose', Value: 'Bitcoin signing' },
        { Key: 'Rotation', Value: 'Enabled' }
      ]
    });
  }

  async getKey(keyId: string): Promise<string> {
    const response = await this.secretsManager.getSecretValue({
      SecretId: `originals/keys/${keyId}`
    });

    if (!response.SecretString) {
      throw new Error('Secret not found');
    }

    return response.SecretString;
  }

  async rotateKey(keyId: string, newPrivateKey: string): Promise<void> {
    await this.secretsManager.updateSecret({
      SecretId: `originals/keys/${keyId}`,
      SecretString: newPrivateKey
    });
  }

  async deleteKey(keyId: string): Promise<void> {
    await this.secretsManager.deleteSecret({
      SecretId: `originals/keys/${keyId}`,
      ForceDeleteWithoutRecovery: false,
      RecoveryWindowInDays: 30
    });
  }
}
```

---

## Transaction Security

### Address Verification

```typescript
// Always verify addresses before sending
async function verifyAndTransfer(
  inscription: OrdinalsInscription,
  recipientAddress: string,
  network: BitcoinNetwork
): Promise<BitcoinTransaction> {
  // 1. Validate address format
  if (!sdk.bitcoin.validateBitcoinAddress(recipientAddress, network)) {
    throw new Error('Invalid Bitcoin address');
  }

  // 2. Confirm address with user
  console.log('\nTransfer Confirmation:');
  console.log('  Inscription:', inscription.inscriptionId);
  console.log('  Recipient:', recipientAddress);
  console.log('  Network:', network);

  const confirmed = await askUserConfirmation('Proceed with transfer?');
  if (!confirmed) {
    throw new Error('Transfer cancelled by user');
  }

  // 3. Execute transfer
  return await sdk.bitcoin.transferInscription(inscription, recipientAddress);
}

// For high-value transfers, implement additional verification
async function verifyHighValueTransfer(
  amount: number,
  recipientAddress: string
): Promise<boolean> {
  const HIGH_VALUE_THRESHOLD = 1_000_000; // 0.01 BTC

  if (amount >= HIGH_VALUE_THRESHOLD) {
    // Require manual confirmation
    console.warn(`HIGH VALUE TRANSFER: ${amount} sats`);

    // Send confirmation email/SMS
    await sendConfirmationRequest(recipientAddress, amount);

    // Wait for approval
    const approved = await waitForApproval(60000); // 60 second timeout

    return approved;
  }

  return true;
}
```

---

### Transaction Monitoring

```typescript
class TransactionMonitor {
  private pendingTransactions = new Map<string, TransactionInfo>();

  async monitorTransaction(txid: string): Promise<void> {
    this.pendingTransactions.set(txid, {
      txid,
      startTime: Date.now(),
      confirmations: 0
    });

    // Poll for confirmations
    const interval = setInterval(async () => {
      try {
        const status = await sdk.bitcoin.getTransactionStatus(txid);

        if (status.confirmed) {
          console.log(`TX ${txid} confirmed in block ${status.blockHeight}`);
          this.pendingTransactions.delete(txid);
          clearInterval(interval);

          // Trigger confirmation callback
          await this.onConfirmation(txid, status);
        } else {
          // Check if stuck
          const elapsed = Date.now() - this.pendingTransactions.get(txid)!.startTime;
          if (elapsed > 24 * 60 * 60 * 1000) { // 24 hours
            console.warn(`TX ${txid} unconfirmed after 24 hours`);
            await this.onStuckTransaction(txid);
          }
        }
      } catch (error) {
        console.error(`Error monitoring TX ${txid}:`, error);
      }
    }, 60000); // Check every minute
  }

  private async onConfirmation(txid: string, status: any): Promise<void> {
    // Update database, notify user, etc.
    console.log('Transaction confirmed:', txid);
  }

  private async onStuckTransaction(txid: string): Promise<void> {
    // Alert administrators, potentially initiate RBF
    console.error('Transaction stuck:', txid);
  }
}
```

---

## UTXO Management

### Best Practices

```typescript
// 1. Always use resource-aware selection
import { selectResourceUtxos, tagResourceUtxos } from '@originals/sdk';

async function safeUtxoSelection(
  address: string,
  requiredAmount: number,
  feeRate: number
) {
  // Fetch UTXOs
  const utxos = await fetchUtxos(address);

  // Fetch and tag inscriptions
  const inscriptions = await fetchInscriptions(address);
  const resourceData = inscriptions.map(ins => ({
    utxo: { txid: ins.txid, vout: ins.vout },
    resourceType: 'inscription',
    resourceId: ins.inscriptionId
  }));

  const taggedUtxos = tagResourceUtxos(utxos, resourceData);

  // Select with resource awareness
  const result = selectResourceUtxos(taggedUtxos, {
    requiredAmount,
    feeRate,
    strategy: 'optimize_size',
    preference: 'oldest'
  });

  // Verify no resources spent
  const resourcesPreserved = result.resourceUtxos.length === inscriptions.length;
  if (!resourcesPreserved) {
    throw new Error('Resource UTXO count mismatch - unsafe');
  }

  return result;
}

// 2. Consolidate dust regularly
async function consolidateDust(address: string): Promise<void> {
  const utxos = await fetchUtxos(address);

  // Find dust UTXOs (< 10,000 sats)
  const dustUtxos = utxos.filter(u =>
    u.value < 10000 &&
    !u.locked &&
    (!u.inscriptions || u.inscriptions.length === 0)
  );

  if (dustUtxos.length < 10) {
    console.log('Not enough dust to consolidate');
    return;
  }

  console.log(`Consolidating ${dustUtxos.length} dust UTXOs`);

  // Combine dust into single UTXO
  const { tx } = buildTransferTransaction(
    dustUtxos,
    address, // Send to self
    dustUtxos.reduce((sum, u) => sum + u.value, 0),
    3 // Low fee for consolidation
  );

  // Broadcast during low-fee period
  await broadcastTransaction(tx);
}

// 3. Implement UTXO labeling
interface LabeledUtxo extends Utxo {
  label?: string;
  purpose?: 'inscription' | 'payment' | 'change' | 'reserve';
}

const utxoLabels = new Map<string, string>();

function labelUtxo(txid: string, vout: number, label: string): void {
  utxoLabels.set(`${txid}:${vout}`, label);
}

function getUtxoLabel(txid: string, vout: number): string | undefined {
  return utxoLabels.get(`${txid}:${vout}`);
}
```

---

## Fee Optimization

### Dynamic Fee Estimation

```typescript
class SmartFeeEstimator {
  private feeHistory: Array<{ timestamp: number; feeRate: number }> = [];

  async estimateOptimalFee(urgency: 'low' | 'medium' | 'high'): Promise<number> {
    // Fetch current mempool fees
    const response = await fetch('https://mempool.space/api/v1/fees/recommended');
    const fees = await response.json();

    // Select based on urgency
    let baseFee: number;
    switch (urgency) {
      case 'low':
        baseFee = fees.hourFee;
        break;
      case 'medium':
        baseFee = fees.halfHourFee;
        break;
      case 'high':
        baseFee = fees.fastestFee;
        break;
    }

    // Record fee history
    this.feeHistory.push({
      timestamp: Date.now(),
      feeRate: baseFee
    });

    // Keep last 100 entries
    if (this.feeHistory.length > 100) {
      this.feeHistory.shift();
    }

    // Adjust based on historical trends
    const trend = this.calculateTrend();
    const adjustedFee = Math.ceil(baseFee * (1 + trend));

    // Apply limits
    const MIN_FEE = 1.1; // Network minimum
    const MAX_FEE = 100; // Safety limit

    return Math.max(MIN_FEE, Math.min(MAX_FEE, adjustedFee));
  }

  private calculateTrend(): number {
    if (this.feeHistory.length < 10) return 0;

    const recent = this.feeHistory.slice(-10);
    const older = this.feeHistory.slice(-20, -10);

    const recentAvg = recent.reduce((sum, f) => sum + f.feeRate, 0) / recent.length;
    const olderAvg = older.reduce((sum, f) => sum + f.feeRate, 0) / older.length;

    // Return percentage change
    return (recentAvg - olderAvg) / olderAvg;
  }

  async recommendFeeForAmount(amount: number): Promise<number> {
    // High-value transactions: use high priority
    if (amount > 10_000_000) { // 0.1 BTC
      return this.estimateOptimalFee('high');
    }

    // Medium-value: medium priority
    if (amount > 1_000_000) { // 0.01 BTC
      return this.estimateOptimalFee('medium');
    }

    // Low-value: low priority
    return this.estimateOptimalFee('low');
  }
}
```

---

### Fee Bumping (RBF)

```typescript
// Replace-By-Fee for stuck transactions
async function bumpTransactionFee(
  originalTxid: string,
  newFeeRate: number
): Promise<BitcoinTransaction> {
  // Get original transaction
  const originalTx = await getTransaction(originalTxid);

  if (originalTx.confirmations > 0) {
    throw new Error('Transaction already confirmed');
  }

  // Rebuild with same inputs/outputs but higher fee
  const { tx: replacementTx } = buildTransferTransaction(
    originalTx.vin.map(input => ({
      txid: input.txid,
      vout: input.vout,
      value: input.value,
      // ... other UTXO fields
    })),
    originalTx.vout[0].address!, // Same recipient
    originalTx.vout[0].value,
    newFeeRate // Higher fee rate
  );

  // Broadcast replacement
  return await broadcastTransaction(replacementTx);
}
```

---

## Error Handling

### Comprehensive Error Handling

```typescript
import { StructuredError } from '@originals/sdk';

async function robustInscribe(
  data: any,
  contentType: string
): Promise<OrdinalsInscription> {
  const MAX_RETRIES = 3;
  let lastError: Error;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const inscription = await sdk.bitcoin.inscribeData(data, contentType);
      return inscription;

    } catch (error) {
      lastError = error;

      if (error instanceof StructuredError) {
        // Handle specific error codes
        switch (error.code) {
          case 'INSUFFICIENT_FUNDS':
            // Don't retry - fundamental issue
            throw error;

          case 'FEE_TOO_LOW':
            // Retry with higher fee
            console.log('Fee too low, increasing...');
            const higherFee = await estimateHigherFee();
            return sdk.bitcoin.inscribeData(data, contentType, higherFee);

          case 'NETWORK_ERROR':
            // Retry with exponential backoff
            const delay = 1000 * Math.pow(2, attempt - 1);
            console.log(`Network error, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;

          case 'INVALID_ADDRESS':
          case 'INVALID_CONTENT_TYPE':
            // Don't retry - invalid input
            throw error;

          default:
            // Unknown error - retry
            console.error(`Unknown error (attempt ${attempt}/${MAX_RETRIES}):`, error);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
        }
      } else {
        // Non-structured error - log and retry
        console.error(`Unexpected error (attempt ${attempt}/${MAX_RETRIES}):`, error);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // All retries failed
  throw new Error(`Failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}
```

---

### Error Logging and Monitoring

```typescript
class ErrorMonitor {
  async logError(error: Error, context: any): Promise<void> {
    const errorLog = {
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      },
      context,
      environment: process.env.NODE_ENV
    };

    // Log to file
    await this.logToFile(errorLog);

    // Send to monitoring service
    await this.sendToMonitoring(errorLog);

    // Alert on critical errors
    if (this.isCritical(error)) {
      await this.sendAlert(errorLog);
    }
  }

  private async logToFile(log: any): Promise<void> {
    // Append to error log file
    const fs = require('fs').promises;
    await fs.appendFile(
      'logs/errors.log',
      JSON.stringify(log) + '\n'
    );
  }

  private async sendToMonitoring(log: any): Promise<void> {
    // Send to Sentry, DataDog, etc.
    // Example with Sentry:
    // Sentry.captureException(log.error, { extra: log.context });
  }

  private async sendAlert(log: any): Promise<void> {
    // Send to PagerDuty, Slack, etc.
    console.error('CRITICAL ERROR:', log);
  }

  private isCritical(error: Error): boolean {
    const criticalCodes = [
      'INSUFFICIENT_FUNDS',
      'INVALID_SIGNATURE',
      'SECURITY_VIOLATION'
    ];

    return criticalCodes.includes((error as any).code);
  }
}
```

---

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
    expect(inscription.contentType).toBe('application/json');
  });

  it('should handle insufficient funds', async () => {
    // Mock insufficient funds scenario
    const mockProvider = sdk.bitcoin.ordinalsProvider as OrdMockProvider;
    mockProvider.setBalance(0);

    await expect(
      sdk.bitcoin.inscribeData('test', 'text/plain')
    ).rejects.toThrow('INSUFFICIENT_FUNDS');
  });
});
```

---

### Integration Testing

```typescript
describe('Bitcoin Integration Tests', () => {
  const sdk = OriginalsSDK.create({
    network: 'signet',
    ordinalsProvider: new OrdinalsClient({
      network: 'signet',
      apiUrl: process.env.SIGNET_API_URL!,
      walletPrivateKey: process.env.SIGNET_PRIVATE_KEY!
    })
  });

  it('should create and track inscription on signet', async () => {
    const inscription = await sdk.bitcoin.inscribeData(
      'Integration test',
      'text/plain'
    );

    expect(inscription.inscriptionId).toBeDefined();

    // Verify inscription can be tracked
    const tracked = await sdk.bitcoin.trackInscription(
      inscription.inscriptionId
    );

    expect(tracked).toBeDefined();
    expect(tracked!.satoshi).toBe(inscription.satoshi);
  }, 120000); // 2 minute timeout
});
```

---

## Production Deployment

### Configuration Management

```typescript
// config/production.ts
export const productionConfig = {
  network: 'mainnet' as const,

  ordinalsProvider: {
    apiUrl: process.env.ORD_API_URL!,
    timeout: 30000,
    retries: 3,
    retryDelay: 2000
  },

  feeOracle: {
    url: 'https://mempool.space/api/v1/fees/recommended',
    fallbackRate: 10,
    timeout: 5000
  },

  security: {
    useExternalSigner: true,
    requireMFA: true,
    maxTransactionValue: 10_000_000, // 0.1 BTC
    addressWhitelist: process.env.ADDRESS_WHITELIST?.split(',') || []
  },

  monitoring: {
    enableAlerts: true,
    alertThreshold: 1_000_000, // 0.01 BTC
    logLevel: 'info',
    sentryDSN: process.env.SENTRY_DSN
  },

  rateLimit: {
    maxRequestsPerMinute: 60,
    maxConcurrentOps: 5
  }
};

// Validate configuration
function validateConfig(config: typeof productionConfig): void {
  const required = [
    'ORD_API_URL',
    'BITCOIN_PRIVATE_KEY',
    'SENTRY_DSN'
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  // Validate network-specific settings
  if (config.network === 'mainnet') {
    if (!config.security.useExternalSigner) {
      throw new Error('External signer required for mainnet');
    }
  }
}

validateConfig(productionConfig);
```

---

### Health Checks

```typescript
class HealthCheck {
  async checkBitcoinOperations(): Promise<HealthStatus> {
    const checks = await Promise.all([
      this.checkProvider(),
      this.checkFeeOracle(),
      this.checkBalance(),
      this.checkExternalSigner()
    ]);

    const allHealthy = checks.every(c => c.healthy);

    return {
      healthy: allHealthy,
      checks,
      timestamp: new Date().toISOString()
    };
  }

  private async checkProvider(): Promise<CheckResult> {
    try {
      await sdk.bitcoin.trackInscription('test');
      return { name: 'provider', healthy: true };
    } catch (error) {
      return {
        name: 'provider',
        healthy: false,
        error: error.message
      };
    }
  }

  private async checkFeeOracle(): Promise<CheckResult> {
    try {
      const feeRate = await sdk.bitcoin.estimateFee();
      return {
        name: 'fee_oracle',
        healthy: feeRate > 0,
        value: feeRate
      };
    } catch (error) {
      return {
        name: 'fee_oracle',
        healthy: false,
        error: error.message
      };
    }
  }

  private async checkBalance(): Promise<CheckResult> {
    try {
      const balance = await getWalletBalance();
      const MIN_BALANCE = 1_000_000; // 0.01 BTC

      return {
        name: 'balance',
        healthy: balance >= MIN_BALANCE,
        value: balance
      };
    } catch (error) {
      return {
        name: 'balance',
        healthy: false,
        error: error.message
      };
    }
  }

  private async checkExternalSigner(): Promise<CheckResult> {
    try {
      const testSigner = await testExternalSigner();
      return {
        name: 'external_signer',
        healthy: testSigner
      };
    } catch (error) {
      return {
        name: 'external_signer',
        healthy: false,
        error: error.message
      };
    }
  }
}

// Express health check endpoint
app.get('/health', async (req, res) => {
  const healthCheck = new HealthCheck();
  const status = await healthCheck.checkBitcoinOperations();

  res.status(status.healthy ? 200 : 503).json(status);
});
```

---

## Compliance and Auditing

### Audit Logging

```typescript
class AuditLogger {
  async logOperation(operation: AuditOperation): Promise<void> {
    const auditLog = {
      timestamp: new Date().toISOString(),
      operation: operation.type,
      user: operation.userId,
      details: operation.details,
      result: operation.result,
      ipAddress: operation.ipAddress,
      environment: process.env.NODE_ENV
    };

    // Store in secure audit log
    await this.storeAuditLog(auditLog);

    // Compliance reporting
    if (this.requiresCompliance(operation)) {
      await this.reportToCompliance(auditLog);
    }
  }

  private async storeAuditLog(log: any): Promise<void> {
    // Store in tamper-proof log (append-only database)
    // Example: AWS CloudWatch Logs, Splunk, etc.
  }

  private requiresCompliance(operation: AuditOperation): boolean {
    const complianceOps = [
      'inscription_create',
      'inscription_transfer',
      'high_value_transaction'
    ];

    return complianceOps.includes(operation.type);
  }

  private async reportToCompliance(log: any): Promise<void> {
    // Send to compliance monitoring system
  }
}

// Usage
const auditLogger = new AuditLogger();

await auditLogger.logOperation({
  type: 'inscription_create',
  userId: 'user123',
  details: {
    inscriptionId: inscription.inscriptionId,
    contentType: 'image/png',
    size: 12345
  },
  result: 'success',
  ipAddress: req.ip
});
```

---

## Related Documentation

- **Integration Guide**: [BITCOIN_INTEGRATION_GUIDE.md](./BITCOIN_INTEGRATION_GUIDE.md)
- **API Reference**: [BITCOIN_API_REFERENCE.md](./BITCOIN_API_REFERENCE.md)
- **Troubleshooting**: [BITCOIN_TROUBLESHOOTING.md](./BITCOIN_TROUBLESHOOTING.md)
- **Migration Guide**: [BITCOIN_MIGRATION_GUIDE.md](./BITCOIN_MIGRATION_GUIDE.md)
- **Operations Guide**: [BITCOIN_OPERATIONS.md](./BITCOIN_OPERATIONS.md)
