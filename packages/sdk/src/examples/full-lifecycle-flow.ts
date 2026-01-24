/**
 * Example: Full Lifecycle Flow
 * 
 * This comprehensive example demonstrates the complete lifecycle of an Original:
 * 
 * 1. Create a draft (did:peer) - Private, offline creation
 * 2. Validate and estimate costs
 * 3. Publish to web (did:webvh) - Public discovery
 * 4. Inscribe on Bitcoin (did:btco) - Permanent ownership
 * 5. Transfer ownership
 * 6. Track provenance throughout
 * 
 * This example uses the clean lifecycle API with progress callbacks.
 */

import { 
  OriginalsSDK, 
  OrdMockProvider,
  ResourceManager,
  OriginalKind,
  type LifecycleProgress,
  type OriginalsAsset,
  type CostEstimate,
  type MigrationValidation
} from '../index';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Helper to compute content hash
 */
function computeHash(content: string | Buffer): string {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  return Buffer.from(sha256(buffer)).toString('hex');
}

/**
 * Progress logger for lifecycle operations
 */
function createProgressLogger(_operation: string) {
  return (progress: LifecycleProgress) => {
    const bar = '█'.repeat(Math.floor(progress.percentage / 5)) + '░'.repeat(20 - Math.floor(progress.percentage / 5));
    console.log(`  [${bar}] ${progress.percentage}% - ${progress.phase}: ${progress.message}`);
    if (progress.details?.transactionId) {
      console.log(`    Transaction: ${progress.details.transactionId}`);
    }
  };
}

/**
 * Initialize SDK with all necessary providers
 */
function initializeSDK(): OriginalsSDK {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
    enableLogging: false,
  });
}

/**
 * Step 1: Create resources using ResourceManager
 */
function createResources(resourceManager: ResourceManager): void {
  console.log('\n📁 STEP 1: Creating Resources with ResourceManager\n');

  // Create main content
  const mainContent = `
# My Digital Artwork

This is a unique digital creation that will be permanently recorded
on the Bitcoin blockchain.

## Description

A beautiful generative art piece created with mathematical precision.

## Attribution

Created by: Artist Name
Date: ${new Date().toISOString()}
  `.trim();

  // Create the resource
  const mainResource = resourceManager.createResource(mainContent, {
    id: 'content.md',
    type: 'document',
    contentType: 'text/markdown',
    description: 'Main artwork description'
  });

  console.log('Created resource:');
  console.log(`  ID: ${mainResource.id}`);
  console.log(`  Type: ${mainResource.type}`);
  console.log(`  Content Type: ${mainResource.contentType}`);
  console.log(`  Hash: ${mainResource.hash.substring(0, 16)}...`);
  console.log(`  Size: ${mainResource.size} bytes`);
  console.log(`  Version: ${mainResource.version}`);

  // Update the resource (creates version 2)
  const updatedContent = mainContent + '\n\n## Update\n\nAdded additional metadata.';
  const v2Resource = resourceManager.updateResource(mainResource, updatedContent, {
    changes: 'Added update section with additional metadata'
  });

  console.log('\nUpdated resource (new version):');
  console.log(`  Version: ${v2Resource.version}`);
  console.log(`  Previous Hash: ${v2Resource.previousVersionHash?.substring(0, 16)}...`);
  console.log(`  New Hash: ${v2Resource.hash.substring(0, 16)}...`);

  // Verify the version chain
  const chainValidation = resourceManager.verifyVersionChain(mainResource.id);
  console.log(`\nVersion chain validation: ${chainValidation.valid ? '✓ Valid' : '✗ Invalid'}`);
  if (chainValidation.warnings.length > 0) {
    console.log('  Warnings:', chainValidation.warnings.join(', '));
  }
}

/**
 * Step 2: Create a draft asset (did:peer layer)
 */
async function createDraft(sdk: OriginalsSDK): Promise<OriginalsAsset> {
  console.log('\n📝 STEP 2: Creating Draft Asset (did:peer)\n');

  const content = `
{
  "title": "Genesis Artwork #001",
  "artist": "Digital Creator",
  "medium": "Generative Algorithm",
  "created": "${new Date().toISOString()}",
  "description": "A unique piece of digital art inscribed forever on Bitcoin"
}
  `.trim();

  const resources = [{
    id: 'metadata.json',
    type: 'data',
    content,
    contentType: 'application/json',
    hash: computeHash(content),
    size: content.length,
  }];

  // Create draft with progress tracking
  const draft = await sdk.lifecycle.createDraft(resources, {
    onProgress: createProgressLogger('Create Draft'),
  });

  console.log('\nDraft created:');
  console.log(`  Asset ID: ${draft.id}`);
  console.log(`  Current Layer: ${draft.currentLayer}`);
  console.log(`  Resources: ${draft.resources.length}`);
  
  // Check provenance
  const provenance = draft.getProvenance();
  console.log(`  Created At: ${provenance.createdAt}`);
  console.log(`  Creator: ${provenance.creator.substring(0, 30)}...`);

  return draft;
}

