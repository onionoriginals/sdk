#!/usr/bin/env node
/**
 * CLI Transfer Command
 *
 * Transfers ownership of a CEL asset to a new owner.
 * For did:btco assets, this records a transfer event in the CEL log.
 *
 * Usage: originals-cel transfer --log <path> --to <address-or-did> [options]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EventLog, DataIntegrityProof } from '../types';
import type { CelSigner } from '../layers/PeerCelManager';
import { parseEventLogJson } from '../serialization/json';
import { parseEventLogCbor } from '../serialization/cbor';
import { serializeEventLogJson } from '../serialization/json';
import { serializeEventLogCbor } from '../serialization/cbor';
import { multikey } from '../../crypto/Multikey';

/**
 * Flags parsed from command line arguments
 */
export interface TransferFlags {
  log?: string;
  to?: string;
  wallet?: string;
  output?: string;
  format?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the transfer command
 */
export interface TransferResult {
  success: boolean;
  message: string;
  log?: EventLog;
  previousOwner?: string;
  newOwner?: string;
}

/**
 * Loads and parses an event log from a file
 */
function loadEventLog(filePath: string): EventLog {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath);

  if (ext === '.cbor') {
    return parseEventLogCbor(new Uint8Array(content));
  } else {
    return parseEventLogJson(content.toString('utf-8'));
  }
}

/**
 * Extracts the current DID from an event log
 */
function getCurrentDid(log: EventLog): string {
  let currentDid: string | undefined;

  for (const event of log.events) {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'create' && data.did) {
      currentDid = data.did as string;
    } else if (event.type === 'update' && data.targetDid) {
      currentDid = data.targetDid as string;
    }
  }

  if (!currentDid) {
    throw new Error('Could not determine current DID from event log');
  }
  return currentDid;
}

/**
 * Loads an Ed25519 private key from a wallet file
 */
async function loadWalletKey(walletPath: string): Promise<{ privateKey: string; publicKey: string }> {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }

  const content = fs.readFileSync(walletPath, 'utf-8').trim();
  let privateKey: string;

  try {
    const parsed = JSON.parse(content);
    if (parsed.privateKey) {
      privateKey = parsed.privateKey;
    } else {
      throw new Error('JSON wallet file must contain "privateKey" field');
    }
  } catch {
    if (content.startsWith('z')) {
      privateKey = content;
    } else {
      throw new Error('Wallet file must contain a z-base58btc multibase-encoded Ed25519 private key');
    }
  }

  const decoded = multikey.decodePrivateKey(privateKey);
  if (decoded.type !== 'Ed25519') {
    throw new Error(`Expected Ed25519 key, got ${decoded.type}`);
  }

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

    const dataStr = JSON.stringify(data, Object.keys(data as object).sort());
    const dataBytes = new TextEncoder().encode(dataStr);

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
 * Execute the transfer command
 */
export async function transferCommand(flags: TransferFlags): Promise<TransferResult> {
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }

  if (!flags.log) {
    return {
      success: false,
      message: 'Error: --log is required. Usage: originals-cel transfer --log <path> --to <address-or-did>',
    };
  }

  if (!flags.to) {
    return {
      success: false,
      message: 'Error: --to is required. Provide a Bitcoin address or DID for the new owner.',
    };
  }

  if (!flags.wallet) {
    return {
      success: false,
      message: 'Error: --wallet is required. Provide the path to the signing key.',
    };
  }

  // Load event log
  let eventLog: EventLog;
  try {
    eventLog = loadEventLog(flags.log);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to load event log: ${(e as Error).message}`,
    };
  }

  // Get current DID
  let currentDid: string;
  try {
    currentDid = getCurrentDid(eventLog);
  } catch (e) {
    return {
      success: false,
      message: `Error: ${(e as Error).message}`,
    };
  }

  // Load wallet key
  let privateKey: string;
  let publicKey: string;
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

  // Create signer and sign the transfer event
  const signer = createSigner(privateKey, publicKey);

  const transferData = {
    type: 'transfer',
    previousOwner: currentDid,
    newOwner: flags.to,
    transferredAt: new Date().toISOString(),
  };

  let proof: DataIntegrityProof;
  try {
    proof = await signer(transferData);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to sign transfer: ${(e as Error).message}`,
    };
  }

  // Compute previous event hash
  const lastEvent = eventLog.events[eventLog.events.length - 1];
  const lastEventStr = JSON.stringify(lastEvent);
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const hashBytes = sha256(new TextEncoder().encode(lastEventStr));
  const previousEvent = multikey.encodeMultibase(hashBytes);

  // Append transfer event to log
  eventLog.events.push({
    type: 'update',
    data: transferData,
    proof: [proof],
    previousEvent,
  });

  // Serialize output
  const format = (flags.format || 'json').toLowerCase();
  if (format !== 'json' && format !== 'cbor') {
    return {
      success: false,
      message: 'Error: --format must be "json" or "cbor"',
    };
  }

  let output: string | Uint8Array;
  try {
    if (format === 'cbor') {
      output = serializeEventLogCbor(eventLog);
    } else {
      output = serializeEventLogJson(eventLog);
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
    if (format === 'cbor') {
      const base64 = Buffer.from(output as Uint8Array).toString('base64');
      process.stdout.write(base64);
    } else {
      process.stdout.write(output as string);
    }
  }

  const outputInfo = flags.output ? ` and saved to ${flags.output}` : '';
  console.error(`\nTransfer recorded: ${currentDid} -> ${flags.to}${outputInfo}\n`);

  return {
    success: true,
    message: `Transfer recorded from ${currentDid} to ${flags.to}`,
    log: eventLog,
    previousOwner: currentDid,
    newOwner: flags.to,
  };
}
