#!/usr/bin/env node
/**
 * Originals SDK Playground - Interactive REPL
 *
 * An interactive environment for experimenting with SDK operations
 * against the magby/regtest development network.
 */

import * as readline from 'node:readline';
import '../crypto/noble-init.js';
import { OriginalsSDK } from '../core/OriginalsSDK.js';
import { OrdMockProvider } from '../adapters/providers/OrdMockProvider.js';
import { ResourceManager } from '../resources/index.js';
import type { OriginalsAsset } from '../lifecycle/OriginalsAsset.js';
import { sha256 } from '@noble/hashes/sha2.js';

interface SessionState {
  sdk: OriginalsSDK;
  resourceManager: ResourceManager;
  assets: Map<string, OriginalsAsset>;
  counter: number;
}

function computeHash(content: string): string {
  return Buffer.from(sha256(Buffer.from(content))).toString('hex');
}

const BANNER = `
  ___       _       _             _
 / _ \\ _ __(_) __ _(_)_ __   __ _| |___
| | | | '__| |/ _\` | | '_ \\ / _\` | / __|
| |_| | |  | | (_| | | | | | (_| | \\__ \\
 \\___/|_|  |_|\\__, |_|_| |_|\\__,_|_|___/
              |___/
        SDK Playground (magby/regtest)
`;

const HELP = `
Commands:

  create [name]         Create a new asset (did:peer layer)
  publish <id> [domain] Publish asset to web (did:webvh layer)
  inscribe <id>         Inscribe asset on Bitcoin (did:btco layer)
  resolve <did>         Resolve a DID to its document
  assets                List all assets in this session
  inspect <id>          Show detailed asset info and provenance
  did-peer [name]       Create a standalone did:peer (returns DID doc)
  estimate <id>         Estimate Bitcoin inscription cost
  help                  Show this help message
  exit                  Exit the playground

Arguments:
  <id>    Asset alias (e.g., "a1") from the assets list
  <did>   A full DID string (did:peer:..., did:webvh:..., did:btco:...)
  [name]  Optional name for the asset (defaults to "Asset N")
`;

async function handleCreate(state: SessionState, args: string[]): Promise<void> {
  const name = args.join(' ') || `Asset ${++state.counter}`;

  const content = JSON.stringify({
    name,
    created: new Date().toISOString(),
    description: `Interactive playground asset: ${name}`,
  }, null, 2);

  const resources = [{
    id: 'metadata.json',
    type: 'data',
    content,
    contentType: 'application/json',
    hash: computeHash(content),
    size: content.length,
  }];

  const asset = await state.sdk.lifecycle.createAsset(resources);
  const alias = `a${state.assets.size + 1}`;
  state.assets.set(alias, asset);

  console.log(`\n  Created "${name}"`);
  console.log(`  Alias:  ${alias}`);
  console.log(`  DID:    ${asset.id}`);
  console.log(`  Layer:  ${asset.currentLayer}`);
  console.log(`\n  Use "publish ${alias}" to publish to web.\n`);
}

async function handlePublish(state: SessionState, args: string[]): Promise<void> {
  const [alias, domain] = args;
  if (!alias) {
    console.log('  Usage: publish <id> [domain]');
    return;
  }

  const asset = state.assets.get(alias);
  if (!asset) {
    console.log(`  Asset "${alias}" not found. Run "assets" to see available assets.`);
    return;
  }

  if (asset.currentLayer !== 'did:peer') {
    console.log(`  Asset is already at layer "${asset.currentLayer}". Can only publish from did:peer.`);
    return;
  }

  const targetDomain = domain || 'magby.originals.build';
  await state.sdk.lifecycle.publishToWeb(asset, targetDomain);

  console.log(`\n  Published "${alias}" to web`);
  console.log(`  DID:    ${asset.id}`);
  console.log(`  Layer:  ${asset.currentLayer}`);
  console.log(`  Domain: ${targetDomain}`);
  console.log(`\n  Use "inscribe ${alias}" to inscribe on Bitcoin.\n`);
}

