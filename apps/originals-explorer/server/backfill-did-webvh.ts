#!/usr/bin/env node
/**
 * Backfill job to migrate existing users from did:privy to did:webvh
 * 
 * This script is idempotent and resumable. It processes users in batches
 * and can safely be interrupted and restarted.
 * 
 * Usage:
 *   # Dry run (no changes)
 *   bun run server/backfill-did-webvh.ts --dry-run
 * 
 *   # Execute backfill
 *   bun run server/backfill-did-webvh.ts --execute
 * 
 *   # Process specific batch size
 *   bun run server/backfill-did-webvh.ts --execute --batch-size 10
 */

import { storage } from "./storage";
import { createUserDIDWebVH, auditLog } from "./didwebvh-service";
import { PrivyClient } from "@privy-io/server-auth";

interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  delayMs: number;
}

interface BackfillStats {
  totalUsers: number;
  usersWithWebvh: number;
  usersNeedingWebvh: number;
  usersProcessed: number;
  usersSuccess: number;
  usersSkipped: number;
  usersFailed: number;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * Main backfill function
 */
async function backfillDIDWebVH(options: BackfillOptions): Promise<BackfillStats> {
  const startTime = Date.now();
  const correlationId = `backfill-${Date.now()}`;
  
  console.log('='.repeat(80));
  console.log('DID:WebVH Backfill Job');
  console.log('='.repeat(80));
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Batch Size: ${options.batchSize}`);
  console.log(`Delay: ${options.delayMs}ms`);
  console.log(`Correlation ID: ${correlationId}`);
  console.log('='.repeat(80));
  console.log();

  const stats: BackfillStats = {
    totalUsers: 0,
    usersWithWebvh: 0,
    usersNeedingWebvh: 0,
    usersProcessed: 0,
    usersSuccess: 0,
    usersSkipped: 0,
    usersFailed: 0,
    errors: [],
  };

  auditLog('backfill.started', {
    dryRun: options.dryRun,
    batchSize: options.batchSize,
    correlationId
  });

  try {
    // Initialize Privy client
    const privyClient = new PrivyClient(
      process.env.PRIVY_APP_ID!,
      process.env.PRIVY_APP_SECRET!
    );

    // Get all users (in production, this should be paginated)
    const allUsers = await getAllUsers();
    stats.totalUsers = allUsers.length;

    console.log(`Found ${stats.totalUsers} total users`);

    // Filter users that need did:webvh
    const usersNeedingWebvh = allUsers.filter(user => !user.did_webvh);
    stats.usersNeedingWebvh = usersNeedingWebvh.length;
    stats.usersWithWebvh = stats.totalUsers - stats.usersNeedingWebvh;

    console.log(`Users with did:webvh: ${stats.usersWithWebvh}`);
    console.log(`Users needing did:webvh: ${stats.usersNeedingWebvh}`);
    console.log();

    if (stats.usersNeedingWebvh === 0) {
      console.log('✅ All users already have did:webvh. Nothing to do.');
      return stats;
    }

    if (options.dryRun) {
      console.log('🔍 DRY RUN - No changes will be made');
      console.log();
      console.log('Users that would be migrated:');
      usersNeedingWebvh.slice(0, 10).forEach((user, idx) => {
        console.log(`  ${idx + 1}. ${user.id} (${user.username})`);
      });
      if (usersNeedingWebvh.length > 10) {
        console.log(`  ... and ${usersNeedingWebvh.length - 10} more`);
      }
      return stats;
    }

    // Process users in batches
    console.log('🚀 Starting backfill...');
    console.log();

    for (let i = 0; i < usersNeedingWebvh.length; i += options.batchSize) {
      const batch = usersNeedingWebvh.slice(i, i + options.batchSize);
      const batchNumber = Math.floor(i / options.batchSize) + 1;
      const totalBatches = Math.ceil(usersNeedingWebvh.length / options.batchSize);

      console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} users)...`);

      // Process batch with concurrent execution
      const batchResults = await Promise.allSettled(
        batch.map(user => processSingleUser(user, privyClient, correlationId))
      );

      // Update stats
      batchResults.forEach((result, idx) => {
        const user = batch[idx];
        stats.usersProcessed++;

        if (result.status === 'fulfilled') {
          if (result.value.success) {
            stats.usersSuccess++;
            console.log(`  ✅ ${user.id}: ${result.value.did}`);
          } else {
            stats.usersSkipped++;
            console.log(`  ⏭️  ${user.id}: ${result.value.reason}`);
          }
        } else {
          stats.usersFailed++;
          const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
          stats.errors.push({ userId: user.id, error });
          console.log(`  ❌ ${user.id}: ${error}`);
        }
      });

