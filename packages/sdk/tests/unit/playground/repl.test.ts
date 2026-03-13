/**
 * Tests for the playground REPL command processing.
 *
 * We import the processCommand function indirectly by testing
 * the REPL via piped stdin, since the module executes on import.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const REPL_PATH = join(import.meta.dir, '../../../src/playground/repl.ts');

async function runRepl(commands: string[]): Promise<string> {
  const input = commands.join('\n');
  const proc = Bun.spawn(['bun', 'run', REPL_PATH], {
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: join(import.meta.dir, '../../..'),
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

describe('Playground REPL', () => {
  test('shows banner on startup', async () => {
    const output = await runRepl(['exit']);
    expect(output).toContain('SDK Playground (magby/regtest)');
    expect(output).toContain('Type "help" for available commands');
  });

  test('shows help text', async () => {
    const output = await runRepl(['help', 'exit']);
    expect(output).toContain('Commands:');
    expect(output).toContain('create [name]');
    expect(output).toContain('publish <id>');
    expect(output).toContain('inscribe <id>');
    expect(output).toContain('resolve <did>');
    expect(output).toContain('estimate <id>');
  });

  test('creates an asset with default name', async () => {
    const output = await runRepl(['create', 'exit']);
    expect(output).toContain('Created "Asset 1"');
    expect(output).toContain('Alias:  a1');
    expect(output).toContain('did:peer:');
    expect(output).toContain('Layer:  did:peer');
  });

  test('creates an asset with custom name', async () => {
    const output = await runRepl(['create My Custom Asset', 'exit']);
    expect(output).toContain('Created "My Custom Asset"');
    expect(output).toContain('Alias:  a1');
  });

  test('counter increments correctly for unnamed assets', async () => {
    const output = await runRepl(['create', 'create', 'create', 'exit']);
    expect(output).toContain('Created "Asset 1"');
    expect(output).toContain('Created "Asset 2"');
    expect(output).toContain('Created "Asset 3"');
  });

  test('lists assets', async () => {
    const output = await runRepl(['create TestOne', 'create TestTwo', 'assets', 'exit']);
    expect(output).toContain('Session Assets:');
    expect(output).toContain('a1');
    expect(output).toContain('a2');
    expect(output).toContain('did:peer');
  });

  test('shows empty assets message', async () => {
    const output = await runRepl(['assets', 'exit']);
    expect(output).toContain('No assets yet');
  });

  test('inspects an asset', async () => {
    const output = await runRepl(['create InspectMe', 'inspect a1', 'exit']);
    expect(output).toContain('Asset: a1');
    expect(output).toContain('Layer:         did:peer');
    expect(output).toContain('Resources:     1');
    expect(output).toContain('Provenance:');
    expect(output).toContain('Migrations:  0');
  });

  test('inspect shows error for missing asset', async () => {
    const output = await runRepl(['inspect a99', 'exit']);
    expect(output).toContain('Asset "a99" not found');
  });

  test('estimates cost for an asset', async () => {
    const output = await runRepl(['create', 'estimate a1', 'exit']);
    expect(output).toContain('Cost Estimates');
    expect(output).toContain('Fee Rate');
    expect(output).toContain('sat/vB');
  });

  test('creates a standalone did:peer', async () => {
    const output = await runRepl(['did-peer TestPeer', 'exit']);
    expect(output).toContain('Created did:peer');
    expect(output).toContain('DID: did:peer:');
    expect(output).toContain('Document:');
    expect(output).toContain('verificationMethod');
  });

  test('publishes an asset to web', async () => {
    const output = await runRepl(['create', 'publish a1', 'exit']);
    expect(output).toContain('Published "a1" to web');
    expect(output).toContain('Layer:  did:webvh');
    expect(output).toContain('Domain: magby.originals.build');
  });

  test('publish shows error for missing asset', async () => {
    const output = await runRepl(['publish a99', 'exit']);
    expect(output).toContain('Asset "a99" not found');
  });

  test('publish shows usage without arguments', async () => {
    const output = await runRepl(['publish', 'exit']);
    expect(output).toContain('Usage: publish');
  });

  test('inscribes an asset on Bitcoin', async () => {
    const output = await runRepl(['create', 'publish a1', 'inscribe a1', 'exit']);
    expect(output).toContain('Inscribed "a1" on Bitcoin (regtest)');
    expect(output).toContain('Layer:  did:btco');
    expect(output).toContain('TX:');
    expect(output).toContain('Insc:');
  });

  test('full lifecycle: create → publish → inscribe → inspect', async () => {
    const output = await runRepl([
      'create LifecycleTest',
      'publish a1',
      'inscribe a1',
      'inspect a1',
      'exit',
    ]);
    // Verify progression through all layers
    expect(output).toContain('Created "LifecycleTest"');
    expect(output).toContain('Published "a1" to web');
    expect(output).toContain('Inscribed "a1" on Bitcoin (regtest)');
    // Inspect should show did:btco layer and migration history
    expect(output).toContain('Layer:         did:btco');
    expect(output).toContain('Migrations:  2');
  });

  test('handles unknown commands gracefully', async () => {
    const output = await runRepl(['foobar', 'exit']);
    expect(output).toContain('Unknown command: "foobar"');
  });

  test('command aliases work', async () => {
    // ls is alias for assets, show for inspect, cost for estimate, ? for help
    const output = await runRepl(['ls', '?', 'exit']);
    expect(output).toContain('No assets yet');
    expect(output).toContain('Commands:');
  });

  test('does not show SDK info logs', async () => {
    const output = await runRepl(['create', 'exit']);
    expect(output).not.toContain('[SDK]');
    expect(output).not.toContain('INFO');
    expect(output).not.toContain('Initializing Originals SDK');
  });

  test('goodbye message on exit', async () => {
    const output = await runRepl(['exit']);
    expect(output).toContain('Goodbye!');
  });
});
