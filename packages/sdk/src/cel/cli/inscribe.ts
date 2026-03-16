#!/usr/bin/env node
/**
 * CLI Inscribe Command
 *
 * Inscribes a CEL asset on Bitcoin by migrating it from did:webvh to did:btco.
 * This is a user-friendly wrapper around "migrate --to btco".
 *
 * Usage: originals-cel inscribe --log <path> --wallet <path> [options]
 */

import { migrateCommand, type MigrateFlags } from './migrate';

/**
 * Flags parsed from command line arguments
 */
export interface InscribeFlags {
  log?: string;
  wallet?: string;
  output?: string;
  format?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the inscribe command
 */
export interface InscribeResult {
  success: boolean;
  message: string;
  sourceDid?: string;
  targetDid?: string;
}

/**
 * Execute the inscribe command
 */
export async function inscribeCommand(flags: InscribeFlags): Promise<InscribeResult> {
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }

  if (!flags.log) {
    return {
      success: false,
      message: 'Error: --log is required. Usage: originals-cel inscribe --log <path> --wallet <path>',
    };
  }

  if (!flags.wallet) {
    return {
      success: false,
      message: 'Error: --wallet is required. Usage: originals-cel inscribe --log <path> --wallet <path>',
    };
  }

  // Delegate to migrate command with --to btco
  const migrateFlags: MigrateFlags = {
    log: flags.log,
    to: 'btco',
    wallet: flags.wallet,
    output: flags.output,
    format: flags.format,
    help: false,
    h: false,
  };

  const result = await migrateCommand(migrateFlags);

  return {
    success: result.success,
    message: result.success
      ? `Inscribed asset on Bitcoin (did:btco)`
      : result.message,
    sourceDid: result.sourceDid,
    targetDid: result.targetDid,
  };
}