async function handleInscribe(state: SessionState, args: string[]): Promise<void> {
  const [alias] = args;
  if (!alias) {
    console.log('  Usage: inscribe <id>');
    return;
  }

  const asset = state.assets.get(alias);
  if (!asset) {
    console.log(`  Asset "${alias}" not found. Run "assets" to see available assets.`);
    return;
  }

  await state.sdk.lifecycle.inscribeOnBitcoin(asset);

  console.log(`\n  Inscribed "${alias}" on Bitcoin (regtest)`);
  console.log(`  DID:    ${asset.id}`);
  console.log(`  Layer:  ${asset.currentLayer}`);

  const provenance = asset.getProvenance();
  const btcoMigration = provenance.migrations.find((m: { to: string }) => m.to === 'did:btco');
  if (btcoMigration) {
    const m = btcoMigration as Record<string, unknown>;
    if (m.transactionId) console.log(`  TX:     ${m.transactionId}`);
    if (m.inscriptionId) console.log(`  Insc:   ${m.inscriptionId}`);
  }
  console.log('');
}

async function handleResolve(state: SessionState, args: string[]): Promise<void> {
  const [did] = args;
  if (!did) {
    console.log('  Usage: resolve <did>');
    return;
  }

  try {
    const doc = await state.sdk.did.resolveDID(did);
    console.log('\n  Resolved DID Document:\n');
    console.log('  ' + JSON.stringify(doc, null, 2).split('\n').join('\n  '));
    console.log('');
  } catch (err) {
    console.log(`  Failed to resolve: ${(err as Error).message}`);
  }
}

function handleAssets(state: SessionState): void {
  if (state.assets.size === 0) {
    console.log('\n  No assets yet. Use "create [name]" to create one.\n');
    return;
  }

  console.log('\n  Session Assets:\n');
  console.log('  Alias  Layer       DID');
  console.log('  -----  ----------  ---');
  for (const [alias, asset] of state.assets) {
    const layer = asset.currentLayer.padEnd(10);
    const didShort = asset.id.length > 50 ? asset.id.substring(0, 50) + '...' : asset.id;
    console.log(`  ${alias.padEnd(5)}  ${layer}  ${didShort}`);
  }
  console.log('');
}

function handleInspect(state: SessionState, args: string[]): void {
  const [alias] = args;
  if (!alias) {
    console.log('  Usage: inspect <id>');
    return;
  }

  const asset = state.assets.get(alias);
  if (!asset) {
    console.log(`  Asset "${alias}" not found. Run "assets" to see available assets.`);
    return;
  }

  const provenance = asset.getProvenance();
  const summary = asset.getProvenanceSummary();

  console.log(`\n  Asset: ${alias}`);
  console.log(`  DID:           ${asset.id}`);
  console.log(`  Layer:         ${asset.currentLayer}`);
  console.log(`  Resources:     ${asset.resources.length}`);
  console.log(`  Credentials:   ${asset.credentials.length}`);

  console.log(`\n  Provenance:`);
  console.log(`    Created:     ${summary.created}`);
  console.log(`    Creator:     ${summary.creator}`);
  console.log(`    Migrations:  ${summary.migrationCount}`);
  console.log(`    Transfers:   ${summary.transferCount}`);
  console.log(`    Last Active: ${summary.lastActivity}`);

  if (provenance.migrations.length > 0) {
    console.log(`\n  Migration History:`);
    provenance.migrations.forEach((m: Record<string, unknown>, i: number) => {
      console.log(`    ${i + 1}. ${m.from} -> ${m.to} (${m.timestamp})`);
    });
  }
  console.log('');
}

