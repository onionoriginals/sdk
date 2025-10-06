# Asset Layer Architecture - Visual Guide

## Complete Asset Lifecycle Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ORIGINALS SDK ASSET LAYER                            │
│                     Three-Tier Lifecycle Model                           │
└─────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: did:peer (Private Creation)                                      │
│ Cost: FREE  |  Location: Offline  |  State: Mutable                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌────────────────┐                                                       │
│  │ createAsset()  │  Input: AssetResource[]                               │
│  └───────┬────────┘        ├─ id, type, contentType, hash                 │
│          │                 └─ Optional: content, url                      │
│          ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────┐              │
│  │            OriginalsAsset Created                       │              │
│  │  • id: did:peer:z6Mk...                                │              │
│  │  • currentLayer: 'did:peer'                            │              │
│  │  • resources: [...]                                     │              │
│  │  • did: DIDDocument (with verification methods)        │              │
│  │  • credentials: []                                      │              │
│  │  • provenance: { creator, createdAt, migrations: [] }  │              │
│  └─────────────────────────────────────────────────────────┘              │
│                                                                            │
│  Private Key → KeyStore (if provided)                                     │
│  Verification Method ID → Multibase Private Key                           │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ publishToWeb(asset, domain)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ LAYER 2: did:webvh (Public Discovery)                                     │
│ Cost: ~$25/yr  |  Location: HTTPS  |  State: Verifiable                   │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────────────────────────────────────────────┐                  │
│  │ 1. Generate content-addressed paths                 │                  │
│  │    .well-known/webvh/{slug}/resources/{hash}        │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 2. Upload resources to StorageAdapter               │                  │
│  │    → Each resource gets URL                         │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 3. Create did:webvh binding                         │                  │
│  │    bindings['did:webvh'] = did:webvh:{domain}:{slug}│                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 4. Issue ResourceMigrated credential                │                  │
│  │    • Signed with original DID's key                 │                  │
│  │    • Subject: { fromLayer, toLayer, migratedAt }    │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 5. Update provenance                                │                  │
│  │    migrations.push({                                │                  │
│  │      from: 'did:peer',                              │                  │
│  │      to: 'did:webvh',                               │                  │
│  │      timestamp: ISO-8601                            │                  │
│  │    })                                               │                  │
│  └─────────────────────────────────────────────────────┘                  │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────┐              │
│  │            Asset Updated                                │              │
│  │  • id: did:peer:z6Mk... (unchanged)                    │              │
│  │  • currentLayer: 'did:webvh'                           │              │
│  │  • resources: [...] (now with URLs)                    │              │
│  │  • bindings: { 'did:webvh': 'did:webvh:...' }          │              │
│  │  • credentials: [ResourceMigrated]                     │              │
│  │  • provenance.migrations: [peer→webvh]                 │              │
│  └─────────────────────────────────────────────────────────┘              │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ inscribeOnBitcoin(asset, feeRate?)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ LAYER 3: did:btco (Bitcoin Ownership)                                     │
│ Cost: $75-200  |  Location: Bitcoin  |  State: Transferable                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────────────────────────────────────────────┐                  │
│  │ 1. Create inscription manifest (JSON)               │                  │
│  │    {                                                │                  │
│  │      assetId, resources[], timestamp                │                  │
│  │    }                                                │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 2. Estimate fees (FeeOracle or provided)           │                  │
│  │    feeRate: sat/vB                                  │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 3. Create inscription via OrdinalsProvider          │                  │
│  │    • Commit transaction                             │                  │
│  │    • Reveal transaction                             │                  │
│  │    • Unique satoshi assignment                      │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 4. Create did:btco binding                          │                  │
│  │    bindings['did:btco'] = did:btco:{satoshi}        │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 5. Update provenance                                │                  │
│  │    migrations.push({                                │                  │
│  │      from: 'did:webvh',                             │                  │
│  │      to: 'did:btco',                                │                  │
│  │      transactionId, inscriptionId, satoshi,         │                  │
│  │      commitTxId, revealTxId, feeRate                │                  │
│  │    })                                               │                  │
│  └─────────────────────────────────────────────────────┘                  │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────┐              │
│  │            Asset Updated                                │              │
│  │  • id: did:peer:z6Mk... (unchanged)                    │              │
│  │  • currentLayer: 'did:btco'                            │              │
│  │  • bindings: { 'did:webvh': ..., 'did:btco': ... }     │              │
│  │  • provenance.migrations: [peer→webvh, webvh→btco]     │              │
│  │  • provenance.txid: latest transaction                 │              │
│  └─────────────────────────────────────────────────────────┘              │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ transferOwnership(asset, newOwner)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ OWNERSHIP TRANSFER (btco layer only)                                      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────────────────────────────────────────────┐                  │
│  │ 1. Validate Bitcoin address (network-aware)        │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 2. Build transfer transaction                       │                  │
│  │    • Input: inscription UTXO                        │                  │
│  │    • Output: new owner address                      │                  │
│  ├─────────────────────────────────────────────────────┤                  │
│  │ 3. Record transfer in provenance                    │                  │
│  │    transfers.push({                                 │                  │
│  │      from: currentOwner,                            │                  │
│  │      to: newOwner,                                  │                  │
│  │      transactionId, timestamp                       │                  │
│  │    })                                               │                  │
│  └─────────────────────────────────────────────────────┘                  │
│                                                                            │
│  Returns: BitcoinTransaction { txid, vin, vout, fee }                     │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

