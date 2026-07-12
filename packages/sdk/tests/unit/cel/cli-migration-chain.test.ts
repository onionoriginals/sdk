/**
 * CLI two-step migration chain (Task 8 — closes the Task 7 review break)
 *
 * Drives the full CLI chain over MANAGER-PRODUCED logs:
 *   create (did:cel genesis) → migrate --to webvh → migrate --to btco
 *
 * (No transfer step: ownership is sat control, not a CEL write — an offline log
 * CLI can't move a sat, so the transfer command was removed in Phase 4.)
 *
 * The Task 7 break: `migrate --to webvh` writes a `migrate`-typed event, but
 * the CLI's detectCurrentLayer/getCurrentDid sniffed only `update`-typed
 * migration events, so the follow-up `migrate --to btco` mis-detected layer
 * `peer` and threw "Cannot migrate directly from peer to btco".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createCommand } from '../../../src/cel/cli/create';
import { migrateCommand } from '../../../src/cel/cli/migrate';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import { multikey } from '../../../src/crypto/Multikey';

async function createTestWallet(dir: string): Promise<string> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomSecretKey();
  const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
  const walletPath = path.join(dir, 'chain-wallet.key');
  fs.writeFileSync(walletPath, privateKey);
  return walletPath;
}

describe('CLI two-step migration chain (peer → webvh → btco)', () => {
  let tempDir: string;
  let contentPath: string;
  let walletPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-chain-test-'));
    contentPath = path.join(tempDir, 'content.txt');
    fs.writeFileSync(contentPath, 'chain test content');
    walletPath = await createTestWallet(tempDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('create surfaces the derived did:cel in its result', async () => {
    const outputPath = path.join(tempDir, 'asset.cel.json');
    const result = await createCommand({
      name: 'Chain Asset',
      file: contentPath,
      key: walletPath,
      output: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.did).toBeDefined();
    expect(result.did!.startsWith('did:cel:')).toBe(true);
  });

  it('migrates a fresh did:cel-genesis log to webvh, then to btco', async () => {
    const peerPath = path.join(tempDir, 'asset.cel.json');
    const webvhPath = path.join(tempDir, 'asset.webvh.cel.json');
    const btcoPath = path.join(tempDir, 'asset.btco.cel.json');

    // Step 0: create — new-shape genesis (no embedded did/layer)
    const createResult = await createCommand({
      name: 'Chain Asset',
      file: contentPath,
      key: walletPath,
      output: peerPath,
    });
    expect(createResult.success).toBe(true);

    // Step 1: peer → webvh (writes a first-class `migrate` event)
    const webvhResult = await migrateCommand({
      log: peerPath,
      to: 'webvh',
      domain: 'example.com',
      wallet: walletPath,
      output: webvhPath,
    });
    expect(webvhResult.success).toBe(true);
    expect(webvhResult.sourceDid).toMatch(/^did:cel:/);
    expect(webvhResult.targetDid).toContain('did:webvh:example.com');

    const webvhLog = parseEventLogJson(fs.readFileSync(webvhPath, 'utf-8'));
    expect(webvhLog.events[webvhLog.events.length - 1].type).toBe('migrate');

    // Step 2: webvh → btco — the Task 7 break: detection must see the
    // `migrate`-typed event and report layer webvh, not peer.
    const btcoResult = await migrateCommand({
      log: webvhPath,
      to: 'btco',
      wallet: walletPath,
      output: btcoPath,
    });
    expect(btcoResult.success).toBe(true);
    expect(btcoResult.message).not.toContain('Cannot migrate directly');
    expect(btcoResult.targetLayer).toBe('btco');
    expect(btcoResult.sourceDid).toContain('did:webvh:example.com');
    expect(btcoResult.targetDid).toContain('did:btco');

    const btcoLog = parseEventLogJson(fs.readFileSync(btcoPath, 'utf-8'));
    expect(btcoLog.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate']);

    // Step 3: btco is terminal — a further migration must be rejected.
    const terminalResult = await migrateCommand({
      log: btcoPath,
      to: 'webvh',
      domain: 'other.com',
      wallet: walletPath,
    });
    expect(terminalResult.success).toBe(false);
    expect(terminalResult.message).toContain('Cannot migrate from btco layer');
  });

  it('legacy update-sniffed migration chain still detects webvh (fallback kept)', async () => {
    // Legacy log: genesis embeds did/layer; migration recorded as an `update`.
    const { createEventLog } = await import('../../../src/cel/algorithms/createEventLog');
    const { updateEventLog } = await import('../../../src/cel/algorithms/updateEventLog');
    const { serializeEventLogJson } = await import('../../../src/cel/serialization/json');

    const signer = async (data: unknown) => ({
      type: 'DataIntegrityProof' as const,
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: 'did:key:z6MkLegacy#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z3LegacyMockProof',
    });
    const opts = { signer, verificationMethod: 'did:key:z6MkLegacy#key-1', proofPurpose: 'assertionMethod' };

    let log = await createEventLog({
      name: 'Legacy Asset',
      did: 'did:peer:4z6MkLegacyChain',
      layer: 'peer',
      resources: [],
      creator: 'did:peer:4z6MkLegacyChain',
      createdAt: new Date().toISOString(),
    }, opts);
    log = await updateEventLog(log, {
      sourceDid: 'did:peer:4z6MkLegacyChain',
      targetDid: 'did:webvh:example.com:legacyid',
      layer: 'webvh',
      domain: 'example.com',
      migratedAt: new Date().toISOString(),
    }, opts);

    const legacyPath = path.join(tempDir, 'legacy.cel.json');
    const btcoPath = path.join(tempDir, 'legacy.btco.cel.json');
    fs.writeFileSync(legacyPath, serializeEventLogJson(log));

    const result = await migrateCommand({
      log: legacyPath,
      to: 'btco',
      wallet: walletPath,
      output: btcoPath,
    });

    expect(result.success).toBe(true);
    expect(result.sourceDid).toBe('did:webvh:example.com:legacyid');
    expect(result.targetLayer).toBe('btco');
  });
});
