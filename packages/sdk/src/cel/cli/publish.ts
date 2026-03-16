#!/usr/bin/env node
/**
 * CLI Publish Command
 *
 * Publishes a CEL asset to the web by migrating it from did:peer to did:webvh.
 * This is a user-friendly wrapper around "migrate --to webvh".
 *
 * Usage: originals-cel publish --log <path> --domain <domain> [options]
 */

import { migrateCommand, type MigrateFlags } from './migrate';

/**
 * Flags parsed from command line arguments
 */
export interface PublishFlags {
  log?: string;
  domain?: string;
  output?: string;
  format?: string;
  help?: boolean;
  h?: boolean;
}

/**
 * Result of the publish command
 */
export interface PublishResult {
  success: boolean;
  message: string;
  sourceDid?: string;
  targetDid?: string;
}

/**
 * Execute the publish command
 */
export async function publishCommand(flags: PublishFlags): Promise<PublishResult> {
  if (flags.help || flags.h) {
    return {
      success: true,
      message: 'Use --help with the main CLI for full help text',
    };
  }

  if (!flags.log) {
    return {
      success: false,
      message: 'Error: --log is required. Usage: originals-cel publish --log <path> --domain <domain>',
    };
  }

  if (!flags.domain) {
    return {
      success: false,
      message: 'Error: --domain is required. Usage: originals-cel publish --log <path> --domain <domain>',
    };
  }

  // Delegate to migrate command with --to webvh
  const migrateFlags: MigrateFlags = {
    log: flags.log,
    to: 'webvh',
    domain: flags.domain,
    output: flags.output,
    format: flags.format,
    help: false,
    h: false,
  };

  const result = await migrateCommand(migrateFlags);

  return {
    success: result.success,
    message: result.success
      ? `Published asset to web (did:webvh)`
      : result.message,
    sourceDid: result.sourceDid,
    targetDid: result.targetDid,
  };
}