## OriginalsAsset Internal Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OriginalsAsset                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PUBLIC (readonly)                                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  id: string                                                │    │
│  │    └─ DID identifier (from DID document)                   │    │
│  │                                                            │    │
│  │  resources: AssetResource[]                                │    │
│  │    └─ Digital content with hashes & metadata               │    │
│  │                                                            │    │
│  │  did: DIDDocument                                          │    │
│  │    └─ W3C DID document with verification methods           │    │
│  │                                                            │    │
│  │  credentials: VerifiableCredential[]                       │    │
│  │    └─ Accumulated credentials (migrations, attestations)   │    │
│  │                                                            │    │
│  │  currentLayer: LayerType                                   │    │
│  │    └─ 'did:peer' | 'did:webvh' | 'did:btco'              │    │
│  │                                                            │    │
│  │  bindings?: Record<string, string>                         │    │
│  │    └─ Layer-specific DID mappings                          │    │
│  │       Example: { 'did:webvh': 'did:webvh:...', ... }       │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  PRIVATE                                                            │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  provenance: ProvenanceChain                               │    │
│  │    ├─ createdAt: ISO-8601 timestamp                        │    │
│  │    ├─ creator: DID of original creator                     │    │
│  │    ├─ txid?: Latest transaction ID                         │    │
│  │    ├─ migrations: Array<MigrationRecord>                   │    │
│  │    │   └─ from, to, timestamp, txId, inscriptionId, ...    │    │
│  │    └─ transfers: Array<TransferRecord>                     │    │
│  │        └─ from, to, timestamp, transactionId               │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  METHODS                                                            │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  migrate(toLayer, details?)                                │    │
│  │    • Validates transition (unidirectional)                 │    │
│  │    • Updates currentLayer                                  │    │
│  │    • Records migration in provenance                       │    │
│  │                                                            │    │
│  │  getProvenance(): ProvenanceChain                          │    │
│  │    • Returns complete audit trail                          │    │
│  │    • Includes all migrations and transfers                 │    │
│  │                                                            │    │
│  │  recordTransfer(from, to, txId)                            │    │
│  │    • Appends to transfers array                            │    │
│  │    • Updates latest txid                                   │    │
│  │                                                            │    │
│  │  async verify(deps?): Promise<boolean>                     │    │
│  │    • DID document validation                               │    │
│  │    • Resource integrity (hash checks)                      │    │
│  │    • Credential validation                                 │    │
│  │    • Optional: cryptographic verification                  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## AssetResource Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                      AssetResource                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  REQUIRED FIELDS                                                │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  id: string                                           │     │
│  │    └─ Unique identifier within asset                  │     │
│  │       Example: "artwork-main", "metadata-json"        │     │
│  │                                                       │     │
│  │  type: string                                         │     │
│  │    └─ Resource category                               │     │
│  │       Examples: 'image', 'text', 'code', 'data'       │     │
│  │                                                       │     │
│  │  contentType: string                                  │     │
│  │    └─ MIME type (validated)                           │     │
│  │       Examples: 'image/png', 'text/plain',            │     │
│  │                 'application/json'                    │     │
│  │                                                       │     │
│  │  hash: string                                         │     │
│  │    └─ SHA-256 hash (64 hex characters)                │     │
│  │       Purpose: Content integrity verification         │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                 │
│  OPTIONAL FIELDS                                                │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  url?: string                                         │     │
│  │    └─ Added during publishToWeb()                     │     │
│  │       Format: https://{domain}/.well-known/...        │     │
│  │                                                       │     │
│  │  content?: string                                     │     │
│  │    └─ Inline content (for small resources)            │     │
│  │       Used for hash verification if present           │     │
│  │                                                       │     │
│  │  size?: number                                        │     │
│  │    └─ Size in bytes (informational)                   │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                 │
│  LIFECYCLE CHANGES                                              │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  did:peer:    { id, type, contentType, hash }         │     │
│  │                 ↓                                      │     │
│  │  did:webvh:   { id, type, contentType, hash, url }    │     │
│  │                 ↓                                      │     │
│  │  did:btco:    { id, type, contentType, hash, url }    │     │
│  │               (no structural change from webvh)        │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Verification Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                  Asset Verification Process                         │
│                  asset.verify(deps?)                                │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
      ┌───────────────────────────────────────────┐
      │  Step 1: DID Document Validation         │
      ├───────────────────────────────────────────┤
      │  • Structure check (context, id)          │
      │  • Method validation (peer/webvh/btco)    │
      │  • Controller validation                  │
      │  • Verification method presence           │
      └──────────────┬────────────────────────────┘
                     │ PASS
                     ▼
      ┌───────────────────────────────────────────┐
      │  Step 2: Resource Integrity               │
      ├───────────────────────────────────────────┤
      │  For each resource:                       │
      │  ┌─────────────────────────────────────┐  │
      │  │ • Validate structure (id, type,     │  │
      │  │   contentType, hash are strings)    │  │
      │  │ • Validate hash format (hex only)   │  │
      │  │                                     │  │
      │  │ IF content present:                 │  │
      │  │   • Compute SHA-256(content)        │  │
      │  │   • Compare with hash field         │  │
      │  │   • Must match exactly              │  │
      │  │                                     │  │
      │  │ IF url present AND fetch provided:  │  │
      │  │   • Fetch content from URL          │  │
      │  │   • Compute SHA-256(fetched)        │  │
      │  │   • Compare with hash field         │  │
      │  │   • Graceful fail on fetch error    │  │
      │  └─────────────────────────────────────┘  │
      └──────────────┬────────────────────────────┘
                     │ PASS
                     ▼
      ┌───────────────────────────────────────────┐
      │  Step 3: Credential Validation            │
      ├───────────────────────────────────────────┤
      │  For each credential:                     │
      │  ┌─────────────────────────────────────┐  │
      │  │ • Structure validation              │  │
      │  │   - @context present                │  │
      │  │   - type includes VC                │  │
      │  │   - issuer, issuanceDate present    │  │
      │  │   - credentialSubject present       │  │
      │  │                                     │  │
      │  │ IF credentialManager provided:      │  │
      │  │   • Cryptographic verification      │  │
      │  │   • Signature validation            │  │
      │  │   • DID resolution & key check      │  │
      │  └─────────────────────────────────────┘  │
      └──────────────┬────────────────────────────┘
                     │ PASS
                     ▼
              ┌─────────────┐
              │ Return true │
              └─────────────┘

                     │ FAIL (any step)
                     ▼
              ┌──────────────┐
              │ Return false │
              └──────────────┘
