#!/usr/bin/env node
/**
 * CLI Create Command
 * 
 * Creates a new CEL asset with an initial event.
 * Generates Ed25519 key pair if --key not provided.
 * 
 * Usage: originals-cel create --name <name> --file <path> [options]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DataIntegrityProof } from '../types';
import { PeerCelManager, CelSigner } from '../layers/PeerCelManager';
import { createExternalReference } from '../ExternalReferenceManager';
import { serializeEventLogJson } from '../serialization/json';
import { serializeEventLogCbor } from '../serialization/cbor';
import { multikey } from '../../crypto/Multikey';

/**
 * Flags parsed from command line arguments
 */
export interface CreateFlags {
  name?: string;
  file?: string;
  key?: string;
  output?: string;
  format?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the create command
 */
export interface CreateResult {
  success: boolean;
  message: string;
  log?: unknown;
  keyGenerated?: boolean;
  privateKey?: string;
  publicKey?: string;
}

/**
 * Lookup table for common file extensions to MIME types
 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
  '.bin': 'application/octet-stream',
};

/**
 * Gets MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Generates an Ed25519 key pair for signing
 */
async function generateKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const publicKeyBytes = await (ed25519 as any).getPublicKeyAsync(privateKeyBytes);
  
  return {
    privateKey: multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519'),
    publicKey: multikey.encodePublicKey(publicKeyBytes as Uint8Array, 'Ed25519'),
  };
}

/**
 * Loads an Ed25519 private key from a file
 * Supports both raw multibase format and JSON format { privateKey: "z..." }
 */
async function loadPrivateKey(keyPath: string): Promise<{ privateKey: string; publicKey: string }> {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Key file not found: ${keyPath}`);
  }
  
  const content = fs.readFileSync(keyPath, 'utf-8').trim();
  
  let privateKey: string;
  
  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(content);
    if (parsed.privateKey) {
      privateKey = parsed.privateKey;
    } else {
      throw new Error('JSON key file must contain "privateKey" field');
    }
  } catch (e) {
    // Not JSON, treat as raw multibase key
    if (content.startsWith('z')) {
      privateKey = content;
    } else {
      throw new Error('Key file must contain a z-base58btc multibase-encoded Ed25519 private key');
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
 * Execute the create command
 */
export async function createCommand(flags: CreateFlags): Promise<CreateResult> {
  // Check for help flag
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }
  
  // Validate required arguments
  if (!flags.name) {
    return {
      success: false,
      message: 'Error: --name is required. Usage: originals-cel create --name <name> --file <path>',
    };
  }
  
  if (!flags.file) {
    return {
      success: false,
      message: 'Error: --file is required. Usage: originals-cel create --name <name> --file <path>',
    };
  }
  
  // Validate format flag
  const format = (flags.format || 'json').toLowerCase();
  if (format !== 'json' && format !== 'cbor') {
    return {
      success: false,
      message: 'Error: --format must be "json" or "cbor"',
    };
  }
  
  // Check if file exists
  if (!fs.existsSync(flags.file)) {
    return {
      success: false,
      message: `Error: File not found: ${flags.file}`,
    };
  }
  
  // Read file content
  let fileContent: Uint8Array;
  try {
    fileContent = new Uint8Array(fs.readFileSync(flags.file));
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to read file: ${(e as Error).message}`,
    };
  }
  
  // Get or generate key pair
  let privateKey: string;
  let publicKey: string;
  let keyGenerated = false;
  
  if (flags.key) {
    try {
      const loaded = await loadPrivateKey(flags.key);
      privateKey = loaded.privateKey;
      publicKey = loaded.publicKey;
    } catch (e) {
      return {
        success: false,
        message: `Error: Failed to load key: ${(e as Error).message}`,
      };
    }
  } else {
    // Generate new key pair
    const generated = await generateKeyPair();
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;
    keyGenerated = true;
  }
  
  // Create signer
  const signer = createSigner(privateKey, publicKey);
  
  // Determine media type from file extension
  const mediaType = getMimeType(flags.file);
  
  // Create external reference for the file
  const resource = createExternalReference(fileContent, mediaType);
  
  // Create PeerCelManager and create the asset
  const manager = new PeerCelManager(signer, {
    verificationMethod: `did:key:${publicKey}#${publicKey}`,
    proofPurpose: 'assertionMethod',
  });
  
  let eventLog;
  try {
    eventLog = await manager.create(flags.name, [resource]);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to create asset: ${(e as Error).message}`,
    };
  }
  
  // Serialize output
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
    // Write to stdout
    if (format === 'cbor') {
      // For CBOR, output as base64 to stdout since it's binary
      const base64 = Buffer.from(output as Uint8Array).toString('base64');
      process.stdout.write(base64);
    } else {
      process.stdout.write(output as string);
    }
  }
  
  // Build result
  const result: CreateResult = {
    success: true,
    message: flags.output
      ? `Created CEL asset "${flags.name}" and saved to ${flags.output}`
      : `Created CEL asset "${flags.name}"`,
    log: eventLog,
    keyGenerated,
  };
  
  // Include key info if generated
  if (keyGenerated) {
    result.privateKey = privateKey;
    result.publicKey = publicKey;
    
    // Print key info to stderr so it doesn't mix with JSON output
    console.error(`\n⚠️  New Ed25519 key pair generated. Save these keys securely!`);
    console.error(`Private Key: ${privateKey}`);
    console.error(`Public Key:  ${publicKey}`);
    console.error(`\nTo reuse this key, save it to a file and use --key <path>\n`);
  }
  
  return result;
}
