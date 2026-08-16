/**
 * LANDING-006 — the shipped "First Light" example actually verifies.
 *
 * The page's whole claim is that a visitor's browser re-checks these artifacts
 * rather than trusting the page. Nothing asserted it: the headless smoke test
 * gates on the absence of console errors, and every check in `verifyExample`
 * fails SOFTLY — a failed hash, an unverifiable DID log or a bad credential all
 * render as a red row, not a thrown error. So the example could have been
 * regenerated wrong, or rotted against an SDK change, and CI would stay green
 * while the page told every visitor "verification failed".
 *
 * This asserts allOk, and each check individually so a failure names itself.
 */
import { describe, test, expect } from 'bun:test';
import { verifyExample } from './verify-example';
import manifestJson from '../../public/example/manifest.json';

// Real Ed25519 + did:webvh log resolution + credential verification.
const TIMEOUT_MS = 30_000;

describe('verifyExample — the shipped real example', () => {
  test(
    'every check passes',
    async () => {
      const result = await verifyExample();

      const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
      expect(failed).toEqual([]);
      expect(result.allOk).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    'the artwork hash is recomputed from the shipped bytes, not read from the manifest',
    async () => {
      const result = await verifyExample();
      const hash = result.checks.find((c) => c.id === 'hash');

      expect(hash?.ok).toBe(true);
      // The detail line proves bytes were actually hashed.
      expect(hash?.detail).toMatch(/sha-256 recomputed from \d+ bytes/);
    },
    TIMEOUT_MS
  );

  test(
    'the did:webvh log verifies to the DID the manifest declares',
    async () => {
      const result = await verifyExample();
      const log = result.checks.find((c) => c.id === 'log');

      expect(log?.ok).toBe(true);
      expect(log?.detail).toMatch(/signed log entr(y|ies) verified/);
      expect(result.dids.webvh).toBe(
        (manifestJson as unknown as { dids: Record<string, string> }).dids['did:webvh']
      );
    },
    TIMEOUT_MS
  );

  test(
    'the publication credential is signed by the did:cel the CEL log derives',
    async () => {
      const result = await verifyExample();
      const credential = result.checks.find((c) => c.id === 'credential');

      expect(credential?.ok).toBe(true);
      expect(credential?.detail).toMatch(/signature valid, issuer matches/);
      // resolveDidCel returns null unless the WHOLE chain verifies and binds
      // to this DID, so a passing credential check implies a verified chain.
      expect(result.dids.cel.startsWith('did:cel:')).toBe(true);
    },
    TIMEOUT_MS
  );

  test(
    'the rendered summary is derived from the artifacts',
    async () => {
      const result = await verifyExample();
      const manifest = manifestJson as unknown as { title: string; medium: string };

      expect(result.title).toBe(manifest.title);
      expect(result.medium).toBe(manifest.medium);
      expect(result.credentialTypes.length).toBeGreaterThan(0);
      expect(result.artworkDataUri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
      expect(decodeURIComponent(result.artworkDataUri.split(',')[1])).toContain('<svg');
    },
    TIMEOUT_MS
  );
});