/**
 * Step 3: Validate migration and estimate costs
 */
async function validateAndEstimate(sdk: OriginalsSDK, asset: OriginalsAsset): Promise<void> {
  console.log('\n🔍 STEP 3: Validating Migration & Estimating Costs\n');

  // Validate migration to did:webvh
  console.log('Validating migration to did:webvh:');
  const webvhValidation = sdk.lifecycle.validateMigration(asset, 'did:webvh');
  printValidation(webvhValidation);

  // Validate migration to did:btco
  console.log('\nValidating migration to did:btco:');
  const btcoValidation = sdk.lifecycle.validateMigration(asset, 'did:btco');
  printValidation(btcoValidation);

  // Estimate costs for Bitcoin inscription
  console.log('\nCost estimates for Bitcoin inscription:');
  const feeRates = [1, 5, 10, 25, 50];
  for (const feeRate of feeRates) {
    const estimate = await sdk.lifecycle.estimateCost(asset, 'did:btco', feeRate);
    printCostEstimate(estimate, feeRate);
  }
}

function printValidation(validation: MigrationValidation): void {
  console.log(`  Valid: ${validation.valid ? '✓' : '✗'}`);
  console.log(`  Current Layer: ${validation.currentLayer}`);
  console.log(`  Target Layer: ${validation.targetLayer}`);
  console.log('  Checks:');
  Object.entries(validation.checks).forEach(([check, passed]) => {
    if (passed !== undefined) {
      console.log(`    - ${check}: ${passed ? '✓' : '✗'}`);
    }
  });
  if (validation.errors.length > 0) {
    console.log('  Errors:', validation.errors.join(', '));
  }
  if (validation.warnings.length > 0) {
    console.log('  Warnings:', validation.warnings.join(', '));
  }
}

function printCostEstimate(estimate: CostEstimate, feeRate: number): void {
  console.log(`  ${feeRate} sat/vB:`);
  console.log(`    Total: ${estimate.totalSats} sats (~$${(estimate.totalSats * 0.0006).toFixed(4)} @ $60k/BTC)`);
  console.log(`    Breakdown: network=${estimate.breakdown.networkFee}, data=${estimate.breakdown.dataCost}, dust=${estimate.breakdown.dustValue}`);
  console.log(`    Confidence: ${estimate.confidence}`);
}

/**
 * Step 4: Publish to web (did:webvh layer)
 */
async function publishToWeb(sdk: OriginalsSDK, asset: OriginalsAsset): Promise<OriginalsAsset> {
  console.log('\n🌐 STEP 4: Publishing to Web (did:webvh)\n');

  // Subscribe to migration events
  const unsubscribe = asset.on('asset:migrated', (event) => {
    const migrationEvent = event as { asset: { fromLayer: string; toLayer: string } };
    console.log(`  🔔 Event: Migrated from ${migrationEvent.asset.fromLayer} to ${migrationEvent.asset.toLayer}`);
  });

  try {
    const published = await sdk.lifecycle.publish(
      asset,
      'did:webvh:magby.originals.build:example:artwork',
      {
        onProgress: createProgressLogger('Publish'),
      }
    );

    console.log('\nPublished to web:');
    console.log(`  Asset ID: ${published.id}`);
    console.log(`  Current Layer: ${published.currentLayer}`);
    console.log(`  Bindings: ${JSON.stringify(published.bindings || {})}`);

    // Check provenance after migration
    const provenance = published.getProvenance();
    console.log(`  Migrations: ${provenance.migrations.length}`);
    
    if (provenance.migrations.length > 0) {
      const lastMigration = provenance.migrations[provenance.migrations.length - 1];
      console.log(`  Last migration: ${lastMigration.from} → ${lastMigration.to} at ${lastMigration.timestamp}`);
    }

    // Check credentials
    console.log(`  Credentials: ${published.credentials.length}`);
    published.credentials.forEach((cred, i) => {
      console.log(`    ${i + 1}. Type: ${cred.type.join(', ')}`);
    });

    return published;
  } finally {
    unsubscribe();
  }
}

