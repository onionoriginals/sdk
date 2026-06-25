#!/usr/bin/env node
/**
 * Verifies the BUILT packages import cleanly under Node's ESM resolver, using
 * the SAME resolution path npm consumers get: bare package specifiers routed
 * through each package.json `exports` map.
 *
 * Bun tolerates extensionless relative imports and attribute-less JSON imports,
 * so the Bun test suite cannot catch a `dist/` that Node consumers can't load.
 * This script imports the built artifacts with `node` itself — transitively
 * resolving the whole module graph — so a broken publish (missing `.js`
 * extensions, missing `with { type: 'json' }`, or a broken `exports` map) fails
 * CI instead of shipping.
 *
 * To exercise the real `exports` map without a network install, we expose each
 * package under its published name via a temporary scoped symlink in the repo's
 * node_modules, then import by bare specifier. Node applies the `exports` field
 * for bare specifiers regardless of how the package landed in node_modules, and
 * transitive deps (incl. auth's dependency on @originals/sdk) resolve from the
 * monorepo root — so auth is tested against the LOCAL sdk, not the published one.
 *
 * Run AFTER `bun run build`. Exits non-zero on the first failure.
 */
import { existsSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(repoRoot, 'node_modules');

// Packages to expose by published name so `import('<name>')` hits the exports map.
const packages = [
  { name: '@originals/sdk', dir: 'packages/sdk' },
  { name: '@originals/auth', dir: 'packages/auth' },
];

// Bare specifiers a consumer would use; each must resolve via exports and load.
const targets = [
  '@originals/sdk',                       // "." → deep graph incl. JSON contexts
  '@originals/sdk/did/DIDManager',        // "./did/*" subpath pattern
  '@originals/sdk/vc/CredentialManager',  // "./vc/*" subpath pattern
  '@originals/auth',                      // "." → also re-resolves @originals/sdk
];

const createdLinks = [];
function linkPackage(name, dir) {
  const linkPath = join(nodeModules, ...name.split('/')); // node_modules/@originals/sdk
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) return; // a real workspace link already exists — leave it
  symlinkSync(resolve(repoRoot, dir), linkPath, 'dir');
  createdLinks.push(linkPath);
}

let failures = 0;
try {
  for (const p of packages) {
    if (!existsSync(resolve(repoRoot, p.dir, 'dist/index.js'))) {
      console.error(`✗ ${p.name}: dist/index.js missing — did 'bun run build' run?`);
      failures++;
    }
    linkPackage(p.name, p.dir);
  }

  for (const spec of targets) {
    try {
      await import(spec);
      console.log(`✓ ${spec}`);
    } catch (err) {
      console.error(`✗ ${spec}: ${err?.code ?? ''} ${err?.message ?? err}`);
      failures++;
    }
  }
} finally {
  for (const link of createdLinks) {
    // unlinkSync removes the symlink itself (never its target), and—unlike
    // rmSync—works on a symlink-to-directory without `recursive`.
    try { unlinkSync(link); } catch { /* best-effort cleanup */ }
  }
}

if (failures > 0) {
  console.error(`\nESM verification FAILED (${failures} error(s)). The built package is not consumable by Node ESM consumers.`);
  process.exit(1);
}
console.log('\nESM verification passed: built packages import cleanly under Node via their exports maps.');
