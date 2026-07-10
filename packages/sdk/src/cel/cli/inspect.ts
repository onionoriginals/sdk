#!/usr/bin/env node
/**
 * CLI Inspect Command
 * 
 * Inspects a CEL event log in human-readable format.
 * Displays event timeline, current state, witness attestations, and layer history.
 * 
 * Usage: originals-cel inspect --log <path> [options]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EventLog, LogEntry, DataIntegrityProof, WitnessProof, AssetState, ExternalReference } from '../types.js';
import { parseEventLogJson } from '../serialization/json.js';
import { parseEventLogCbor } from '../serialization/cbor.js';
import { btcoDidFromSatoshi } from '../btcoDid.js';
import { deriveDidCel } from '../celDid.js';

/**
 * Flags parsed from command line arguments
 */
export interface InspectFlags {
  log?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the inspect command
 */
export interface InspectResult {
  success: boolean;
  message: string;
  state?: AssetState;
}

/**
 * Migration event data structure
 */
interface MigrationData {
  sourceDid?: string;
  targetDid?: string;
  layer?: string;
  domain?: string;
  migratedAt?: string;
  txid?: string;
  inscriptionId?: string;
}

/**
 * Check if a proof is a WitnessProof (has witnessedAt field)
 */
function isWitnessProof(proof: DataIntegrityProof | WitnessProof): proof is WitnessProof {
  return 'witnessedAt' in proof && typeof (proof).witnessedAt === 'string';
}

/**
 * LEGACY-ONLY sniff: detects migrations recorded as `update`-typed events
 * (pre-first-class-`migrate` logs). Kept verbatim as the fallback; new logs
 * are detected type-first via `event.type === 'migrate'`.
 */
function isMigrationEvent(data: unknown): data is MigrationData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    ('sourceDid' in d && 'targetDid' in d) ||
    ('layer' in d && typeof d.layer === 'string' && ['peer', 'webvh', 'btco'].includes(d.layer))
  );
}

/**
 * Derives the resolvable DID for a migration event: the targetDid when the
 * signed data carries one (webvh), or did:btco:<satoshi> from the
 * bitcoin-ordinals-2024 witness proof (btco — the satoshi is only known
 * after inscription, so it isn't in the signed data).
 */
function resolveMigrationDid(event: LogEntry, data: Record<string, unknown>): string | undefined {
  if (data.layer === 'btco') {
    const proof = (event.proof as ReadonlyArray<unknown> | undefined)?.find(
      (p): p is Record<string, unknown> =>
        !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
    );
    const satoshi = proof?.satoshi;
    if (satoshi !== undefined && satoshi !== null) {
      // Network-scoped identifier read from the SIGNED migration data;
      // legacy logs without one default to the bare mainnet form.
      return btcoDidFromSatoshi(satoshi as string | number, data.network as string | undefined);
    }
  }
  return data.targetDid as string | undefined;
}

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
 * Format a timestamp for display
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return timestamp;
  }
}

/**
 * Format ISO timestamp to relative time
 */
function formatRelativeTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 30) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return formatTimestamp(timestamp);
  } catch {
    return timestamp;
  }
}

/**
 * Truncate long strings for display
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Format DID for display (truncate middle)
 */
function formatDid(did: string): string {
  if (did.length <= 50) return did;
  return did.substring(0, 25) + '...' + did.substring(did.length - 15);
}

/**
 * Get event type badge
 */
function getEventBadge(type: string): string {
  switch (type) {
    case 'create': return '🆕 CREATE';
    case 'update': return '✏️  UPDATE';
    case 'migrate': return '🗺️  MIGRATE';
    case 'transfer': return '🔁 TRANSFER';
    case 'rotateKey': return '🔑 ROTATEKEY';
    case 'deactivate': return '🔒 DEACTIVATE';
    default: return `📋 ${type.toUpperCase()}`;
  }
}

/**
 * Get layer badge
 */
function getLayerBadge(layer: string): string {
  switch (layer) {
    case 'peer': return '🏠 Peer (Layer 0)';
    case 'webvh': return '🌐 WebVH (Layer 1)';
    case 'btco': return '₿ Bitcoin (Layer 2)';
    default: return layer;
  }
}

