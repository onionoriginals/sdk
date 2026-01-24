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
import type { EventLog, LogEntry, DataIntegrityProof, WitnessProof, AssetState, ExternalReference } from '../types';
import { parseEventLogJson } from '../serialization/json';
import { parseEventLogCbor } from '../serialization/cbor';

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
  return 'witnessedAt' in proof && typeof (proof as WitnessProof).witnessedAt === 'string';
}

/**
 * Check if event data contains migration information
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

  const createData = createEvent.data as Record<string, unknown>;
  
  // Initialize state from create event
  const state: AssetState = {
    did: (createData.did as string) || 'unknown',
    name: createData.name as string,
    layer: (createData.layer as 'peer' | 'webvh' | 'btco') || 'peer',
    resources: (createData.resources as ExternalReference[]) || [],
    creator: createData.creator as string,
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
      
      // Store migration data in metadata
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
    
    if (event.type === 'create' && data.layer) {
      history.push({
        layer: data.layer as string,
        timestamp: (data.createdAt as string) || event.proof[0]?.created || 'unknown',
        did: data.did as string,
      });
    }
    
    if (event.type === 'update' && isMigrationEvent(event.data)) {
      const migrationData = event.data as MigrationData;
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
      console.log(`   Reason: ${state.metadata.deactivationReason}`);
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
      const arrow = i > 0 ? ' ← ' : '';
      
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
    const timestamp = event.proof[0]?.created || data.createdAt || data.updatedAt || data.migratedAt || data.deactivatedAt;
    if (timestamp) {
      console.log(` ${connector}   📅 ${formatTimestamp(timestamp as string)}`);
    }
    
    // Event-specific details
    if (event.type === 'create') {
      if (data.name) console.log(` ${connector}   Name: ${data.name}`);
      if (data.did) console.log(` ${connector}   DID: ${formatDid(data.did as string)}`);
      if (data.layer) console.log(` ${connector}   Layer: ${data.layer}`);
      if (data.resources && Array.isArray(data.resources)) {
        console.log(` ${connector}   Resources: ${data.resources.length} file(s)`);
      }
    } else if (event.type === 'update') {
      // Show what changed
      const changes: string[] = [];
      if (data.name) changes.push(`name → "${data.name}"`);
      if (data.resources) changes.push(`resources updated`);
      if (isMigrationEvent(event.data)) {
        const migrationData = event.data as MigrationData;
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
      if (data.reason) console.log(` ${connector}   Reason: ${data.reason}`);
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
