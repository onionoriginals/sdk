import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OriginalsSDK } from '../../../src';
import { Ed25519Verifier } from '../../../src/did/Ed25519Verifier';
import type { AssetResource } from '../../../src/types';

/**
 * Pre-release blocker: migrateToDIDWebVH used the ENTIRE did:peer numalgo-4
 * suffix (~384 chars for a one-key DID) as a single did:webvh path segment.
 * That segment becomes a directory name in saveDIDLog, blowing the 255-byte
 * filename limit (ENAMETOOLONG) — the migrated DID was unhostable.
 *
 * The slug must be short (every path/DID segment <= 255 bytes), stable
 * (same peer DID -> same slug), and filesystem-safe.
 */

const resources: AssetResource[] = [
  { id: 'r1', type: 'data', contentType: 'application/json', hash: 'cafebabe' }
];

describe('migrateToDIDWebVH slug (ENAMETOOLONG blocker)', () => {
  const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webvh-slug-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('migrating a real (long-form) did:peer with an outputDir writes a hostable log and the DID resolves', async () => {
    // A genuine numalgo-4 did:peer — its suffix is hash + full encoded
    // document, far beyond 255 bytes.
    const peer = await sdk.did.createDIDPeer(resources);
    expect(peer.id.length).toBeGreaterThan(255);

    const result = await sdk.did.migrateToDIDWebVH(peer, 'example.com', { outputDir: tempDir });

    // The log was actually written (this line threw ENAMETOOLONG before the fix).
    expect(result.logPath).toBeDefined();
    const stat = await fs.promises.stat(result.logPath as string);
    expect(stat.isFile()).toBe(true);

    // Every filesystem path segment fits within the 255-byte filename limit.
    for (const segment of (result.logPath as string).split(path.sep)) {
      expect(Buffer.byteLength(segment, 'utf8')).toBeLessThanOrEqual(255);
    }

    // Every DID segment (SCID, domain, slug) is hostable too: the slug maps
    // 1:1 to a directory name on the hosting web server.
    for (const segment of result.did.split(':')) {
      expect(Buffer.byteLength(segment, 'utf8')).toBeLessThanOrEqual(255);
    }

    // The saved log round-trips and the DID resolves from it.
    const savedLog = await sdk.did.loadDIDLog(result.logPath as string);
    const { resolveDIDFromLog } = await import('didwebvh-ts') as unknown as {
      resolveDIDFromLog: (log: unknown, options?: { verifier?: unknown }) => Promise<{ did: string; doc: { id: string } }>;
    };
    const resolved = await resolveDIDFromLog(savedLog, { verifier: new Ed25519Verifier() });
    expect(resolved.doc.id).toBe(result.did);
  }, 30000);

  test('slug is stable: migrating the same did:peer twice yields the same slug segment', async () => {
    const peer = await sdk.did.createDIDPeer(resources);
    const a = await sdk.did.migrateToDIDWebVH(peer, 'example.com');
    const b = await sdk.did.migrateToDIDWebVH(peer, 'example.com');
    // did:webvh:{SCID}:{domain}:{slug} — SCIDs differ (fresh keys), slugs match.
    const slugA = a.did.split(':').slice(4).join(':');
    const slugB = b.did.split(':').slice(4).join(':');
    expect(slugA.length).toBeGreaterThan(0);
    expect(slugA).toBe(slugB);
  }, 30000);

  test('short peer suffixes keep the human-readable slug (backwards compatible)', async () => {
    const migration = await sdk.did.migrateToDIDWebVH(
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc123' },
      'example.com'
    );
    expect(migration.did.split(':')[4]).toBe('abc123');
  }, 30000);
});