      // Progress update
      const progress = ((stats.usersProcessed / stats.usersNeedingWebvh) * 100).toFixed(1);
      console.log(`  Progress: ${stats.usersProcessed}/${stats.usersNeedingWebvh} (${progress}%)`);
      console.log();

      // Delay between batches to avoid rate limiting
      if (i + options.batchSize < usersNeedingWebvh.length) {
        await sleep(options.delayMs);
      }
    }

    const duration = Date.now() - startTime;
    
    console.log('='.repeat(80));
    console.log('Backfill Complete');
    console.log('='.repeat(80));
    console.log(`Total Users: ${stats.totalUsers}`);
    console.log(`Users Processed: ${stats.usersProcessed}`);
    console.log(`✅ Success: ${stats.usersSuccess}`);
    console.log(`⏭️  Skipped: ${stats.usersSkipped}`);
    console.log(`❌ Failed: ${stats.usersFailed}`);
    console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log('='.repeat(80));

    if (stats.errors.length > 0) {
      console.log();
      console.log('Errors:');
      stats.errors.forEach(({ userId, error }) => {
        console.log(`  ${userId}: ${error}`);
      });
    }

    auditLog('backfill.completed', {
      ...stats,
      duration,
      correlationId
    });

    return stats;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Fatal error during backfill:', error);
    
    auditLog('backfill.error', {
      error: errorMessage,
      stats,
      correlationId
    });

    throw error;
  }
}

/**
 * Process a single user
 */
async function processSingleUser(
  user: any,
  privyClient: PrivyClient,
  correlationId: string
): Promise<{ success: boolean; did?: string; reason?: string }> {
  try {
    // Check if user already has did:webvh (race condition protection)
    const currentUser = await storage.getUser(user.id);
    if (currentUser?.did_webvh) {
      return { 
        success: false, 
        reason: 'Already has did:webvh (concurrent creation detected)' 
      };
    }

    // Create DID:WebVH
    const webvhData = await createUserDIDWebVH(user.id, privyClient);

    // Update user record
    await storage.updateUser(user.id, {
      did_webvh: webvhData.did,
      didWebvhDocument: webvhData.didDocument,
      didWebvhCreatedAt: webvhData.didCreatedAt,
      authWalletId: webvhData.authWalletId,
      assertionWalletId: webvhData.assertionWalletId,
      updateWalletId: webvhData.updateWalletId,
      authKeyPublic: webvhData.authKeyPublic,
      assertionKeyPublic: webvhData.assertionKeyPublic,
      updateKeyPublic: webvhData.updateKeyPublic,
    });

    auditLog('backfill.user_migrated', {
      userId: user.id,
      did: webvhData.did,
      correlationId
    });

    return { success: true, did: webvhData.did };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    auditLog('backfill.user_failed', {
      userId: user.id,
      error: errorMessage,
      correlationId
    });

    throw error;
  }
}

/**
 * Get all users from storage
 * In production, this should use pagination
 */
async function getAllUsers(): Promise<any[]> {
  // For in-memory storage, we need to access the internal map
  // In production with a real database, use proper pagination
  const memStorage = storage as any;
  if (memStorage.users && memStorage.users instanceof Map) {
    return Array.from(memStorage.users.values());
  }
  return [];
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse command line arguments
 */
function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  
  const options: BackfillOptions = {
    dryRun: true,
    batchSize: 50,
    delayMs: 1000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--execute') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--delay' && args[i + 1]) {
      options.delayMs = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--help') {
      console.log(`
Usage: bun run server/backfill-did-webvh.ts [options]

Options:
  --execute           Execute the backfill (default is dry-run)
  --dry-run           Run in dry-run mode (no changes)
  --batch-size <n>    Process N users per batch (default: 50)
  --delay <ms>        Delay between batches in milliseconds (default: 1000)
  --help              Show this help message

Examples:
  # Dry run
  bun run server/backfill-did-webvh.ts --dry-run

  # Execute backfill
  bun run server/backfill-did-webvh.ts --execute

  # Execute with custom batch size
  bun run server/backfill-did-webvh.ts --execute --batch-size 10 --delay 2000
      `);
      process.exit(0);
    }
  }

  return options;
}

// Run backfill if executed directly
if (import.meta.main) {
  const options = parseArgs();
  
  backfillDIDWebVH(options)
    .then(() => {
      console.log('\n✅ Backfill job completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Backfill job failed:', error);
      process.exit(1);
    });
}

export { backfillDIDWebVH, type BackfillOptions, type BackfillStats };
