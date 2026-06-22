/**
 * CLI Create Command - Boundary Tests
 *
 * Covers:
 * - CEL-CLI-001/boundary: Create asset with large file → external reference hash computed correctly
 * - CEL-CLI-014/boundary: Tilde (~) expansion in file paths → assert REAL behavior
 *
 * Note on CEL-CLI-014 (tilde paths):
 *   The create CLI calls fs.existsSync(flags.file) directly without any shell tilde expansion.
 *   Node.js fs does NOT expand "~" — it treats it as a literal directory name.
 *   Therefore a path like "~/foo.bin" that does NOT exist as a literal path on disk
 *   returns "File not found". This is the real, correct behavior of the code;
 *   there is no expansion. The test asserts this actual behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createCommand } from '../../../src/cel/cli/create';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import { createExternalReference, verifyExternalReference } from '../../../src/cel/ExternalReferenceManager';
import { multikey } from '../../../src/crypto/Multikey';

describe('CLI create command - boundary [CEL-CLI-001 / CEL-CLI-014]', () => {
  let tempDir: string;
  let testKeyPath: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-cli-boundary-'));

    // Generate and persist a shared key for tests that need one
    const ed25519 = await import('@noble/ed25519');
    const privateKeyBytes = ed25519.utils.randomPrivateKey();
    const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
    testKeyPath = path.join(tempDir, 'shared-key.json');
    fs.writeFileSync(testKeyPath, JSON.stringify({ privateKey }));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // CEL-CLI-001: Large file → hash computed correctly
  // ---------------------------------------------------------------------------

  describe('CEL-CLI-001 – large file external reference hash', () => {
    it('creates a correct digestMultibase for a 1 MB file', async () => {
      // Build a 1 MB file with a deterministic pattern
      const SIZE = 1024 * 1024;
      const content = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) {
        content[i] = i % 256;
      }

      const largePath = path.join(tempDir, 'large-1mb.bin');
      fs.writeFileSync(largePath, content);

      const outputPath = path.join(tempDir, 'large-1mb.cel.json');
      const result = await createCommand({
        name: 'Large File Asset',
        file: largePath,
        key: testKeyPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);

      // Parse the event log and inspect the resource reference
      const logJson = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(logJson);

      expect(log.events).toHaveLength(1);
      const data = log.events[0].data as any;
      expect(data.resources).toHaveLength(1);

      const resource = data.resources[0];
      expect(resource.digestMultibase).toBeTruthy();
      expect(resource.mediaType).toBe('application/octet-stream');

      // Independently compute the expected digest and compare
      const expectedRef = createExternalReference(content, 'application/octet-stream');
      expect(resource.digestMultibase).toBe(expectedRef.digestMultibase);

      // Additionally confirm that verifyExternalReference validates it
      expect(verifyExternalReference(resource, content)).toBe(true);
    });

    it('creates a correct digestMultibase for a 4 MB file with non-trivial content', async () => {
      const SIZE = 4 * 1024 * 1024;
      const content = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) {
        content[i] = (i * 17 + 3) % 256;
      }

      const largePath = path.join(tempDir, 'large-4mb.bin');
      fs.writeFileSync(largePath, content);

      const outputPath = path.join(tempDir, 'large-4mb.cel.json');
      const result = await createCommand({
        name: '4MB File Asset',
        file: largePath,
        key: testKeyPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);

      const logJson = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(logJson);
      const data = log.events[0].data as any;
      const resource = data.resources[0];

      const expectedRef = createExternalReference(content, 'application/octet-stream');
      expect(resource.digestMultibase).toBe(expectedRef.digestMultibase);
      expect(verifyExternalReference(resource, content)).toBe(true);
    });

    it('produces a different digest for a modified large file', async () => {
      const SIZE = 512 * 1024;
      const content = new Uint8Array(SIZE).fill(0xAA);

      const filePath = path.join(tempDir, 'large-original.bin');
      fs.writeFileSync(filePath, content);

      const outputPath = path.join(tempDir, 'large-original.cel.json');
      await createCommand({
        name: 'Original',
        file: filePath,
        key: testKeyPath,
        output: outputPath,
      });

      const logJson = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(logJson);
      const originalDigest = (log.events[0].data as any).resources[0].digestMultibase;

      // Modify one byte and create again
      const modified = new Uint8Array(content);
      modified[SIZE >> 1] = 0xBB;

      const modifiedPath = path.join(tempDir, 'large-modified.bin');
      fs.writeFileSync(modifiedPath, modified);

      const modOutputPath = path.join(tempDir, 'large-modified.cel.json');
      await createCommand({
        name: 'Modified',
        file: modifiedPath,
        key: testKeyPath,
        output: modOutputPath,
      });

      const modLogJson = fs.readFileSync(modOutputPath, 'utf-8');
      const modLog = parseEventLogJson(modLogJson);
      const modifiedDigest = (modLog.events[0].data as any).resources[0].digestMultibase;

      expect(originalDigest).not.toBe(modifiedDigest);
    });

    it('hash is stable – same large file produces the same digest across two runs', async () => {
      const SIZE = 128 * 1024;
      const content = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) {
        content[i] = (i * 31) % 256;
      }

      const filePath = path.join(tempDir, 'stable-hash.bin');
      fs.writeFileSync(filePath, content);

      const out1 = path.join(tempDir, 'stable-hash-run1.cel.json');
      const out2 = path.join(tempDir, 'stable-hash-run2.cel.json');

      await createCommand({ name: 'Run1', file: filePath, key: testKeyPath, output: out1 });
      await createCommand({ name: 'Run2', file: filePath, key: testKeyPath, output: out2 });

      const digest1 = (parseEventLogJson(fs.readFileSync(out1, 'utf-8')).events[0].data as any)
        .resources[0].digestMultibase;
      const digest2 = (parseEventLogJson(fs.readFileSync(out2, 'utf-8')).events[0].data as any)
        .resources[0].digestMultibase;

      expect(digest1).toBe(digest2);
    });
  });

  // ---------------------------------------------------------------------------
  // CEL-CLI-014: Tilde (~) expansion in file paths
  //
  // The create CLI calls fs.existsSync(flags.file) with the literal string the
  // caller provides. Node.js fs does NOT expand "~" – there is no shell
  // interpolation. Therefore:
  //   - A path like "~/nonexistent.bin" (where no literal "~" directory exists)
  //     is treated as a missing file and the CLI returns "File not found".
  //   - A tilde-prefixed path that DOES exist as a literal directory/file would
  //     be found. We cannot guarantee a literal ~/... exists, so we only test
  //     the non-expansion (missing-file) path, which is the safety-relevant case.
  // ---------------------------------------------------------------------------

  describe('CEL-CLI-014 – tilde path expansion is NOT performed', () => {
    it('treats "~/nonexistent-file-that-cannot-exist.bin" as a literal missing path', async () => {
      // This path is deliberately nonsensical so it will never exist as a literal
      const tildePath = '~/nonexistent-cel-test-boundary-file-12345.bin';

      const result = await createCommand({
        name: 'Tilde Test',
        file: tildePath,
      });

      // The CLI must NOT silently succeed (no tilde expansion happens at the
      // application level — that is a shell responsibility).
      expect(result.success).toBe(false);
      // The error message should mention the file not being found
      expect(result.message).toContain('File not found');
    });

    it('returns File-not-found for a tilde path referencing a name that likely has no literal dir', async () => {
      // Even if the user's home directory IS the cwd, there is no file
      // named "nonexistent-for-cel-test-abc.bin" there.
      const tildePath = '~/nonexistent-for-cel-test-abc.bin';

      const result = await createCommand({
        name: 'Tilde Path Asset',
        file: tildePath,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/File not found/i);
    });

    it('succeeds when a literal path coincidentally starts with tilde character in a temp dir', async () => {
      // Create an actual file whose name starts with a literal ~ in the temp dir
      const literalTildeFile = path.join(tempDir, '~tilde-prefixed-file.txt');
      fs.writeFileSync(literalTildeFile, 'hello tilde');

      const outputPath = path.join(tempDir, 'tilde-literal-output.cel.json');

      const result = await createCommand({
        name: 'Literal Tilde File',
        file: literalTildeFile, // absolute path — works fine
        key: testKeyPath,
        output: outputPath,
      });

      // An absolute path to a real file with ~ in the name should succeed
      expect(result.success).toBe(true);

      const logJson = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(logJson);
      expect(log.events[0].type).toBe('create');

      // The digest must match the actual file content
      const fileContent = new Uint8Array(fs.readFileSync(literalTildeFile));
      const resource = (log.events[0].data as any).resources[0];
      expect(verifyExternalReference(resource, fileContent)).toBe(true);
    });
  });
});
