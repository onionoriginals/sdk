/**
 * Parity test: prevents re-duplication of canonical model types.
 *
 * If a new `interface DataIntegrityProof` or `interface ResourceVersion`
 * (or ResourceVersionHistory / ResourceHistory) appears outside the
 * canonical files, this test will fail.
 *
 * Canonical locations:
 *   - DataIntegrityProof  → src/types/proof.ts
 *   - ResourceVersion     → src/types/resource-version.ts
 *   - ResourceVersionHistory → src/types/resource-version.ts
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_DIR = join(__dirname, '../../../src');

/** Canonical source files that are allowed to define these interfaces */
const CANONICAL_FILES: Record<string, string> = {
  'DataIntegrityProof': 'types/proof.ts',
  'ResourceVersion': 'types/resource-version.ts',
  'ResourceVersionHistory': 'types/resource-version.ts',
};

/**
 * Recursively collect all .ts files under a directory
 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('no duplicate model definitions', () => {
  const allTsFiles = collectTsFiles(SRC_DIR);

  for (const [typeName, canonicalRelPath] of Object.entries(CANONICAL_FILES)) {
    test(`${typeName} is only defined in ${canonicalRelPath}`, () => {
      // Regex matches "interface TypeName" or "interface TypeName<" (generic)
      // but NOT "type TypeName =" (aliases are OK)
      const interfacePattern = new RegExp(
        `^\\s*export\\s+interface\\s+${typeName}\\b`,
        'm'
      );

      const violations: string[] = [];

      for (const filePath of allTsFiles) {
        const rel = relative(SRC_DIR, filePath);
        // Skip the canonical file itself
        if (rel === canonicalRelPath) continue;

        const content = readFileSync(filePath, 'utf-8');
        if (interfacePattern.test(content)) {
          violations.push(rel);
        }
      }

      expect(violations).toEqual([]);
    });
  }
});