async function handleDidPeer(state: SessionState, args: string[]): Promise<void> {
  const name = args.join(' ') || `Peer ${++state.counter}`;

  const content = JSON.stringify({ name, created: new Date().toISOString() });
  const resources = [{
    id: 'metadata.json',
    type: 'data',
    content,
    contentType: 'application/json',
    hash: computeHash(content),
    size: content.length,
  }];

  const result = await state.sdk.did.createDIDPeer(resources, true);
  const didDoc = 'didDocument' in result ? result.didDocument : result;
  const did = (didDoc as Record<string, unknown>).id as string;

  console.log(`\n  Created did:peer`);
  console.log(`  DID: ${did}`);
  console.log(`\n  Document:\n`);
  console.log('  ' + JSON.stringify(didDoc, null, 2).split('\n').join('\n  '));
  console.log('');
}

async function handleEstimate(state: SessionState, args: string[]): Promise<void> {
  const [alias] = args;
  if (!alias) {
    console.log('  Usage: estimate <id>');
    return;
  }

  const asset = state.assets.get(alias);
  if (!asset) {
    console.log(`  Asset "${alias}" not found. Run "assets" to see available assets.`);
    return;
  }

  console.log(`\n  Cost Estimates for "${alias}" -> did:btco:\n`);
  console.log('  Fee Rate    Total (sats)    Network    Data    Dust');
  console.log('  ----------  ------------    -------    ----    ----');

  for (const feeRate of [1, 5, 10, 25]) {
    try {
      const est = await state.sdk.lifecycle.estimateCost(asset, 'did:btco', feeRate);
      const rate = `${feeRate} sat/vB`.padEnd(10);
      const total = String(est.totalSats).padEnd(12);
      const net = String(est.breakdown.networkFee).padEnd(7);
      const data = String(est.breakdown.dataCost).padEnd(4);
      console.log(`  ${rate}  ${total}    ${net}    ${data}    ${est.breakdown.dustValue}`);
    } catch {
      console.log(`  ${feeRate} sat/vB    (estimation failed)`);
    }
  }
  console.log('');
}

async function processCommand(state: SessionState, input: string): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed) return true;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    switch (cmd) {
      case 'create':
        await handleCreate(state, args);
        break;
      case 'publish':
        await handlePublish(state, args);
        break;
      case 'inscribe':
        await handleInscribe(state, args);
        break;
      case 'resolve':
        await handleResolve(state, args);
        break;
      case 'assets':
      case 'ls':
        handleAssets(state);
        break;
      case 'inspect':
      case 'show':
        handleInspect(state, args);
        break;
      case 'did-peer':
      case 'peer':
        await handleDidPeer(state, args);
        break;
      case 'estimate':
      case 'cost':
        await handleEstimate(state, args);
        break;
      case 'help':
      case '?':
        console.log(HELP);
        break;
      case 'exit':
      case 'quit':
      case '.exit':
        return false;
      default:
        console.log(`  Unknown command: "${cmd}". Type "help" for available commands.`);
    }
  } catch (err) {
    console.log(`  Error: ${(err as Error).message}`);
  }

  return true;
}

// --- Main execution (top-level await for Bun compatibility) ---

console.log(BANNER);
console.log('  Type "help" for available commands, "exit" to quit.\n');

const state: SessionState = {
  sdk: OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
    logging: { level: 'error' },
  }),
  resourceManager: new ResourceManager(),
  assets: new Map(),
  counter: 0,
};

if (process.stdin.isTTY) {
  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question('originals> ', (answer) => resolve(answer));
      rl.once('close', () => resolve(null));
    });

  let running = true;
  while (running) {
    const line = await ask();
    if (line === null) break;
    running = await processCommand(state, line);
  }

  console.log('\n  Goodbye!\n');
  rl.close();
} else {
  // Piped mode: collect all lines first, then process sequentially
  const lines: string[] = [];
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => resolve());
  });

  for (const line of lines) {
    process.stdout.write(`originals> ${line}\n`);
    const shouldContinue = await processCommand(state, line);
    if (!shouldContinue) {
      console.log('\n  Goodbye!\n');
      break;
    }
  }
}

process.exit(0);