/**
 * Derive current state from event log (simplified version)
 */
function deriveCurrentState(log: EventLog): AssetState {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot derive state from empty event log');
  }

  const createEvent = log.events[0];
  if (createEvent.type !== 'create') {
    throw new Error('First event must be a create event');
  }

  // Dual-read the genesis. New shape (`controller` present): the asset DID is
  // DERIVED (did:cel), the creator is sourced from the controller, layer is
  // definitionally 'peer'. Legacy shape (`did` present): read verbatim.
  const createData = createEvent.data as Record<string, unknown>;
  const isNewShapeGenesis = createData.controller !== undefined;

  // Initialize state from create event
  const state: AssetState = {
    did: isNewShapeGenesis ? deriveDidCel(log) : ((createData.did as string) || 'unknown'),
    name: createData.name as string,
    layer: (createData.layer as 'peer' | 'webvh' | 'btco') || 'peer',
    resources: (createData.resources as ExternalReference[]) || [],
    creator: (createData.creator as string | undefined) ?? (createData.controller as string | undefined),
    controller: createData.controller as string | undefined,
    createdAt: createData.createdAt as string,
    updatedAt: undefined,
    deactivated: false,
    metadata: {},
  };

  // Apply subsequent events
  for (let i = 1; i < log.events.length; i++) {
    const event = log.events[i];

    if (event.type === 'update') {
      const updateData = event.data as Record<string, unknown>;

      // Update known fields
      if (updateData.name !== undefined) state.name = updateData.name as string;
      if (updateData.resources !== undefined) state.resources = updateData.resources as ExternalReference[];
      if (updateData.updatedAt !== undefined) state.updatedAt = updateData.updatedAt as string;
      if (updateData.did !== undefined) state.did = updateData.did as string;
      if (updateData.targetDid !== undefined) state.did = updateData.targetDid as string;
      if (updateData.layer !== undefined) state.layer = updateData.layer as 'peer' | 'webvh' | 'btco';

      // Store migration data in metadata (legacy update-sniffed migrations)
      if (isMigrationEvent(updateData)) {
        state.metadata = state.metadata || {};
        if (updateData.sourceDid) state.metadata.sourceDid = updateData.sourceDid;
        if (updateData.domain) state.metadata.domain = updateData.domain;
        if (updateData.txid) state.metadata.txid = updateData.txid;
        if (updateData.inscriptionId) state.metadata.inscriptionId = updateData.inscriptionId;
      }

      // Store other fields in metadata
      for (const [key, value] of Object.entries(updateData)) {
        if (!['name', 'resources', 'updatedAt', 'did', 'targetDid', 'layer', 'creator', 'createdAt', 'sourceDid', 'domain', 'txid', 'inscriptionId'].includes(key)) {
          state.metadata = state.metadata || {};
          state.metadata[key] = value;
        }
      }
    } else if (event.type === 'migrate') {
      // First-class migration event: layer transition with the same payload
      // fields legacy update-sniffed migrations carried. For btco the
      // resolvable DID comes from the bitcoin witness proof's satoshi.
      const migrationData = event.data as Record<string, unknown>;
      const migratedDid = resolveMigrationDid(event, migrationData);
      if (migratedDid !== undefined) state.did = migratedDid;
      if (migrationData.layer !== undefined) state.layer = migrationData.layer as 'peer' | 'webvh' | 'btco';
      if (migrationData.migratedAt !== undefined) state.updatedAt = migrationData.migratedAt as string;

      state.metadata = state.metadata || {};
      if (migrationData.sourceDid !== undefined) state.metadata.sourceDid = migrationData.sourceDid;
      if (migrationData.domain !== undefined) state.metadata.domain = migrationData.domain;
      // Bitcoin details live in the witness proof (added after signing).
      const bitcoinProof = (event.proof as ReadonlyArray<unknown> | undefined)?.find(
        (p): p is Record<string, unknown> =>
          !!p && typeof p === 'object' && (p as Record<string, unknown>).cryptosuite === 'bitcoin-ordinals-2024'
      );
      if (bitcoinProof?.txid !== undefined) state.metadata.txid = bitcoinProof.txid;
      if (bitcoinProof?.inscriptionId !== undefined) state.metadata.inscriptionId = bitcoinProof.inscriptionId;
    } else if (event.type === 'transfer') {
      // Ownership hand-off: surface the owners; identity (did) is unchanged.
      const transferData = event.data as Record<string, unknown>;
      if (transferData.transferredAt !== undefined) state.updatedAt = transferData.transferredAt as string;
      state.metadata = state.metadata || {};
      if (transferData.previousOwner !== undefined) state.metadata.previousOwner = transferData.previousOwner;
      if (transferData.newOwner !== undefined) state.metadata.newOwner = transferData.newOwner;
      if (transferData.txid !== undefined) state.metadata.txid = transferData.txid;
    } else if (event.type === 'rotateKey') {
      // Authority hand-off: the last rotation's newController is current.
      const rotationData = event.data as Record<string, unknown>;
      if (typeof rotationData?.newController === 'string') state.controller = rotationData.newController;
      if (typeof rotationData?.rotatedAt === 'string') state.updatedAt = rotationData.rotatedAt;
    } else if (event.type === 'deactivate') {
      state.deactivated = true;
      const deactivateData = event.data as Record<string, unknown>;
      if (deactivateData.deactivatedAt !== undefined) {
        state.updatedAt = deactivateData.deactivatedAt as string;
      }
      if (deactivateData.reason !== undefined) {
        state.metadata = state.metadata || {};
        state.metadata.deactivationReason = deactivateData.reason;
      }
    }
  }

  return state;
}

