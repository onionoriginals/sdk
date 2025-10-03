#!/usr/bin/env node
/**
 * Admin CLI for DID:WebVH management
 * 
 * Commands:
 *   create <user-id>        Create did:webvh for a user
 *   validate <did>          Validate a did:webvh identifier
 *   status                  Show migration status
 *   cutover --enable|--disable  Enable/disable DID:WebVH migration
 */

import { storage } from "./storage";
import { 
  createUserDIDWebVH, 
  verifyDIDWebVH, 
  isDidWebVHEnabled,
  isDualReadEnabled,
  isDualWriteEnabled,
  auditLog 
} from "./didwebvh-service";
import { PrivyClient } from "@privy-io/server-auth";

/**
 * Create DID:WebVH for a user
 */
async function createDID(userId: string): Promise<void> {
  console.log(`Creating DID:WebVH for user: ${userId}`);
  console.log();

  const correlationId = `cli-create-${Date.now()}`;

  try {
    // Get user
    const user = await storage.getUser(userId);
    if (!user) {
      console.error(`❌ User not found: ${userId}`);
      process.exit(1);
    }

    // Check if user already has did:webvh
    if (user.did_webvh) {
      console.log(`ℹ️  User already has did:webvh: ${user.did_webvh}`);
      console.log();
      console.log('To regenerate, you must first manually remove the existing DID from the database.');
      process.exit(0);
    }

    // Initialize Privy client
    const privyClient = new PrivyClient(
      process.env.PRIVY_APP_ID!,
      process.env.PRIVY_APP_SECRET!
    );

    // Create DID:WebVH
    const webvhData = await createUserDIDWebVH(userId, privyClient);

    // Update user record
    await storage.updateUser(userId, {
      did_webvh: webvhData.did,
      didWebvhDocument: webvhData.didDocument,
      didWebvhCreatedAt: webvhData.didCreatedAt,
    });

    console.log('✅ DID:WebVH created successfully');
    console.log();
    console.log('DID:', webvhData.did);
    console.log('Created:', webvhData.didCreatedAt.toISOString());
    console.log();
    console.log('DID Document:');
    console.log(JSON.stringify(webvhData.didDocument, null, 2));

    auditLog('cli.did_created', {
      userId,
      did: webvhData.did,
      correlationId
    });
  } catch (error) {
    console.error('❌ Error creating DID:', error);
    process.exit(1);
  }
}

/**
 * Validate a DID:WebVH
 */
async function validateDID(did: string): Promise<void> {
  console.log(`Validating DID: ${did}`);
  console.log();

  const correlationId = `cli-validate-${Date.now()}`;

  try {
    const result = await verifyDIDWebVH(did);

    if (result.valid) {
      console.log('✅ DID is valid');
      if (result.document) {
        console.log();
        console.log('DID Document:');
        console.log(JSON.stringify(result.document, null, 2));
      }
    } else {
      console.log('❌ DID is invalid');
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
    }

    auditLog('cli.did_validated', {
      did,
      valid: result.valid,
      error: result.error,
      correlationId
    });
  } catch (error) {
    console.error('❌ Error validating DID:', error);
    process.exit(1);
  }
}

/**
 * Show migration status
 */
async function showStatus(): Promise<void> {
  console.log('DID:WebVH Migration Status');
  console.log('='.repeat(80));
  console.log();

  try {
    // Get feature flag status
    const webvhEnabled = isDidWebVHEnabled();
    const dualReadEnabled = isDualReadEnabled();
    const dualWriteEnabled = isDualWriteEnabled();

    console.log('Feature Flags:');
    console.log(`  AUTH_DID_WEBVH_ENABLED: ${webvhEnabled ? '✅ true' : '❌ false'}`);
    console.log(`  AUTH_DID_DUAL_READ_ENABLED: ${dualReadEnabled ? '✅ true' : '❌ false'}`);
    console.log(`  AUTH_DID_DUAL_WRITE_ENABLED: ${dualWriteEnabled ? '✅ true' : '❌ false'}`);
    console.log();

    // Get user statistics
    const allUsers = await getAllUsers();
    const totalUsers = allUsers.length;
    const usersWithWebvh = allUsers.filter(u => u.did_webvh).length;
    const usersWithPrivy = allUsers.filter(u => u.did_privy).length;
    const usersWithBoth = allUsers.filter(u => u.did_webvh && u.did_privy).length;

    console.log('User Statistics:');
    console.log(`  Total Users: ${totalUsers}`);
    console.log(`  Users with did:webvh: ${usersWithWebvh} (${((usersWithWebvh / totalUsers) * 100).toFixed(1)}%)`);
    console.log(`  Users with did:privy: ${usersWithPrivy} (${((usersWithPrivy / totalUsers) * 100).toFixed(1)}%)`);
    console.log(`  Users with both: ${usersWithBoth} (${((usersWithBoth / totalUsers) * 100).toFixed(1)}%)`);
    console.log();

    // Migration status
    console.log('Migration Status:');
    const migrationComplete = usersWithWebvh === totalUsers;
    if (migrationComplete) {
      console.log('  ✅ All users have been migrated to did:webvh');
    } else {
      const remaining = totalUsers - usersWithWebvh;
      console.log(`  ⚠️  ${remaining} users still need did:webvh`);
      console.log(`  Progress: ${usersWithWebvh}/${totalUsers} (${((usersWithWebvh / totalUsers) * 100).toFixed(1)}%)`);
    }
    console.log();

    // Recommendations
    console.log('Recommendations:');
    if (!webvhEnabled && migrationComplete) {
      console.log('  ✅ All users migrated. Consider enabling AUTH_DID_WEBVH_ENABLED=true');
    } else if (webvhEnabled && !migrationComplete) {
      console.log('  ⚠️  DID:WebVH is enabled but migration is incomplete');
      console.log('     Run: bun run server/backfill-did-webvh.ts --execute');
    } else if (!webvhEnabled && !migrationComplete) {
      console.log('  1. Run backfill: bun run server/backfill-did-webvh.ts --execute');
      console.log('  2. Enable feature flag: export AUTH_DID_WEBVH_ENABLED=true');
    } else {
      console.log('  ✅ System is properly configured');
    }
    console.log();
    console.log('='.repeat(80));
  } catch (error) {
    console.error('❌ Error getting status:', error);
    process.exit(1);
  }
}