/**
 * Step 5: Inscribe on Bitcoin (did:btco layer)
 */
async function inscribeOnBitcoin(sdk: OriginalsSDK, asset: OriginalsAsset): Promise<OriginalsAsset> {
  console.log('\n₿ STEP 5: Inscribing on Bitcoin (did:btco)\n');

  // Subscribe to migration events
  asset.on('asset:migrated', (_event) => {
    console.log(`  🔔 Event: Inscribed on Bitcoin`);
  });

  const inscribed = await sdk.lifecycle.inscribe(asset, {
    feeRate: 10,
    onProgress: createProgressLogger('Inscribe'),
  });

  console.log('\nInscribed on Bitcoin:');
  console.log(`  Asset ID: ${inscribed.id}`);
  console.log(`  Current Layer: ${inscribed.currentLayer}`);
  console.log(`  Bindings: ${JSON.stringify(inscribed.bindings || {})}`);

  // Check provenance after inscription
  const provenance = inscribed.getProvenance();
  console.log(`  Total migrations: ${provenance.migrations.length}`);
  
  const btcoMigration = provenance.migrations.find(m => m.to === 'did:btco');
  if (btcoMigration) {
    console.log('\n  Bitcoin inscription details:');
    console.log(`    Transaction ID: ${btcoMigration.transactionId || 'N/A'}`);
    console.log(`    Inscription ID: ${btcoMigration.inscriptionId || 'N/A'}`);
    console.log(`    Satoshi: ${btcoMigration.satoshi || 'N/A'}`);
    console.log(`    Fee Rate: ${btcoMigration.feeRate || 'N/A'} sat/vB`);
    console.log(`    Commit TX: ${btcoMigration.commitTxId || 'N/A'}`);
    console.log(`    Reveal TX: ${btcoMigration.revealTxId || 'N/A'}`);
  }

  return inscribed;
}

/**
 * Step 6: Transfer ownership
 */
async function transferOwnership(sdk: OriginalsSDK, asset: OriginalsAsset): Promise<void> {
  console.log('\n🔄 STEP 6: Transferring Ownership\n');

  // New owner address (mock address for regtest)
  const newOwner = 'bcrt1qnewowner123456789abcdef';

  // Subscribe to transfer events
  asset.on('asset:transferred', (event) => {
    const transferEvent = event as { to: string };
    console.log(`  🔔 Event: Ownership transferred to ${transferEvent.to}`);
  });

  const tx = await sdk.lifecycle.transfer(asset, newOwner, {
    onProgress: createProgressLogger('Transfer'),
  });

  console.log('\nOwnership transferred:');
  console.log(`  Transaction ID: ${tx.txid}`);
  console.log(`  New Owner: ${newOwner}`);
  console.log(`  Fee: ${tx.fee} sats`);

  // Check final provenance
  const provenance = asset.getProvenance();
  console.log(`\n  Transfer history: ${provenance.transfers.length} transfer(s)`);
  provenance.transfers.forEach((transfer, i) => {
    console.log(`    ${i + 1}. ${transfer.from.substring(0, 20)}... → ${transfer.to.substring(0, 20)}...`);
    console.log(`       TX: ${transfer.transactionId}`);
    console.log(`       At: ${transfer.timestamp}`);
  });
}

/**
 * Step 7: View complete provenance
 */
