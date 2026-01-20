#!/usr/bin/env node
/**
 * CLI Migrate Command
 * 
 * Migrates a CEL asset between layers in the Originals Protocol.
 * 
 * Migration paths:
 * - peer → webvh: Requires --domain
 * - webvh → btco: Requires --wallet
 * 
 * Usage: originals-cel migrate --log <path> --to <layer> [options]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EventLog, DataIntegrityProof } from '../types';
import { WebVHCelManager } from '../layers/WebVHCelManager';
import { BtcoCelManager } from '../layers/BtcoCelManager';
import type { CelSigner } from '../layers/PeerCelManager';
import { parseEventLogJson } from '../serialization/json';
import { parseEventLogCbor } from '../serialization/cbor';
import { serializeEventLogJson } from '../serialization/json';
import { serializeEventLogCbor } from '../serialization/cbor';
import { multikey } from '../../crypto/Multikey';

/**
 * Flags parsed from command line arguments
 */
export interface MigrateFlags {
  log?: string;
  to?: string;
  domain?: string;
  wallet?: string;
  output?: string;
  format?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the migrate command
 */
export interface MigrateResult {
  success: boolean;
  message: string;
  log?: EventLog;
  sourceDid?: string;
  targetDid?: string;
  targetLayer?: string;
}

/**
 * Valid target layers for migration
 */
const VALID_LAYERS = ['webvh', 'btco'] as const;
type TargetLayer = typeof VALID_LAYERS[number];

/**
 * Loads and parses an event log from a file
 * Supports both JSON (.json) and CBOR (.cbor) formats
 */
function loadEventLog(filePath: string): EventLog {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath);
  
  if (ext === '.cbor') {
    // Parse as CBOR binary
    return parseEventLogCbor(new Uint8Array(content));
  } else {
    // Default to JSON parsing
    return parseEventLogJson(content.toString('utf-8'));
  }
}

/**
 * Detects the current layer from an event log by examining events
 */
function detectCurrentLayer(log: EventLog): 'peer' | 'webvh' | 'btco' {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot detect layer from empty event log');
  }

  let currentLayer: 'peer' | 'webvh' | 'btco' = 'peer';

  for (const event of log.events) {
    const data = event.data as Record<string, unknown>;
    
    if (event.type === 'create' && data.layer) {
      currentLayer = data.layer as 'peer' | 'webvh' | 'btco';
    } else if (event.type === 'update' && data.layer && data.targetDid) {
      // This is a migration event
      currentLayer = data.layer as 'peer' | 'webvh' | 'btco';
    }
  }

  return currentLayer;
}

/**
 * Extracts the current DID from an event log
 */
function getCurrentDid(log: EventLog): string {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot extract DID from empty event log');
  }

  let currentDid: string | undefined;

  for (const event of log.events) {
    const data = event.data as Record<string, unknown>;
    
    if (event.type === 'create' && data.did) {
      currentDid = data.did as string;
    } else if (event.type === 'update' && data.targetDid) {
      // This is a migration event
      currentDid = data.targetDid as string;
    }
  }

  if (!currentDid) {
    throw new Error('Could not determine current DID from event log');
  }

  return currentDid;
}

/**
 * Validates the migration path
 */
function validateMigrationPath(currentLayer: string, targetLayer: TargetLayer): void {
  if (currentLayer === 'btco') {
    throw new Error('Cannot migrate from btco layer - it is the final layer');
  }
  
  if (currentLayer === 'peer' && targetLayer === 'btco') {
    throw new Error('Cannot migrate directly from peer to btco. Must migrate to webvh first.');
  }
  
  if (currentLayer === 'webvh' && targetLayer === 'webvh') {
    throw new Error('Asset is already at webvh layer');
  }
  
  if (currentLayer === targetLayer) {
    throw new Error(`Asset is already at ${targetLayer} layer`);
  }
}

/**
 * Loads an Ed25519 private key from a wallet file
 * Supports both raw multibase format and JSON format { privateKey: "z..." }
 */