/**
 * Extract layer history from events
 */
function extractLayerHistory(log: EventLog): Array<{ layer: string; timestamp: string; did?: string }> {
  const history: Array<{ layer: string; timestamp: string; did?: string }> = [];
  
  for (const event of log.events) {
    const data = event.data as Record<string, unknown>;

    if (event.type === 'create') {
      // New-shape genesis carries neither layer (definitionally 'peer') nor
      // did (derived did:cel); legacy genesis embeds both.
      history.push({
        layer: (data.layer as string) || 'peer',
        timestamp: (data.createdAt as string) || event.proof[0]?.created || 'unknown',
        did: (data.did as string | undefined) ??
          (data.controller !== undefined ? deriveDidCel(log) : undefined),
      });
    }

    if (event.type === 'migrate') {
      // Type-first: first-class migration event.
      history.push({
        layer: (data.layer as string) ?? 'unknown',
        timestamp: (data.migratedAt as string) ?? event.proof[0]?.created ?? 'unknown',
        did: resolveMigrationDid(event, data) ?? 'unknown',
      });
    } else if (event.type === 'update' && isMigrationEvent(event.data)) {
      // Legacy sniff kept verbatim.
      const migrationData = event.data;
      history.push({
        layer: migrationData.layer ?? 'unknown',
        timestamp: migrationData.migratedAt ?? event.proof[0]?.created ?? 'unknown',
        did: migrationData.targetDid ?? 'unknown',
      });
    }
  }

  return history;
}

/**
 * Extract all witness attestations from the log
 */
function extractWitnesses(log: EventLog): Array<{
  eventIndex: number;
  eventType: string;
  witnessedAt: string;
  cryptosuite: string;
  verificationMethod: string;
}> {
  const witnesses: Array<{
    eventIndex: number;
    eventType: string;
    witnessedAt: string;
    cryptosuite: string;
    verificationMethod: string;
  }> = [];
  
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    for (const proof of event.proof) {
      if (isWitnessProof(proof)) {
        witnesses.push({
          eventIndex: i,
          eventType: event.type,
          witnessedAt: proof.witnessedAt,
          cryptosuite: proof.cryptosuite,
          verificationMethod: proof.verificationMethod,
        });
      }
    }
  }
  
  return witnesses;
}

/**
 * Output the inspection result to stdout
 */