function viewProvenance(asset: OriginalsAsset): void {
  console.log('\n📜 STEP 7: Complete Provenance Chain\n');

  const provenance = asset.getProvenance();
  const summary = asset.getProvenanceSummary();

  console.log('Provenance Summary:');
  console.log(`  Created: ${summary.created}`);
  console.log(`  Creator: ${summary.creator.substring(0, 40)}...`);
  console.log(`  Current Layer: ${summary.currentLayer}`);
  console.log(`  Migration Count: ${summary.migrationCount}`);
  console.log(`  Transfer Count: ${summary.transferCount}`);
  console.log(`  Last Activity: ${summary.lastActivity}`);

  console.log('\nMigration History:');
  provenance.migrations.forEach((migration, i) => {
    console.log(`  ${i + 1}. ${migration.from} → ${migration.to}`);
    console.log(`     Timestamp: ${migration.timestamp}`);
    if (migration.transactionId) {
      console.log(`     TX: ${migration.transactionId}`);
    }
    if (migration.inscriptionId) {
      console.log(`     Inscription: ${migration.inscriptionId}`);
    }
  });

  console.log('\nTransfer History:');
  if (provenance.transfers.length === 0) {
    console.log('  No transfers recorded');
  } else {
    provenance.transfers.forEach((transfer, i) => {
      console.log(`  ${i + 1}. ${transfer.timestamp}`);
      console.log(`     From: ${transfer.from}`);
      console.log(`     To: ${transfer.to}`);
      console.log(`     TX: ${transfer.transactionId}`);
    });
  }

  console.log('\nResource Updates:');
  if (provenance.resourceUpdates.length === 0) {
    console.log('  No resource updates recorded');
  } else {
    provenance.resourceUpdates.forEach((update, i) => {
      console.log(`  ${i + 1}. Resource: ${update.resourceId}`);
      console.log(`     Version: ${update.fromVersion} → ${update.toVersion}`);
      console.log(`     At: ${update.timestamp}`);
    });
  }
}

/**
 * Bonus: Create and publish a typed Original
 */
async function typedOriginalFlow(sdk: OriginalsSDK): Promise<void> {
  console.log('\n🎨 BONUS: Typed Media Original Flow\n');

  const imageDescription = `
{
  "title": "Digital Sunrise",
  "artist": "AI Collaborator",
  "medium": "Generative AI + Human Curation",
  "dimensions": "2048x2048",
  "colorSpace": "sRGB"
}
  `.trim();

  const mediaAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Media,
    {
      kind: OriginalKind.Media,
      name: 'Digital Sunrise',
      version: '1.0.0',
      description: 'A stunning generative sunrise created with AI',
      resources: [{
        id: 'metadata.json',
        type: 'data',
        content: imageDescription,
        contentType: 'application/json',
        hash: computeHash(imageDescription),
        size: imageDescription.length,
      }],
      tags: ['generative', 'ai', 'sunrise', 'digital-art'],
      author: {
        name: 'AI Collaborator',
      },
      license: 'CC-BY-4.0',
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
        dimensions: {
          width: 2048,
          height: 2048,
          aspectRatio: '1:1',
        },
        altText: 'A vibrant digital sunrise over a futuristic cityscape',
        colorSpace: 'sRGB',
      },
    }
  );

  console.log('Created Media Original:');
  console.log(`  ID: ${mediaAsset.id}`);
  console.log(`  Kind: ${OriginalKind.Media}`);

  // Get the manifest
  const manifest = sdk.lifecycle.getManifest(mediaAsset);
  if (manifest && manifest.metadata) {
    const meta = manifest.metadata as { mediaType?: string; dimensions?: { width: number; height: number } };
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Media Type: ${meta.mediaType}`);
    console.log(`  Dimensions: ${meta.dimensions?.width}x${meta.dimensions?.height}`);
  }

  // Estimate inscription cost for this typed original
  const cost = await sdk.lifecycle.estimateTypedOriginalCost(manifest!, 'did:btco', 10);
  console.log(`\n  Estimated inscription cost: ${cost.totalSats} sats`);
}

/**
 * Main execution - full lifecycle demonstration
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           ORIGINALS SDK - FULL LIFECYCLE FLOW                 ║');
  console.log('║                                                                ║');
  console.log('║   did:peer → did:webvh → did:btco → Transfer                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  try {
    // Initialize
    const sdk = initializeSDK();
    const resourceManager = new ResourceManager();

    // Execute lifecycle steps
    createResources(resourceManager);
    
    const draft = await createDraft(sdk);
    
    await validateAndEstimate(sdk, draft);
    
    const published = await publishToWeb(sdk, draft);
    
    const inscribed = await inscribeOnBitcoin(sdk, published);
    
    await transferOwnership(sdk, inscribed);
    
    viewProvenance(inscribed);
    
    await typedOriginalFlow(sdk);

    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    LIFECYCLE COMPLETE ✓                       ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n❌ Error during lifecycle flow:', error);
    process.exit(1);
  }
}

// Export for use as module
export { 
  main,
  initializeSDK,
  createResources,
  createDraft,
  validateAndEstimate,
  publishToWeb,
  inscribeOnBitcoin,
  transferOwnership,
  viewProvenance,
  typedOriginalFlow,
};

// Run if executed directly
if (require.main === module) {
  void main();
}