async function loadWalletKey(walletPath: string): Promise<{ privateKey: string; publicKey: string }> {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }
  
  const content = fs.readFileSync(walletPath, 'utf-8').trim();
  
  let privateKey: string;
  
  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(content);
    if (parsed.privateKey) {
      privateKey = parsed.privateKey;
    } else {
      throw new Error('JSON wallet file must contain "privateKey" field');
    }
  } catch (e) {
    // Not JSON, treat as raw multibase key
    if (content.startsWith('z')) {
      privateKey = content;
    } else {
      throw new Error('Wallet file must contain a z-base58btc multibase-encoded Ed25519 private key');
    }
  }
  
  // Validate and decode to get public key
  const decoded = multikey.decodePrivateKey(privateKey);
  if (decoded.type !== 'Ed25519') {
    throw new Error(`Expected Ed25519 key, got ${decoded.type}`);
  }
  
  // Derive public key from private key
  const ed25519 = await import('@noble/ed25519');
  const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(decoded.key);
  const publicKey = multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519');
  
  return { privateKey, publicKey };
}

/**
 * Creates a signer function from a private key
 */
function createSigner(privateKey: string, publicKey: string): CelSigner {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    const ed25519 = await import('@noble/ed25519');
    const decoded = multikey.decodePrivateKey(privateKey);
    
    // Serialize data for signing (deterministic JSON)
    const dataStr = JSON.stringify(data, Object.keys(data as object).sort());
    const dataBytes = new TextEncoder().encode(dataStr);
    
    // Sign the data
    const signature = await (ed25519 as any).signAsync(dataBytes, decoded.key);
    const proofValue = multikey.encodeMultibase(new Uint8Array(signature));
    
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: `did:key:${publicKey}#${publicKey}`,
      proofPurpose: 'assertionMethod',
      proofValue,
    };
  };
}

/**
 * Creates a mock BitcoinManager for testing/development
 * In production, this would be a real BitcoinManager instance
 */
function createMockBitcoinManager(): any {
  // For CLI use, we create a minimal mock that satisfies the interface
  // Real Bitcoin integration requires additional configuration
  return {
    inscribeData: async (data: unknown) => {
      // Generate mock Bitcoin transaction details
      const timestamp = Date.now();
      const mockTxid = `cli_mock_tx_${timestamp.toString(16)}`;
      const mockInscriptionId = `cli_mock_inscription_${timestamp.toString(16)}i0`;
      
      console.error('\n⚠️  Note: Using mock Bitcoin manager for CLI migration.');
      console.error('    For real Bitcoin inscriptions, use the SDK programmatically.\n');
      
      return {
        txid: mockTxid,
        inscriptionId: mockInscriptionId,
        satoshi: 10000,
        blockHeight: 0, // Will be set when confirmed
      };
    },
    getInscription: async (inscriptionId: string) => {
      return { inscriptionId, confirmed: false };
    },
  };
}

/**
 * Execute the migrate command
 */