```

## Migration Path Validation

```
┌─────────────────────────────────────────────────────────────────┐
│                   Valid Migration Paths                         │
└─────────────────────────────────────────────────────────────────┘

  did:peer ──────────┐
      │              │
      │              │
      ▼              ▼
  did:webvh ───► did:btco  (Terminal State)


  ALLOWED TRANSITIONS:
  ├─ did:peer   → did:webvh  ✅
  ├─ did:peer   → did:btco   ✅ (direct)
  ├─ did:webvh  → did:btco   ✅
  └─ did:btco   → (none)     ❌ Terminal


  FORBIDDEN TRANSITIONS:
  ├─ did:webvh  → did:peer   ❌ (backward)
  ├─ did:btco   → did:webvh  ❌ (backward)
  ├─ did:btco   → did:peer   ❌ (backward)
  └─ did:btco   → did:btco   ❌ (no self-loop)


  VALIDATION LOGIC:
  const validTransitions: Record<LayerType, LayerType[]> = {
    'did:peer':  ['did:webvh', 'did:btco'],
    'did:webvh': ['did:btco'],
    'did:btco':  []  // Terminal
  };

  if (!validTransitions[currentLayer].includes(toLayer)) {
    throw new Error(`Invalid migration from ${currentLayer} to ${toLayer}`);
  }
