#!/usr/bin/env node
/**
 * Originals CEL CLI
 *
 * Command-line interface for working with CEL (Cryptographic Event Log) assets.
 * Part of the Originals Protocol SDK.
 */

import { createCommand, CreateFlags } from './create';

// Version from package.json - will be replaced at build time or read dynamically
const VERSION = '1.5.0';

const HELP_TEXT = `
originals-cel - Cryptographic Event Log CLI for Originals Protocol

USAGE:
  originals-cel <command> [options]

COMMANDS:
  create    Create a new CEL asset with an initial event
  verify    Verify an existing CEL event log
  inspect   Inspect a CEL log in human-readable format
  migrate   Migrate a CEL asset between layers (peer → webvh → btco)

GLOBAL OPTIONS:
  --help, -h       Show help for a command
  --version, -v    Show version number

EXAMPLES:
  originals-cel create --name "My Asset" --file ./image.png
  originals-cel verify --log ./asset.cel.json
  originals-cel inspect --log ./asset.cel.json
  originals-cel migrate --log ./asset.cel.json --to webvh --domain example.com

For more information on a specific command:
  originals-cel <command> --help
`;

const CREATE_HELP = `
originals-cel create - Create a new CEL asset

USAGE:
  originals-cel create --name <name> --file <path> [options]

REQUIRED:
  --name <name>        Name of the asset
  --file <path>        Path to the content file

OPTIONS:
  --key <path>         Path to Ed25519 private key (generates new if not provided)
  --output <path>      Output file path (stdout if not provided)
  --format <type>      Output format: json (default) or cbor
  --help, -h           Show this help message

EXAMPLES:
  originals-cel create --name "My Art" --file ./artwork.png
  originals-cel create --name "Document" --file ./doc.pdf --output ./doc.cel.json
  originals-cel create --name "Asset" --file ./data.bin --format cbor --output ./asset.cel.cbor
`;

const VERIFY_HELP = `
originals-cel verify - Verify a CEL event log

USAGE:
  originals-cel verify --log <path> [options]

REQUIRED:
  --log <path>         Path to the CEL event log file (.cel.json or .cel.cbor)

OPTIONS:
  --help, -h           Show this help message

OUTPUT:
  Displays verification result with event-by-event breakdown.
  Shows witness attestations if present.
  Exit code 0 on success, 1 on verification failure.

EXAMPLES:
  originals-cel verify --log ./asset.cel.json
  originals-cel verify --log ./asset.cel.cbor
`;

const INSPECT_HELP = `
originals-cel inspect - Inspect a CEL log in human-readable format

USAGE:
  originals-cel inspect --log <path> [options]

REQUIRED:
  --log <path>         Path to the CEL event log file

OPTIONS:
  --help, -h           Show this help message

OUTPUT:
  Pretty-prints event timeline with timestamps.
  Shows current state derived from events.
  Lists witnesses and attestation times.
  Shows layer history if migrations are present.

EXAMPLES:
  originals-cel inspect --log ./asset.cel.json
`;

const MIGRATE_HELP = `
originals-cel migrate - Migrate a CEL asset between layers

USAGE:
  originals-cel migrate --log <path> --to <layer> [options]

REQUIRED:
  --log <path>         Path to the CEL event log file
  --to <layer>         Target layer: webvh or btco

OPTIONS:
  --domain <domain>    Domain for webvh layer (required for --to webvh)
  --wallet <path>      Path to Bitcoin wallet key (required for --to btco)
  --output <path>      Output file path (stdout if not provided)
  --help, -h           Show this help message

MIGRATION PATHS:
  peer → webvh         Requires --domain
  webvh → btco         Requires --wallet

EXAMPLES:
  originals-cel migrate --log ./asset.cel.json --to webvh --domain example.com
  originals-cel migrate --log ./asset.cel.json --to btco --wallet ./wallet.key
  originals-cel migrate --log ./asset.cel.json --to webvh --domain example.com --output ./migrated.cel.json
`;

/**
 * Parse command line arguments into a structured object
 */
function parseArgs(args: string[]): {
  command: string | null;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      // Check if next arg exists and doesn't start with --
      if (nextArg && !nextArg.startsWith('-')) {
        flags[key] = nextArg;
        i++; // Skip the value
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      flags[key] = true;
    } else if (!command) {
      command = arg;
    }
  }

  return { command, flags };
}

/**
 * Print message to stdout
 */
function print(message: string): void {
  console.log(message);
}

/**
 * Print error message to stderr and exit
 */
function error(message: string, exitCode = 1): never {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

/**
 * Show help for a specific command
 */
function showCommandHelp(command: string): void {
  switch (command) {
    case 'create':
      print(CREATE_HELP);
      break;
    case 'verify':
      print(VERIFY_HELP);
      break;
    case 'inspect':
      print(INSPECT_HELP);
      break;
    case 'migrate':
      print(MIGRATE_HELP);
      break;
    default:
      error(`Unknown command: ${command}`);
  }
}

/**
 * Run the create command asynchronously
 */
async function runCreateCommand(flags: Record<string, string | boolean>): Promise<void> {
  try {
    const createFlags: CreateFlags = {
      name: typeof flags.name === 'string' ? flags.name : undefined,
      file: typeof flags.file === 'string' ? flags.file : undefined,
      key: typeof flags.key === 'string' ? flags.key : undefined,
      output: typeof flags.output === 'string' ? flags.output : undefined,
      format: typeof flags.format === 'string' ? flags.format : undefined,
      help: flags.help === true,
      h: flags.h === true,
    };
    
    const result = await createCommand(createFlags);
    
    if (!result.success) {
      error(result.message.replace('Error: ', ''));
    }
  } catch (e) {
    error((e as Error).message);
  }
}

/**
 * Main CLI entry point
 */
export function main(args: string[] = process.argv.slice(2)): void {
  const { command, flags } = parseArgs(args);

  // Handle --version / -v
  if (flags.version || flags.v) {
    print(`originals-cel v${VERSION}`);
    return;
  }

  // Handle --help / -h without command
  if (!command || flags.help || flags.h) {
    if (command && command !== 'help') {
      showCommandHelp(command);
    } else {
      print(HELP_TEXT);
    }
    return;
  }

  // Route to subcommands
  switch (command) {
    case 'create':
      if (flags.help || flags.h) {
        print(CREATE_HELP);
        return;
      }
      // Run create command asynchronously
      runCreateCommand(flags);
      return;

    case 'verify':
      // Will be implemented in US-021
      if (flags.help || flags.h) {
        print(VERIFY_HELP);
        return;
      }
      print('Verify command not yet implemented. See US-021.');
      break;

    case 'inspect':
      // Will be implemented in US-022
      if (flags.help || flags.h) {
        print(INSPECT_HELP);
        return;
      }
      print('Inspect command not yet implemented. See US-022.');
      break;

    case 'migrate':
      // Will be implemented in US-023
      if (flags.help || flags.h) {
        print(MIGRATE_HELP);
        return;
      }
      print('Migrate command not yet implemented. See US-023.');
      break;

    case 'help':
      // Handle "originals-cel help <command>"
      const helpTarget = args[1];
      if (helpTarget && !helpTarget.startsWith('-')) {
        showCommandHelp(helpTarget);
      } else {
        print(HELP_TEXT);
      }
      break;

    default:
      error(`Unknown command: ${command}\n\nRun 'originals-cel --help' for usage.`);
  }
}

// Run if executed directly
if (typeof process !== 'undefined' && process.argv[1]?.includes('cli')) {
  main();
}