export async function migrateCommand(flags: MigrateFlags): Promise<MigrateResult> {
  // Check for help flag
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }
  
  // Validate required arguments
  if (!flags.log) {
    return {
      success: false,
      message: 'Error: --log is required. Usage: originals-cel migrate --log <path> --to <layer>',
    };
  }
  
  if (!flags.to) {
    return {
      success: false,
      message: 'Error: --to is required. Valid layers: webvh, btco',
    };
  }
  
  // Validate target layer
  const targetLayer = flags.to.toLowerCase() as TargetLayer;
  if (!VALID_LAYERS.includes(targetLayer)) {
    return {
      success: false,
      message: `Error: Invalid target layer "${flags.to}". Valid layers: webvh, btco`,
    };
  }
  
  // Validate layer-specific requirements
  if (targetLayer === 'webvh' && !flags.domain) {
    return {
      success: false,
      message: 'Error: --domain is required for webvh migration. Usage: originals-cel migrate --log <path> --to webvh --domain example.com',
    };
  }
  
  if (targetLayer === 'btco' && !flags.wallet) {
    return {
      success: false,
      message: 'Error: --wallet is required for btco migration. Usage: originals-cel migrate --log <path> --to btco --wallet ./wallet.key',
    };
  }
  
  // Load the event log
  let eventLog: EventLog;
  try {
    eventLog = loadEventLog(flags.log);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to load event log: ${(e as Error).message}`,
    };
  }
  
  // Detect current layer and validate migration path
  let currentLayer: 'peer' | 'webvh' | 'btco';
  try {
    currentLayer = detectCurrentLayer(eventLog);
    validateMigrationPath(currentLayer, targetLayer);
  } catch (e) {
    return {
      success: false,
      message: `Error: Invalid migration path: ${(e as Error).message}`,
    };
  }
  
  // Get source DID
  let sourceDid: string;
  try {
    sourceDid = getCurrentDid(eventLog);
  } catch (e) {
    return {
      success: false,
      message: `Error: ${(e as Error).message}`,
    };
  }
  
  // Load wallet key for signing
  let privateKey: string;
  let publicKey: string;
  
  if (flags.wallet) {
    try {
      const loaded = await loadWalletKey(flags.wallet);
      privateKey = loaded.privateKey;
      publicKey = loaded.publicKey;
    } catch (e) {
      return {
        success: false,
        message: `Error: Failed to load wallet: ${(e as Error).message}`,
      };
    }
  } else {
    // Generate temporary key for signing (for webvh migration without wallet)
    const ed25519 = await import('@noble/ed25519');
    const privateKeyBytes = ed25519.utils.randomPrivateKey();
    const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
    privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
    publicKey = multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519');
    
    console.error('\n⚠️  Generated temporary signing key. Save the key below for future operations:');
    console.error(`Private Key: ${privateKey}`);
    console.error(`Public Key:  ${publicKey}\n`);
  }
  
  // Create signer
  const signer = createSigner(privateKey, publicKey);
  
  // Perform migration
  let migratedLog: EventLog;
  let targetDid: string;
  
  try {
    if (targetLayer === 'webvh') {
      // Migrate to webvh layer
      const manager = new WebVHCelManager(signer, flags.domain!, []);
      migratedLog = await manager.migrate(eventLog);
      
      // Extract target DID from migration event
      const migrationEvent = migratedLog.events[migratedLog.events.length - 1];
      const migrationData = migrationEvent.data as Record<string, unknown>;
      targetDid = migrationData.targetDid as string;
      
    } else if (targetLayer === 'btco') {
      // Migrate to btco layer
      const bitcoinManager = createMockBitcoinManager();
      const manager = new BtcoCelManager(signer, bitcoinManager);
      migratedLog = await manager.migrate(eventLog);
      
      // Extract target DID from migration event
      const migrationEvent = migratedLog.events[migratedLog.events.length - 1];
      const migrationData = migrationEvent.data as Record<string, unknown>;
      targetDid = migrationData.targetDid as string;
      
    } else {
      return {
        success: false,
        message: `Error: Unknown target layer: ${targetLayer}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      message: `Error: Migration failed: ${(e as Error).message}`,
    };
  }
  
  // Determine output format
  const format = (flags.format || 'json').toLowerCase();
  if (format !== 'json' && format !== 'cbor') {
    return {
      success: false,
      message: 'Error: --format must be "json" or "cbor"',
    };
  }
  
  // Serialize output
  let output: string | Uint8Array;
  try {
    if (format === 'cbor') {
      output = serializeEventLogCbor(migratedLog);
    } else {
      output = serializeEventLogJson(migratedLog);
    }
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to serialize event log: ${(e as Error).message}`,
    };
  }
  
  // Write output
  if (flags.output) {
    try {
      if (format === 'cbor') {
        fs.writeFileSync(flags.output, output as Uint8Array);
      } else {
        fs.writeFileSync(flags.output, output as string, 'utf-8');
      }
    } catch (e) {
      return {
        success: false,
        message: `Error: Failed to write output file: ${(e as Error).message}`,
      };
    }
  } else {
    // Write to stdout
    if (format === 'cbor') {
      // For CBOR, output as base64 to stdout since it's binary
      const base64 = Buffer.from(output as Uint8Array).toString('base64');
      process.stdout.write(base64);
    } else {
      process.stdout.write(output as string);
    }
  }
  
  // Build success message
  const layerTransition = `${currentLayer} → ${targetLayer}`;
  const outputInfo = flags.output ? ` and saved to ${flags.output}` : '';
  
  console.error(`\n✅ Migration complete: ${layerTransition}`);
  console.error(`   Source DID: ${sourceDid}`);
  console.error(`   Target DID: ${targetDid}${outputInfo}\n`);
  
  return {
    success: true,
    message: `Migration complete: ${layerTransition}`,
    log: migratedLog,
    sourceDid,
    targetDid,
    targetLayer,
  };
}
