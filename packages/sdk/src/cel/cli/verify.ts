#!/usr/bin/env node
/**
 * CLI Verify Command
 * 
 * Verifies a CEL event log by checking all proofs and the hash chain integrity.
 * Outputs event-by-event breakdown with witness attestation details.
 * 
 * Usage: originals-cel verify --log <path> [options]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EventLog, VerificationResult, DataIntegrityProof, WitnessProof } from '../types';
import { verifyEventLog } from '../algorithms/verifyEventLog';
import { parseEventLogJson } from '../serialization/json';
import { parseEventLogCbor } from '../serialization/cbor';

/**
 * Flags parsed from command line arguments
 */
export interface VerifyFlags {
  log?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the verify command
 */
export interface VerifyResult {
  success: boolean;
  message: string;
  verified?: boolean;
  result?: VerificationResult;
}

/**
 * Check if a proof is a WitnessProof (has witnessedAt field)
 */
function isWitnessProof(proof: DataIntegrityProof | WitnessProof): proof is WitnessProof {
  return 'witnessedAt' in proof && typeof (proof as WitnessProof).witnessedAt === 'string';
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
    return date.toISOString();
  } catch {
    return timestamp;
  }
}

/**
 * Format proof details for display
 */
function formatProofDetails(proof: DataIntegrityProof | WitnessProof, indent: string = '    '): string {
  const lines: string[] = [];
  lines.push(`${indent}Cryptosuite: ${proof.cryptosuite}`);
  lines.push(`${indent}Created: ${formatTimestamp(proof.created)}`);
  lines.push(`${indent}Verification Method: ${proof.verificationMethod}`);
  lines.push(`${indent}Proof Purpose: ${proof.proofPurpose}`);
  
  // Truncate proof value for display
  const truncatedProof = proof.proofValue.length > 60 
    ? `${proof.proofValue.substring(0, 57)}...` 
    : proof.proofValue;
  lines.push(`${indent}Proof Value: ${truncatedProof}`);
  
  // Add witness-specific info
  if (isWitnessProof(proof)) {
    lines.push(`${indent}🕐 Witnessed At: ${formatTimestamp(proof.witnessedAt)}`);
  }
  
  return lines.join('\n');
}

/**
 * Output verification result to stdout
 */
function outputResult(log: EventLog, result: VerificationResult): void {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CEL Event Log Verification Report');
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Overall result
  if (result.verified) {
    console.log('✅ VERIFICATION PASSED\n');
  } else {
    console.log('❌ VERIFICATION FAILED\n');
  }
  
  // Summary
  console.log(`📊 Summary:`);
  console.log(`   Total Events: ${result.events.length}`);
  const proofsPassed = result.events.filter(e => e.proofValid).length;
  const chainPassed = result.events.filter(e => e.chainValid).length;
  console.log(`   Proofs Valid: ${proofsPassed}/${result.events.length}`);
  console.log(`   Chain Valid:  ${chainPassed}/${result.events.length}`);
  
  // Count witness proofs
  let totalWitnessProofs = 0;
  for (const event of log.events) {
    for (const proof of event.proof) {
      if (isWitnessProof(proof)) {
        totalWitnessProofs++;
      }
    }
  }
  if (totalWitnessProofs > 0) {
    console.log(`   Witness Attestations: ${totalWitnessProofs}`);
  }
  console.log('');
  
  // Event-by-event breakdown
  console.log('📋 Event-by-Event Breakdown:');
  console.log('───────────────────────────────────────────────────────');
  
  for (let i = 0; i < result.events.length; i++) {
    const eventResult = result.events[i];
    const event = log.events[i];
    
    const proofIcon = eventResult.proofValid ? '✅' : '❌';
    const chainIcon = eventResult.chainValid ? '✅' : '❌';
    
    console.log(`\n  Event ${i + 1} (${eventResult.type})`);
    console.log(`  ├─ Proof:  ${proofIcon} ${eventResult.proofValid ? 'Valid' : 'Invalid'}`);
    console.log(`  └─ Chain:  ${chainIcon} ${eventResult.chainValid ? 'Valid' : 'Invalid'}`);
    
    // Show proof details
    if (event.proof && event.proof.length > 0) {
      console.log(`\n  Proofs (${event.proof.length}):`);
      
      for (let j = 0; j < event.proof.length; j++) {
        const proof = event.proof[j];
        const isWitness = isWitnessProof(proof);
        const proofLabel = isWitness ? '🔏 Witness Proof' : '🔐 Controller Proof';
        
        console.log(`\n  [${j + 1}] ${proofLabel}`);
        console.log(formatProofDetails(proof, '      '));
      }
    }
    
    // Show errors for this event
    if (eventResult.errors && eventResult.errors.length > 0) {
      console.log(`\n  ⚠️  Errors:`);
      for (const error of eventResult.errors) {
        console.log(`      - ${error}`);
      }
    }
  }
  
  // Show global errors if any
  if (result.errors && result.errors.length > 0) {
    console.log('\n───────────────────────────────────────────────────────');
    console.log('⚠️  All Errors:');
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════\n');
}

/**
 * Execute the verify command
 */
export async function verifyCommand(flags: VerifyFlags): Promise<VerifyResult> {
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
      message: 'Error: --log is required. Usage: originals-cel verify --log <path>',
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
  
  // Verify the event log
  let result: VerificationResult;
  try {
    result = await verifyEventLog(eventLog);
  } catch (e) {
    return {
      success: false,
      message: `Error: Verification failed: ${(e as Error).message}`,
    };
  }
  
  // Output the result
  outputResult(eventLog, result);
  
  // Return result with exit code information
  if (result.verified) {
    return {
      success: true,
      verified: true,
      message: 'Verification passed: All proofs valid and hash chain intact',
      result,
    };
  } else {
    return {
      success: true, // Command ran successfully, but verification failed
      verified: false,
      message: `Verification failed: ${result.errors.length} error(s) found`,
      result,
    };
  }
}