```

## Adapter Integration Points

```
┌────────────────────────────────────────────────────────────────┐
│                 LifecycleManager Dependencies                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ DIDManager                                           │     │
│  │  • createDIDPeer()                                   │     │
│  │  • createDIDWebVH()                                  │     │
│  │  • resolveDID()                                      │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ CredentialManager                                    │     │
│  │  • createResourceCredential()                        │     │
│  │  • signCredential()                                  │     │
│  │  • verifyCredential()                                │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ BitcoinManager (optional)                            │     │
│  │  • inscribeData()                                    │     │
│  │  • transferInscription()                             │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ KeyStore (optional)                                  │     │
│  │  • getPrivateKey(verificationMethodId)               │     │
│  │  • setPrivateKey(verificationMethodId, privateKey)   │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                    Config-Level Adapters                       │
│                    (OriginalsConfig)                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ StorageAdapter (optional)                            │     │
│  │  • put(objectKey, data, options?)                    │     │
│  │  • get(objectKey)                                    │     │
│  │  • delete(objectKey)                                 │     │
│  │                                                      │     │
│  │  Used during: publishToWeb()                         │     │
│  │  Purpose: Upload resources to hosting                │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ FeeOracleAdapter (optional)                          │     │
│  │  • estimateFeeRate(targetBlocks)                     │     │
│  │                                                      │     │
│  │  Used during: inscribeOnBitcoin()                    │     │
│  │  Purpose: Dynamic fee rate estimation                │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ OrdinalsProvider (required for Bitcoin ops)          │     │
│  │  • createInscription(params)                         │     │
│  │  • getInscriptionById(inscriptionId)                 │     │
│  │  • getInscriptionsBySatoshi(satoshi)                 │     │
│  │  • transferInscription(inscriptionId, to, options)   │     │
│  │                                                      │     │
│  │  Used during: inscribeOnBitcoin(), transferOwnership│     │
│  │  Purpose: Bitcoin Ordinals operations                │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Complete Data Flow Example