function outputInspection(log: EventLog, state: AssetState): void {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CEL Event Log Inspector');
  console.log('═══════════════════════════════════════════════════════\n');

  // ─────────────────────────────────────────────────────────
  // Current State Section
  // ─────────────────────────────────────────────────────────
  console.log('📦 CURRENT STATE');
  console.log('───────────────────────────────────────────────────────');
  
  // Status badge
  if (state.deactivated) {
    console.log(`   Status: 🔒 DEACTIVATED`);
    if (state.metadata?.deactivationReason) {
      console.log(`   Reason: ${String(state.metadata.deactivationReason)}`);
    }
  } else {
    console.log(`   Status: ✅ ACTIVE`);
  }
  
  console.log(`   Name:   ${state.name || '(unnamed)'}`);
  console.log(`   Layer:  ${getLayerBadge(state.layer)}`);
  console.log(`   DID:    ${formatDid(state.did)}`);
  
  if (state.creator) {
    console.log(`   Creator: ${formatDid(state.creator)}`);
  }
  
  if (state.createdAt) {
    console.log(`   Created: ${formatTimestamp(state.createdAt)} (${formatRelativeTime(state.createdAt)})`);
  }
  
  if (state.updatedAt) {
    console.log(`   Updated: ${formatTimestamp(state.updatedAt)} (${formatRelativeTime(state.updatedAt)})`);
  }
  
  // Resources
  if (state.resources && state.resources.length > 0) {
    console.log(`\n   📎 Resources (${state.resources.length}):`);
    for (let i = 0; i < state.resources.length; i++) {
      const res = state.resources[i];
      console.log(`      [${i + 1}] ${res.mediaType || 'unknown'}`);
      console.log(`          Hash: ${truncate(res.digestMultibase, 50)}`);
      if (res.url && res.url.length > 0) {
        console.log(`          URL:  ${res.url[0]}`);
      }
    }
  }
  
  // Additional metadata
  if (state.metadata && Object.keys(state.metadata).length > 0) {
    const displayKeys = Object.keys(state.metadata).filter(
      k => !['deactivationReason'].includes(k)
    );
    if (displayKeys.length > 0) {
      console.log(`\n   📋 Metadata:`);
      for (const key of displayKeys) {
        const value = state.metadata[key];
        const displayValue = typeof value === 'string' 
          ? truncate(value, 50)
          : JSON.stringify(value);
        console.log(`      ${key}: ${displayValue}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Layer History Section
  // ─────────────────────────────────────────────────────────
  const layerHistory = extractLayerHistory(log);
  if (layerHistory.length > 1) {
    console.log('\n\n🗺️  LAYER HISTORY');
    console.log('───────────────────────────────────────────────────────');
    
    for (let i = 0; i < layerHistory.length; i++) {
      const entry = layerHistory[i];
      const isLast = i === layerHistory.length - 1;
      const prefix = isLast ? '   └─' : '   ├─';
      console.log(`${prefix} ${getLayerBadge(entry.layer)}`);
      if (entry.timestamp) {
        console.log(`   ${isLast ? ' ' : '│'}     ${formatTimestamp(entry.timestamp)}`);
      }
      if (entry.did) {
        console.log(`   ${isLast ? ' ' : '│'}     ${formatDid(entry.did)}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Witness Attestations Section
  // ─────────────────────────────────────────────────────────
  const witnesses = extractWitnesses(log);
  if (witnesses.length > 0) {
    console.log('\n\n🔏 WITNESS ATTESTATIONS');
    console.log('───────────────────────────────────────────────────────');
    
    for (let i = 0; i < witnesses.length; i++) {
      const witness = witnesses[i];
      console.log(`\n   [${i + 1}] Event #${witness.eventIndex + 1} (${witness.eventType})`);
      console.log(`       Witnessed: ${formatTimestamp(witness.witnessedAt)}`);
      console.log(`       Cryptosuite: ${witness.cryptosuite}`);
      console.log(`       Witness: ${truncate(witness.verificationMethod, 50)}`);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Event Timeline Section
  // ─────────────────────────────────────────────────────────
  console.log('\n\n📜 EVENT TIMELINE');
  console.log('───────────────────────────────────────────────────────');
  
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const data = event.data as Record<string, unknown>;
    const isLast = i === log.events.length - 1;
    const prefix = isLast ? '└─' : '├─';
    const connector = isLast ? '  ' : '│ ';
    
    // Event header with type badge
    console.log(`\n ${prefix} ${getEventBadge(event.type)}`);
    
    // Timestamp from proof
    const timestamp = event.proof[0]?.created || data.createdAt || data.updatedAt || data.migratedAt || data.transferredAt || data.rotatedAt || data.deactivatedAt;
    if (timestamp) {
      console.log(` ${connector}   📅 ${formatTimestamp(timestamp as string)}`);
    }

    // Event-specific details
    if (event.type === 'create') {
      if (data.name) console.log(` ${connector}   Name: ${String(data.name)}`);
      if (data.did) console.log(` ${connector}   DID: ${formatDid(data.did as string)}`);
      if (data.controller) console.log(` ${connector}   Controller: ${formatDid(data.controller as string)}`);
      if (data.layer) console.log(` ${connector}   Layer: ${String(data.layer)}`);
      if (data.resources && Array.isArray(data.resources)) {
        console.log(` ${connector}   Resources: ${data.resources.length} file(s)`);
      }
    } else if (event.type === 'migrate') {
      // First-class migration event
      console.log(` ${connector}   Migrated to: ${(data.layer as string | undefined) ?? 'unknown'}`);
      if (data.sourceDid) console.log(` ${connector}   From: ${formatDid(data.sourceDid as string)}`);
      const migratedDid = resolveMigrationDid(event, data);
      if (migratedDid) console.log(` ${connector}   To:   ${formatDid(migratedDid)}`);
      if (data.domain) console.log(` ${connector}   Domain: ${data.domain as string}`);
    } else if (event.type === 'transfer') {
      if (data.previousOwner) console.log(` ${connector}   From: ${formatDid(data.previousOwner as string)}`);
      if (data.newOwner) console.log(` ${connector}   To:   ${formatDid(data.newOwner as string)}`);
    } else if (event.type === 'rotateKey') {
      if (data.previousController) console.log(` ${connector}   From: ${formatDid(data.previousController as string)}`);
      if (data.newController) console.log(` ${connector}   To:   ${formatDid(data.newController as string)}`);
    } else if (event.type === 'update') {
      // Show what changed
      const changes: string[] = [];
      if (data.name) changes.push(`name → "${String(data.name)}"`);
      if (data.resources) changes.push(`resources updated`);
      if (isMigrationEvent(event.data)) {
        const migrationData = event.data;
        changes.push(`migrated to ${migrationData.layer ?? 'unknown'}`);
        if (migrationData.domain) changes.push(`domain: ${migrationData.domain}`);
        if (migrationData.txid) changes.push(`txid: ${truncate(migrationData.txid, 20)}`);
      }
      
      if (changes.length > 0) {
        console.log(` ${connector}   Changes: ${changes.join(', ')}`);
      } else {
        // Show raw data keys
        const keys = Object.keys(data).filter(k => k !== 'updatedAt');
        if (keys.length > 0) {
          console.log(` ${connector}   Fields: ${keys.join(', ')}`);
        }
      }
    } else if (event.type === 'deactivate') {
      if (data.reason) console.log(` ${connector}   Reason: ${String(data.reason)}`);
    }
    
    // Proof summary
    const controllerProofs = event.proof.filter(p => !isWitnessProof(p));
    const witnessProofs = event.proof.filter(p => isWitnessProof(p));
    
    const proofParts: string[] = [];
    if (controllerProofs.length > 0) {
      proofParts.push(`${controllerProofs.length} controller`);
    }
    if (witnessProofs.length > 0) {
      proofParts.push(`${witnessProofs.length} witness`);
    }
    console.log(` ${connector}   🔐 Proofs: ${proofParts.join(', ')}`);
    
    // Hash chain link
    if (event.previousEvent) {
      console.log(` ${connector}   🔗 Chain: ${truncate(event.previousEvent, 40)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════\n');
}

/**
 * Execute the inspect command
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function inspectCommand(flags: InspectFlags): Promise<InspectResult> {
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
      message: 'Error: --log is required. Usage: originals-cel inspect --log <path>',
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
  
  // Derive current state
  let state: AssetState;
  try {
    state = deriveCurrentState(eventLog);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to derive state: ${(e as Error).message}`,
    };
  }
  
  // Output the inspection
  outputInspection(eventLog, state);
  
  return {
    success: true,
    message: 'Inspection complete',
    state,
  };
}
