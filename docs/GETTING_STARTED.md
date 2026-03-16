# Getting Started with Originals SDK

Create your first digital asset with cryptographically verifiable provenance — in under 15 minutes.

## What you'll build

By the end of this tutorial, you'll have:

1. Created a digital asset as a private draft (`did:peer`)
2. Published it for public discovery (`did:webvh`)
3. Inscribed it on Bitcoin for permanent ownership (`did:btco`)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ or [Bun](https://bun.sh/) 1.0+
- A terminal and your favorite code editor

## Step 1: Install the SDK

```bash
npm install @originals/sdk
```

Or with Bun:

```bash
bun add @originals/sdk
```

## Step 2: Initialize the SDK

Create a file called `my-first-original.ts`:

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

// Use the development network with a mock Bitcoin provider.
// This lets you experiment for free — no real Bitcoin needed.
const sdk = OriginalsSDK.create({
  network: 'regtest',
  webvhNetwork: 'magby',
  ordinalsProvider: new OrdMockProvider(),
  enableLogging: true,
});
```

The SDK has three network tiers that pair a WebVH network with a Bitcoin network:

| Environment | WebVH Network | Bitcoin Network | Cost |
|-------------|---------------|-----------------|------|
| Development | `magby` | `regtest` | Free |
| Staging | `cleffa` | `signet` | Free |
| Production | `pichu` | `mainnet` | Real BTC |

For this tutorial we use `magby` + `regtest` so everything is free and local.

## Step 3: Create a draft asset (did:peer)

A draft asset lives in the `did:peer` layer — it's private, offline, and costs nothing. This is where you experiment.

Define your asset's resources and create the draft:

```typescript
// Define the resources that make up your asset.
// Each resource has an ID, type, MIME type, and content hash.
const resources = [
  {
    id: 'artwork',
    type: 'image',
    contentType: 'image/png',
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
];

// Create the draft. It gets a did:peer identifier automatically.
const draft = await sdk.lifecycle.createDraft(resources, {
  onProgress: (p) => console.log(`[${p.percentage}%] ${p.message}`),
});

console.log('Draft created!');
console.log('  Layer:', draft.currentLayer);  // 'did:peer'
console.log('  DID:  ', draft.id);
```

At this point your asset exists only locally. No network calls, no fees. You can iterate on it as much as you want.

## Step 4: Publish for discovery (did:webvh)

When you're ready to make your asset publicly discoverable, publish it to the `did:webvh` layer. This serves your asset's DID document over HTTPS so anyone can find and verify it.

```typescript
// You need a publisher DID. In development, create one from the SDK:
const { didDocument: publisherDoc } = await sdk.did.createDIDPeer([], true);
const publisherDid = publisherDoc.id;

// Publish the draft to the web
const published = await sdk.lifecycle.publish(draft, publisherDid, {
  onProgress: (p) => console.log(`[${p.percentage}%] ${p.message}`),
});

console.log('Published!');
console.log('  Layer:', published.currentLayer);  // 'did:webvh'
console.log('  DID:  ', published.id);
```

Your asset is now publicly resolvable. Anyone with the DID can verify its provenance.

## Step 5: Inscribe on Bitcoin (did:btco)

For permanent, transferable ownership, inscribe your asset on Bitcoin. This uses the Ordinals protocol to anchor your asset's identity on-chain.

```typescript
// Estimate the cost first
const estimate = await sdk.lifecycle.estimateCost(published, 'did:btco');
console.log(`Estimated cost: ${estimate.totalSats} sats at ${estimate.feeRate} sat/vB`);

// Inscribe on Bitcoin
const inscribed = await sdk.lifecycle.inscribe(published, {
  feeRate: 10,
  onProgress: (p) => console.log(`[${p.percentage}%] ${p.message}`),
});

console.log('Inscribed on Bitcoin!');
console.log('  Layer:', inscribed.currentLayer);  // 'did:btco'
console.log('  DID:  ', inscribed.id);
```

Your asset now has a permanent identity on the Bitcoin blockchain. It can be transferred, sold, or held — with full provenance tracking.

## Step 6: Transfer ownership (optional)

Once an asset is inscribed on Bitcoin, you can transfer it to a new owner:

```typescript
const tx = await sdk.lifecycle.transfer(inscribed, 'bc1qexampleaddress...', {
  onProgress: (p) => console.log(`[${p.percentage}%] ${p.message}`),
});

console.log('Transferred!');
console.log('  Transaction:', tx.txid);
```

## Full example

Here's the complete script:

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

async function main() {
  // 1. Initialize
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
    enableLogging: true,
  });

  // 2. Define resources
  const resources = [
    {
      id: 'artwork',
      type: 'image',
      contentType: 'image/png',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  ];

  // 3. Create draft (did:peer) — free, offline
  const draft = await sdk.lifecycle.createDraft(resources);
  console.log('Draft created:', draft.id);

  // 4. Publish (did:webvh) — publicly discoverable
  const { didDocument: publisherDoc } = await sdk.did.createDIDPeer([], true);
  const published = await sdk.lifecycle.publish(draft, publisherDoc.id);
  console.log('Published:', published.id);

  // 5. Inscribe (did:btco) — permanent ownership on Bitcoin
  const inscribed = await sdk.lifecycle.inscribe(published, { feeRate: 10 });
  console.log('Inscribed:', inscribed.id);

  // 6. Verify provenance
  const provenance = inscribed.getProvenance();
  console.log('Provenance chain:', JSON.stringify(provenance, null, 2));
}

main().catch(console.error);
```

Run it:

```bash
npx tsx my-first-original.ts
# or
bun run my-first-original.ts
```

## Understanding the three layers

The Originals Protocol uses economic gravity to determine when Bitcoin-level security is justified:

```
did:peer          did:webvh              did:btco
(Private)    →    (Public)          →    (Bitcoin)
Free, offline     ~$25/year domain       $75-200 one-time
Experiment        Share & discover       Own & transfer
```

Migration is **unidirectional** — you can only move forward through the layers. This reflects increasing commitment and cost.

## What's next?

- **[API Reference](./API_REFERENCE.md)** — Full API documentation
- **[Bitcoin Integration Guide](./BITCOIN_INTEGRATION_GUIDE.md)** — Production Bitcoin setup
- **[LLM Quick Reference](./LLM_QUICK_REFERENCE.md)** — Compact API cheat sheet
- **Typed Originals** — Use `sdk.lifecycle.createTypedOriginal()` to create structured assets (App, Agent, Module, Dataset, Media, Document)
- **Batch Operations** — Use `sdk.lifecycle.batchCreateAssets()` for bulk workflows
- **Verifiable Credentials** — Use `sdk.credentials` to issue and verify W3C credentials for your assets
- **External Signers** — Integrate with Turnkey, AWS KMS, or HSMs for production key management
