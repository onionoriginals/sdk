#!/usr/bin/env node
/**
 * CLI Resolve Command
 *
 * Resolves a DID (did:peer, did:webvh, or did:btco) and outputs the DID Document.
 *
 * Usage: originals-cel resolve <did> [options]
 */

import { OriginalsSDK } from '../../core/OriginalsSDK';
import type { BitcoinNetworkName } from '../../types/network';

/**
 * Flags parsed from command line arguments
 */
export interface ResolveFlags {
  did?: string;
  network?: string;
  output?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the resolve command
 */
export interface ResolveResult {
  success: boolean;
  message: string;
  didDocument?: unknown;
}

/**
 * Execute the resolve command
 */
export async function resolveCommand(flags: ResolveFlags): Promise<ResolveResult> {
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }

  if (!flags.did) {
    return {
      success: false,
      message: 'Error: A DID is required. Usage: originals-cel resolve <did>',
    };
  }

  const did = flags.did;

  // Validate DID format
  if (!did.startsWith('did:')) {
    return {
      success: false,
      message: 'Error: Invalid DID format. Must start with "did:" (e.g., did:peer:..., did:webvh:..., did:btco:...)',
    };
  }

  // Determine network from DID or flag
  let network: BitcoinNetworkName = 'mainnet';
  if (flags.network) {
    const n = flags.network.toLowerCase();
    if (n === 'mainnet' || n === 'regtest' || n === 'signet') {
      network = n;
    } else {
      return {
        success: false,
        message: 'Error: --network must be "mainnet", "regtest", or "signet"',
      };
    }
  } else if (did.startsWith('did:btco:reg:')) {
    network = 'regtest';
  } else if (did.startsWith('did:btco:sig:')) {
    network = 'signet';
  }

  // Create SDK instance for resolution
  const sdk = OriginalsSDK.create({ network });

  let didDocument;
  try {
    didDocument = await sdk.did.resolveDID(did);
  } catch (e) {
    return {
      success: false,
      message: `Error: Failed to resolve DID: ${(e as Error).message}`,
    };
  }

  if (!didDocument) {
    return {
      success: false,
      message: `Error: Could not resolve DID: ${did}`,
    };
  }

  const output = JSON.stringify(didDocument, null, 2);

  // Write output
  if (flags.output) {
    const fs = await import('fs');
    try {
      fs.writeFileSync(flags.output, output, 'utf-8');
    } catch (e) {
      return {
        success: false,
        message: `Error: Failed to write output file: ${(e as Error).message}`,
      };
    }
  } else {
    process.stdout.write(output + '\n');
  }

  return {
    success: true,
    message: `Resolved ${did}`,
    didDocument,
  };
}