```
┌────────────────────────────────────────────────────────────────────┐
│  EXAMPLE: Digital Artwork Lifecycle                                │
└────────────────────────────────────────────────────────────────────┘

INPUT:
  resources = [{
    id: "artwork-main",
    type: "image",
    contentType: "image/png",
    hash: "abc123...def (64 hex)",
    content: "<base64-encoded-image-data>"
  }]

┌─────────────────────────────────────────────────────────────────┐
│ PHASE 1: Create Asset                                          │
└─────────────────────────────────────────────────────────────────┘

  const asset = await sdk.lifecycle.createAsset(resources);

  OUTPUT:
    id: "did:peer:z6MkpTHR2VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH"
    currentLayer: "did:peer"
    resources: [{ id, type, contentType, hash, content }]
    did: { @context, id, verificationMethod: [...] }
    credentials: []
    provenance: {
      createdAt: "2025-10-04T12:00:00.000Z",
      creator: "did:peer:z6Mk...",
      migrations: [],
      transfers: []
    }

┌─────────────────────────────────────────────────────────────────┐
│ PHASE 2: Publish to Web                                        │
└─────────────────────────────────────────────────────────────────┘

  const webAsset = await sdk.lifecycle.publishToWeb(asset, "art.example.com");

  OPERATIONS:
    1. Generate slug: "z6MkpTH..."
    2. Upload to storage:
       - Path: .well-known/webvh/{slug}/resources/{hash-multibase}
       - URL: https://art.example.com/.well-known/webvh/...
    3. Add URL to resource
    4. Create webvh binding: "did:webvh:art.example.com:z6MkpTH..."
    5. Issue credential (signed with did:peer key)
    6. Update provenance

  OUTPUT (changes):
    currentLayer: "did:webvh"
    resources[0].url: "https://art.example.com/.well-known/..."
    bindings: { "did:webvh": "did:webvh:art.example.com:..." }
    credentials: [{ type: ["VerifiableCredential", "ResourceMigrated"], ... }]
    provenance.migrations: [{
      from: "did:peer",
      to: "did:webvh",
      timestamp: "2025-10-04T12:05:00.000Z"
    }]

┌─────────────────────────────────────────────────────────────────┐
│ PHASE 3: Inscribe on Bitcoin                                   │
└─────────────────────────────────────────────────────────────────┘

  const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 10);

  OPERATIONS:
    1. Create manifest:
       {
         assetId: "did:peer:z6Mk...",
         resources: [{ id, hash, contentType, url }],
         timestamp: "2025-10-04T12:10:00.000Z"
       }
    2. Check fee oracle (may override provided feeRate)
    3. Create inscription:
       - Commit tx: funds inscription
       - Reveal tx: embeds manifest
       - Satoshi: unique identifier (e.g., "1234567890:0")
    4. Create btco binding
    5. Update provenance

  OUTPUT (changes):
    currentLayer: "did:btco"
    bindings: {
      "did:webvh": "did:webvh:art.example.com:...",
      "did:btco": "did:btco:1234567890:0"
    }
    provenance.migrations: [
      { from: "did:peer", to: "did:webvh", ... },
      {
        from: "did:webvh",
        to: "did:btco",
        timestamp: "2025-10-04T12:10:30.000Z",
        transactionId: "abc...def",
        inscriptionId: "abc...def:0",
        satoshi: "1234567890:0",
        commitTxId: "commit...tx",
        revealTxId: "reveal...tx",
        feeRate: 10
      }
    ]
    provenance.txid: "reveal...tx"

┌─────────────────────────────────────────────────────────────────┐
│ PHASE 4: Transfer Ownership                                    │
└─────────────────────────────────────────────────────────────────┘

  const tx = await sdk.lifecycle.transferOwnership(
    btcoAsset,
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
  );

  OPERATIONS:
    1. Validate Bitcoin address (network check)
    2. Build transfer transaction:
       - Input: inscription UTXO
       - Output: buyer address
    3. Broadcast transaction
    4. Update provenance

  OUTPUT:
    BitcoinTransaction: {
      txid: "transfer...tx",
      vin: [{ ... }],
      vout: [{ ... }],
      fee: 2500
    }

    provenance.transfers: [{
      from: "did:peer:z6Mk...",
      to: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      timestamp: "2025-10-04T12:15:00.000Z",
      transactionId: "transfer...tx"
    }]
    provenance.txid: "transfer...tx" (updated)

┌─────────────────────────────────────────────────────────────────┐
│ FINAL STATE                                                     │
└─────────────────────────────────────────────────────────────────┘

  Complete provenance chain:
  ✅ Created: 2025-10-04T12:00:00Z by did:peer:z6Mk...
  ✅ Migration 1: did:peer → did:webvh (2025-10-04T12:05:00Z)
  ✅ Migration 2: did:webvh → did:btco (2025-10-04T12:10:30Z)
     - Inscription: abc...def:0
     - Satoshi: 1234567890:0
     - Fee rate: 10 sat/vB
  ✅ Transfer 1: did:peer:z6Mk... → bc1qxy2k... (2025-10-04T12:15:00Z)
     - Transaction: transfer...tx

  Verifiable at all levels:
  ✅ DID document valid
  ✅ Resource hashes match content
  ✅ Credentials cryptographically signed
  ✅ Bitcoin transactions on-chain
  ✅ Provenance chain complete
```
