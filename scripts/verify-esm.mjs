#!/usr/bin/env node
/**
 * Verifies the BUILT package imports cleanly under Node's ESM resolver.
 *
 * Bun tolerates extensionless relative imports and attribute-less JSON imports,
 * so the Bun-based test suite cannot catch a `dist/` that is unimportable by
 * Node consumers (the npm audience). This script imports the built artifact with
 * `node` itself — transitively resolving the whole module graph — so a broken
 * publish (missing `.js` extensions, missing `with { type: 'json' }`, bad
 * `exports` map) fails CI instead of shipping.
 *
 * Run AFTER `bun run build`. Exits non-zero on the first failure.
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// [label, absolute path to a built entry that must import under Node ESM]
const targets = [
  ['sdk: main entry', 'packages/sdk/dist/index.js'],
  // A subpath that exercises the deep module graph (json contexts + many files).
  ['sdk: did/DIDManager subpath', 'packages/sdk/dist/did/DIDManager.js'],
  ['sdk: vc/CredentialManager subpath', 'packages/sdk/dist/vc/CredentialManager.js'],
  ['auth: main entry', 'packages/auth/dist/index.js'],
];

let failures = 0;
for (const [label, rel] of targets) {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) {
    console.error(`✗ ${label}: built file missing (${rel}) — did 'bun run build' run?`);
    failures++;
    continue;
  }
  try {
    await import(pathToFileURL(abs).href);
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}: ${err?.code ?? ''} ${err?.message ?? err}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\nESM verification FAILED (${failures} import error(s)). The built package is not consumable by Node ESM consumers.`);
  process.exit(1);
}
console.log('\nESM verification passed: built package imports cleanly under Node.');