/**
 * Enable/disable DID:WebVH cutover
 */
async function cutover(action: 'enable' | 'disable'): Promise<void> {
  console.log(`${action === 'enable' ? 'Enabling' : 'Disabling'} DID:WebVH cutover`);
  console.log();

  const correlationId = `cli-cutover-${Date.now()}`;

  try {
    if (action === 'enable') {
      // Check migration status first
      const allUsers = await getAllUsers();
      const totalUsers = allUsers.length;
      const usersWithWebvh = allUsers.filter(u => u.did_webvh).length;
      const migrationComplete = usersWithWebvh === totalUsers;

      if (!migrationComplete) {
        console.log('⚠️  WARNING: Not all users have been migrated to did:webvh');
        console.log(`   ${usersWithWebvh}/${totalUsers} users migrated (${((usersWithWebvh / totalUsers) * 100).toFixed(1)}%)`);
        console.log();
        console.log('Recommendations:');
        console.log('  1. Complete the migration first: bun run server/backfill-did-webvh.ts --execute');
        console.log('  2. Ensure dual-read is enabled for gradual rollout');
        console.log();
        console.log('To proceed anyway, set: export AUTH_DID_WEBVH_ENABLED=true');
        process.exit(1);
      }

      console.log('✅ All users have been migrated');
      console.log();
      console.log('To enable DID:WebVH, set the following environment variable:');
      console.log('  export AUTH_DID_WEBVH_ENABLED=true');
      console.log();
      console.log('To restart the server with the new setting:');
      console.log('  bun run dev');
    } else {
      console.log('To disable DID:WebVH, set the following environment variable:');
      console.log('  export AUTH_DID_WEBVH_ENABLED=false');
      console.log();
      console.log('To restart the server with the new setting:');
      console.log('  bun run dev');
    }

    auditLog('cli.cutover', {
      action,
      correlationId
    });
  } catch (error) {
    console.error('❌ Error during cutover:', error);
    process.exit(1);
  }
}

/**
 * Get all users from storage
 */
async function getAllUsers(): Promise<any[]> {
  const memStorage = storage as any;
  if (memStorage.users && memStorage.users instanceof Map) {
    return Array.from(memStorage.users.values());
  }
  return [];
}

/**
 * Show help
 */
function showHelp(): void {
  console.log(`
DID:WebVH Admin CLI

Usage:
  bun run server/cli-did-admin.ts <command> [options]

Commands:
  create <user-id>          Create did:webvh for a specific user
  validate <did>            Validate a did:webvh identifier
  status                    Show current migration status
  cutover --enable          Enable DID:WebVH (after migration complete)
  cutover --disable         Disable DID:WebVH (rollback)

Examples:
  # Check migration status
  bun run server/cli-did-admin.ts status

  # Create DID for a user
  bun run server/cli-did-admin.ts create did:privy:cltest123

  # Validate a DID
  bun run server/cli-did-admin.ts validate did:webvh:localhost%3A5000:u-abc123

  # Enable DID:WebVH after migration
  bun run server/cli-did-admin.ts cutover --enable

  # Disable DID:WebVH (rollback)
  bun run server/cli-did-admin.ts cutover --disable
  `);
}

// Parse and execute command
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case 'create':
      if (!args[1]) {
        console.error('❌ Error: user-id is required');
        console.log('Usage: bun run server/cli-did-admin.ts create <user-id>');
        process.exit(1);
      }
      createDID(args[1])
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;

    case 'validate':
      if (!args[1]) {
        console.error('❌ Error: DID is required');
        console.log('Usage: bun run server/cli-did-admin.ts validate <did>');
        process.exit(1);
      }
      validateDID(args[1])
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;

    case 'status':
      showStatus()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;

    case 'cutover':
      if (!args[1] || (args[1] !== '--enable' && args[1] !== '--disable')) {
        console.error('❌ Error: --enable or --disable is required');
        console.log('Usage: bun run server/cli-did-admin.ts cutover --enable|--disable');
        process.exit(1);
      }
      const action = args[1] === '--enable' ? 'enable' : 'disable';
      cutover(action)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      break;

    default:
      console.error(`❌ Error: Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}
