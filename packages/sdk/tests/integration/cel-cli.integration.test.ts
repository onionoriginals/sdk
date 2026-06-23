/**
 * Integration tests for the CEL CLI command routing via the real entry point.
 *
 * These tests MUST run as subprocesses. The CLI entry point (src/cel/cli/index.ts)
 * calls process.exit() on errors, which would kill the test runner if invoked
 * in-process. Subprocess execution also captures real stdout/stderr and real
 * OS exit codes, making it the only way to verify the actual routing behaviour.
 *
 * CLI entry: packages/sdk/dist/cel/cli/index.js  (referenced in package.json bin)
 * Invoked as: `bun <path> <args>`
 *
 * Verified behaviors:
 *  1. --version prints "originals-cel v<version>" and exits 0
 *  2. --help prints usage and exits 0
 *  3. Unknown command exits 1 with "Unknown command:" error message
 *  4. Missing required argument exits 1 with descriptive error message
 *  5. Valid `create` command with a real file exits 0 and writes JSON to output
 *  6. `verify` on the created log exits 0 with "VERIFICATION PASSED"
 *  7. `inspect` on the created log exits 0 with event timeline
 *  8. `verify --log <nonexistent>` exits 1 with "Failed to load event log"
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the compiled CLI entry point. */
const CLI_ENTRY = path.resolve(
  __dirname,
  '../../dist/cel/cli/index.js'
);

/** Temporary files created by the tests. Cleaned up in afterAll. */
const tmpFiles: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the CLI as a subprocess via `bun <CLI_ENTRY> ...args`.
 * Returns { stdout, stderr, exitCode }.
 */
function runCli(args: string[], options: { timeout?: number } = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: options.timeout ?? 30_000,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Create a temporary file with the given content.
 * The path is registered for cleanup in afterAll.
 */
function makeTmpFile(suffix: string, content: string | Buffer = ''): string {
  const filePath = path.join(os.tmpdir(), `cel-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  if (typeof content === 'string') {
    fs.writeFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content);
  }
  tmpFiles.push(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  // Also clean up any .key files the CLI may have generated alongside output files
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f + '.key'); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('[CEL-CLI] Command routing via real subprocess entry point', () => {
  // ── Global options ────────────────────────────────────────────────────────

  test('--version prints version string and exits 0', () => {
    const { stdout, exitCode } = runCli(['--version']);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/originals-cel v\d+\.\d+\.\d+/);
  });

  test('-v prints version string and exits 0', () => {
    const { stdout, exitCode } = runCli(['-v']);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/originals-cel v\d+\.\d+\.\d+/);
  });

  test('--help prints usage text and exits 0', () => {
    const { stdout, exitCode } = runCli(['--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('originals-cel');
    expect(stdout).toContain('COMMANDS');
    expect(stdout).toContain('create');
    expect(stdout).toContain('verify');
  });

  test('no arguments prints help and exits 0', () => {
    const { stdout, exitCode } = runCli([]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('originals-cel');
  });

  // ── Unknown command ────────────────────────────────────────────────────────

  test('unknown command exits 1 with error message', () => {
    const { stderr, exitCode } = runCli(['unknowncmd']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown command:');
    expect(stderr).toContain('unknowncmd');
  });

  test('unknown command error message suggests --help', () => {
    const { stderr } = runCli(['totally-unknown-xyz']);

    expect(stderr).toMatch(/--help|usage/i);
  });

  // ── Missing required arguments ────────────────────────────────────────────

  test('create without --name exits 1 with descriptive error', () => {
    const tmpFile = makeTmpFile('.txt', 'test content');
    const { stderr, exitCode } = runCli(['create', '--file', tmpFile]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--name.*required|required.*--name/i);
  });

  test('create without --file exits 1 with descriptive error', () => {
    const { stderr, exitCode } = runCli(['create', '--name', 'TestAsset']);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--file.*required|required.*--file/i);
  });

  test('verify without --log exits 1 with descriptive error', () => {
    const { stderr, exitCode } = runCli(['verify']);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--log.*required|required.*--log/i);
  });

  test('inspect without --log exits 1 with descriptive error', () => {
    const { stderr, exitCode } = runCli(['inspect']);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--log.*required|required.*--log/i);
  });

  // ── verify with nonexistent file ──────────────────────────────────────────

  test('verify --log <nonexistent> exits 1 with "Failed to load event log"', () => {
    const { stderr, exitCode } = runCli(['verify', '--log', '/nonexistent-cel-file.cel.json']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Failed to load event log');
  });

  // ── Happy path: create → verify → inspect ────────────────────────────────

  test(
    'create with valid file exits 0 and writes valid JSON to output',
    async () => {
      const contentFile = makeTmpFile('.txt', 'Hello, CEL integration test!\n');
      const outputLog = makeTmpFile('.cel.json');
      // Remove the empty output file so the CLI creates it fresh
      fs.unlinkSync(outputLog);

      const { exitCode, stderr } = runCli([
        'create',
        '--name', 'IntegrationTestAsset',
        '--file', contentFile,
        '--output', outputLog,
      ]);

      // Must exit 0
      expect(exitCode).toBe(0);

      // Output file must exist and be valid JSON
      expect(fs.existsSync(outputLog)).toBe(true);
      const raw = fs.readFileSync(outputLog, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe('object');

      // JSON must have an events array
      expect((parsed as { events: unknown }).events).toBeTruthy();
      const events = (parsed as { events: unknown[] }).events;
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // First event must be a "create" type
      const firstEvent = events[0] as { type: string };
      expect(firstEvent.type).toBe('create');

      // stderr should mention key generation (since no --key was given)
      expect(stderr).toContain('key pair generated');
    },
    30_000
  );

  test(
    'verify on a freshly created log exits 0 with VERIFICATION PASSED',
    async () => {
      const contentFile = makeTmpFile('.txt', 'Hello, CEL verify test!\n');
      const outputLog = makeTmpFile('.cel.json');
      fs.unlinkSync(outputLog);

      // Step 1: create
      const createResult = runCli([
        'create',
        '--name', 'VerifyTestAsset',
        '--file', contentFile,
        '--output', outputLog,
      ]);
      expect(createResult.exitCode).toBe(0);
      expect(fs.existsSync(outputLog)).toBe(true);

      // Step 2: verify
      const verifyResult = runCli(['verify', '--log', outputLog]);

      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout).toContain('VERIFICATION PASSED');
    },
    30_000
  );

  test(
    'inspect on a freshly created log exits 0 with event timeline',
    async () => {
      const contentFile = makeTmpFile('.txt', 'Hello, CEL inspect test!\n');
      const outputLog = makeTmpFile('.cel.json');
      fs.unlinkSync(outputLog);

      // Step 1: create
      const createResult = runCli([
        'create',
        '--name', 'InspectTestAsset',
        '--file', contentFile,
        '--output', outputLog,
      ]);
      expect(createResult.exitCode).toBe(0);

      // Step 2: inspect
      const inspectResult = runCli(['inspect', '--log', outputLog]);

      expect(inspectResult.exitCode).toBe(0);
      expect(inspectResult.stdout).toContain('InspectTestAsset');
      // Should show event timeline
      expect(inspectResult.stdout).toMatch(/create|CREATE/i);
    },
    30_000
  );

  // ── Command help flags ────────────────────────────────────────────────────

  test('create --help prints create-specific help and exits 0', () => {
    const { stdout, exitCode } = runCli(['create', '--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('--name');
    expect(stdout).toContain('--file');
  });

  test('verify --help prints verify-specific help and exits 0', () => {
    const { stdout, exitCode } = runCli(['verify', '--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('--log');
  });
});
