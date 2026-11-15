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
 * extensions, missing `with { type: "json" }`, or a broken `exports` map) fails
 * CI instead of shipping.
 *
 * Every public entry point is checked: the specifier list is generated from the
 * `exports` field of each package (wildcard subpaths like `./did/*` are expanded
 * against the built files), so a regression in any exported subpath is caught —
 * not just a hand-picked few.
 *
 * To exercise the real `exports` map without a network install, we expose each
 * package under its published name via a temporary scoped symlink in the repo's
 * node_modules, then import by bare specifier. Node applies the `exports` field
 * for bare specifiers regardless of how the package landed in node_modules, and
 * transitive deps (incl. auth's dependency on @originals/sdk) resolve from the
 * monorepo root — so auth is tested against the LOCAL sdk, not the published one.
 *
 * It also guards what is unreleased: EVM anchoring (originals-spec PR 59) is
 * built but not part of the published API until the spec pins an anchor
 * contract (P14.21; owner decision, 14 November 2026). No exported entry point
 * may export an EVM name at run time, and no published declaration reachable
 * from an export map's `types` may declare or reference one.
 *
 * Run AFTER `bun run build`. Exits non-zero on the first failure.
 */
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, symlinkSync, rmdirSync, readdirSync, statSync, lstatSync, realpathSync, renameSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(repoRoot, 'node_modules');

const packages = [
  { name: '@originals/vh', dir: 'packages/vh' },
  { name: '@originals/sdk', dir: 'packages/sdk' },
  { name: '@originals/auth', dir: 'packages/auth' },
];

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

const toPosix = (p) => p.split(sep).join('/');

// Build the full set of bare specifiers a consumer could import, derived from
// the package's `exports` map. Wildcard subpaths (`./did/*` -> `./dist/did/*.js`)
// are expanded against the actual built files so every exported module is tested.
function specifiersFromExports(pkg) {
  const pkgDir = resolve(repoRoot, pkg.dir);
  const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const exportsField = json.exports ?? { '.': { import: './dist/index.js' } };
  const specs = new Set();
  const distFiles = walkFiles(join(pkgDir, 'dist'))
    .map((f) => './' + toPosix(relative(pkgDir, f)))
    .filter((f) => f.endsWith('.js'));

  for (const [key, val] of Object.entries(exportsField)) {
    if (key === './package.json') continue;
    const importPath = typeof val === 'string' ? val : (val?.import ?? val?.default);
    if (!importPath) continue;

    if (key.includes('*')) {
      const [impPre, impSuf] = importPath.split('*'); // e.g. "./dist/did/" , ".js"
      const [keyPre, keySuf] = key.split('*');         // e.g. "./did/"     , ""
      if (!impSuf) continue; // guard against an open-ended pattern
      for (const f of distFiles) {
        if (!f.startsWith(impPre) || !f.endsWith(impSuf)) continue;
        const star = f.slice(impPre.length, f.length - impSuf.length);
        if (!star || star.includes('..')) continue;
        specs.add(pkg.name + keyPre.slice(1) + star + keySuf.slice(1));
      }
    } else {
      specs.add(pkg.name + (key === '.' ? '' : key.slice(1)));
    }
  }
  return [...specs].sort();
}

/** A runtime export name of unreleased EVM anchoring (P14.21). */
const EVM_NAME = /evm/i;
/** An EVM declaration or reference in a .d.ts line (string literals such as "evm-proven" aside). */
const EVM_DECLARATION = /\b(Evm[A-Z]\w*|EVM_\w+|\w+Evm\b|evm\??:)|@originals\/vh\/internal\//;

/**
 * The published declarations of a package: every .d.ts reachable through
 * relative imports from an unconditional `types` target of its export map.
 * Returns the lines that declare or reference EVM anchoring, outside comments
 * and private members.
 */
function evmDeclarations(pkg) {
  const pkgDir = resolve(repoRoot, pkg.dir);
  const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const seen = new Set();
  const hits = [];
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (/^(\*|\/\/|\/\*|private )/.test(t)) return;
      if (EVM_DECLARATION.test(t)) hits.push(`${toPosix(relative(repoRoot, file))}:${i + 1}: ${t.slice(0, 160)}`);
    });
    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']|import\(["'](\.[^"']+)["']\)/g)) {
      visit(join(dirname(file), (m[1] ?? m[2]).replace(/\.js$/, '.d.ts')));
    }
  };
  for (const value of Object.values(json.exports ?? {})) {
    if (typeof value === 'object' && value !== null && typeof value.types === 'string') visit(join(pkgDir, value.types));
  }
  return hits;
}

const createdLinks = [];
// Point node_modules/<name> at the freshly built workspace package. Never trust a
// pre-existing link/dir unless it resolves to this workspace. Preserve the
// installation: hoisted Bun layouts need these links after this check finishes.
function linkPackage(name, dir) {
  const target = resolve(repoRoot, dir);
  const linkPath = join(nodeModules, ...name.split('/')); // node_modules/@originals/sdk
  mkdirSync(dirname(linkPath), { recursive: true });
  try { if (realpathSync(linkPath) === realpathSync(target)) return; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let backup;
  try {
    lstatSync(linkPath); // Also preserve a dangling symlink.
    const directory = mkdtempSync(join(dirname(linkPath), '.verify-esm-'));
    backup = join(directory, 'original');
    renameSync(linkPath, backup);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  createdLinks.push({ linkPath, backup });
  symlinkSync(target, linkPath, 'dir');
}

let failures = 0;
let checked = 0;
try {
  const allTargets = [];
  for (const p of packages) {
    if (!existsSync(resolve(repoRoot, p.dir, 'dist/index.js'))) {
      console.error(`✗ ${p.name}: dist/index.js missing — did 'bun run build' run?`);
      failures++;
    }
    linkPackage(p.name, p.dir);
    allTargets.push(...specifiersFromExports(p));
  }

  for (const spec of allTargets) {
    try {
      const mod = await import(spec);
      const leaked = Object.keys(mod).filter((k) => EVM_NAME.test(k));
      if (leaked.length > 0) {
        console.error(`✗ ${spec}: exports unreleased EVM anchoring (P14.21): ${leaked.join(', ')}`);
        failures++;
        continue;
      }
      checked++;
    } catch (err) {
      console.error(`✗ ${spec}: ${err?.code ?? ''} ${err?.message ?? err}`);
      failures++;
    }
  }
  if (failures === 0) console.log(`✓ ${checked} exported entry point(s) import cleanly under Node`);
  for (const p of packages) {
    const hits = evmDeclarations(p);
    for (const hit of hits) console.error(`✗ ${p.name} declares unreleased EVM anchoring (P14.21): ${hit}`);
    failures += hits.length;
  }
  if (failures === 0) console.log('✓ no published entry point exports or declares EVM anchoring (P14.21)');
} finally {
  for (const { linkPath, backup } of createdLinks.reverse()) {
    // unlinkSync removes the symlink itself (never its target).
    try { unlinkSync(linkPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (backup) {
      renameSync(backup, linkPath);
      rmdirSync(dirname(backup));
    }
  }
}

if (failures > 0) {
  console.error(`\nESM verification FAILED (${failures} error(s)). The built package is not consumable by Node ESM consumers.`);
  process.exit(1);
}
console.log('\nESM verification passed: every exported entry point imports cleanly under Node via the exports maps.');
