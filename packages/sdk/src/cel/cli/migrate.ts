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
import type { EventLog, DataIntegrityProof } from '../types.js';
import { WebVHCelManager } from '../layers/WebVHCelManager.js';
import { BtcoCelManager } from '../layers/BtcoCelManager.js';
import type { CelSigner } from '../layers/PeerCelManager.js';
import { parseEventLogJson } from '../serialization/json.js';
import { parseEventLogCbor } from '../serialization/cbor.js';
import { serializeEventLogJson } from '../serialization/json.js';
import { serializeEventLogCbor } from '../serialization/cbor.js';
import { multikey } from '../../crypto/Multikey.js';
import { canonicalizeEvent } from '../canonicalize.js';
import { btcoDidFromSatoshi } from '../btcoDid.js';
import { deriveDidCel } from '../celDid.js';

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
    } else if (event.type === 'migrate' && data.layer) {
      // Type-first: first-class 'migrate' events are migrations by type.
      currentLayer = data.layer as 'peer' | 'webvh' | 'btco';
    } else if (event.type === 'update' && data.layer && data.sourceDid && data.migratedAt) {
      // Legacy sniff kept verbatim: old logs record migrations as 'update'
      // events. Detect via sourceDid + migratedAt (present
      // on both webvh and btco migrations, and reserved from regular updates);
      // btco migrations don't carry targetDid, so keying off targetDid left
      // btco logs mis-detected as webvh and bypassed the "cannot migrate from
      // btco" guard, while requiring migratedAt keeps regular updates carrying
      // application-level sourceDid/layer fields from being misclassified.
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

    if (event.type === 'create') {
      // Dual-read the genesis: a new-shape genesis (`controller` present)
      // derives its identity (did:cel); a legacy genesis embeds `did`.
      if (data.did) {
        currentDid = data.did as string;
      } else if (data.controller !== undefined) {
        currentDid = deriveDidCel(log);
      }
    } else if (event.type === 'migrate' && data.layer) {
      // Type-first: first-class 'migrate' events are migrations by type.
      currentDid = resolveMigrationDid(event, data) ?? currentDid;
    } else if (event.type === 'update' && data.sourceDid && data.layer && data.migratedAt) {
      // Legacy sniff kept verbatim. webvh migrations carry the resolvable
      // targetDid; btco migrations derive did:btco:<satoshi> from the bitcoin
      // witness proof (the satoshi is only known after inscription, so it
      // isn't in the signed data).
      currentDid = resolveMigrationDid(event, data) ?? currentDid;
    }
  }

  if (!currentDid) {
    throw new Error('Could not determine current DID from event log');
  }

  return currentDid;
}

/**
 * Derives the resolvable DID for a migration event: the targetDid for webvh,
 * or did:btco:<satoshi> (from the bitcoin-ordinals-2024 witness proof) for btco.
 */
function resolveMigrationDid(event: EventLog['events'][number], data: Record<string, unknown>): string | undefined {
  if (data.layer === 'btco') {
    const proof = (event.proof as ReadonlyArray<unknown> | undefined)?.find(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
    );
    const satoshi = proof?.satoshi;
    if (satoshi !== undefined && satoshi !== null) {
      // Network-scoped identifier: the network is recorded in the SIGNED
      // migration data (BtcoMigrationData.network), so the CLI derives the
      // same sig/reg-prefixed DID as state derivation. Legacy logs without a
      // recorded network default to the bare mainnet form.
      return btcoDidFromSatoshi(satoshi as string | number, data.network as string | undefined);
    }
  }
  return data.targetDid as string | undefined;
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
    
    // Serialize data for signing using canonical JCS serialization
    const dataBytes = canonicalizeEvent(data);
    
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
    network: 'mainnet',
    inscribeData: async (data: unknown) => {
      // Generate mock Bitcoin transaction details
      const timestamp = Date.now();
      const mockTxid = `cli_mock_tx_${timestamp.toString(16)}`;
      const mockInscriptionId = `cli_mock_inscription_${timestamp.toString(16)}i0`;
      const satoshi = 10000;

      // BtcoCelManager pins the sat first: it inscribes via a buildContent(satoshi)
      // callback so the migrate body can sign `to: did:btco:<sat>`. Invoke it with
      // the satoshi we will return (mirrors OrdMockProvider/BitcoinManager).
      if (typeof data === 'function') {
        await (data as (s: string) => Buffer | Promise<Buffer>)(String(satoshi));
      }

      console.error('\n⚠️  Note: Using mock Bitcoin manager for CLI migration.');
      console.error('    For real Bitcoin inscriptions, use the SDK programmatically.\n');

      return {
        txid: mockTxid,
        inscriptionId: mockInscriptionId,
        satoshi,
        blockHeight: 0, // Will be set when confirmed
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
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
    const privateKeyBytes = ed25519.utils.randomSecretKey();
    const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
    privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
    publicKey = multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519');

    // Never print the private key to a shared stream (stderr lands in shell
    // history, terminal transcripts, and CI logs). Write it to an owner-only
    // file and report the path instead.
    const keyBase = flags.output || flags.wallet || 'cel-migrate';
    const keyPath = `${keyBase}.key`;
    fs.writeFileSync(keyPath, JSON.stringify({ privateKey, publicKey }, null, 2), { mode: 0o600 });
    console.error('\n⚠️  Generated a temporary signing key for this migration.');
    console.error(
      'This key is NOT the log\'s controller key, so verifyEventLog will reject the resulting ' +
      "log (controller binding). To produce a verifiable log, re-run with --wallet pointing at the " +
      'key that created the log.'
    );
    console.error(`Temporary private key written to ${keyPath} (mode 0600 — keep it secret).`);
    console.error(`Public Key:  ${publicKey}`);
    console.error(`To reuse this key, run with --wallet ${keyPath}\n`);
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

      // The resolvable did:btco:<satoshi> is derived from the bitcoin witness
      // proof (the satoshi is only known after inscription), surfaced via
      // the derived state — not from the signed event data.
      targetDid = manager.getCurrentState(migratedLog).did;

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
