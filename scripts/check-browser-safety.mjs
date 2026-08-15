#!/usr/bin/env node
/**
 * Fail the build if a browser-facing entry point statically imports a Node
 * builtin.
 *
 * Node-only features (filesystem logging, LocalStorageAdapter, did:webvh log
 * persistence) are fine — they just have to load their modules lazily, so a
 * browser or edge runtime can import the package and use everything else. A
 * single static `import 'node:fs'` anywhere in the graph breaks that for every
 * consumer, which is easy to reintroduce and invisible until someone bundles.
 *
 * Dynamic `import()` is deliberately not counted: that is the fix, not the bug.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entry points that must stay importable in a browser, per package dist. */
const GUARDED_ENTRIES = [
  { dist: 'packages/sdk/dist', entry: 'index.js' },
  { dist: 'packages/sdk/dist', entry: 'lifecycle/LifecycleManager.js' },
  { dist: 'packages/sdk/dist', entry: 'lifecycle/OriginalsAsset.js' },
  { dist: 'packages/sdk/dist', entry: 'cel/index.js' },
  { dist: 'packages/cel/dist', entry: 'index.js' },
];

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const STATIC_FROM = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function staticSpecifiers(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const re of [STATIC_FROM, BARE_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  if (base.endsWith('.js') && existsSync(base)) return base;
  for (const candidate of [`${base}.js`, `${base}/index.js`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Breadth-first so the reported chain is the shortest one that pulls the builtin in. */
function findEagerBuiltins(entry, dist) {
  const seen = new Set();
  const violations = new Map();
  const queue = [[entry, [relative(dist, entry)]]];
  while (queue.length) {
    const [file, chain] = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(file)) {
      if (builtins.has(spec)) {
        if (!violations.has(spec)) violations.set(spec, chain);
        continue;
      }
      const next = resolveRelative(file, spec);
      if (next && !seen.has(next)) queue.push([next, [...chain, relative(dist, next)]]);
    }
  }
  return violations;
}

let failed = false;
for (const { dist, entry } of GUARDED_ENTRIES) {
  const distAbs = resolve(ROOT, dist);
  const abs = resolve(distAbs, entry);
  const label = `${dist}/${entry}`;
  if (!existsSync(abs)) {
    console.error(`✗ ${label} — not found in dist. Run \`bun run build\` first.`);
    failed = true;
    continue;
  }
  const violations = findEagerBuiltins(abs, distAbs);
  if (violations.size === 0) {
    console.log(`✓ ${label} — no Node builtins statically reachable`);
    continue;
  }
  failed = true;
  console.error(`✗ ${label} — ${violations.size} Node builtin(s) statically reachable:`);
  for (const [builtin, chain] of violations) {
    console.error(`    ${builtin}`);
    console.error(`      via ${chain.join(' -> ')}`);
  }
}

if (failed) {
  console.error(
    '\nBrowser-safety check failed. Load the Node module lazily instead:\n' +
      "  let fs = null;\n" +
      "  async function loadNodeModules() { fs ??= await import('node:fs/promises'); return fs; }\n" +
      '\nSee FileLogOutput in src/utils/Logger.ts for the established pattern.'
  );
  process.exit(1);
}

console.log('\nBrowser-safety check passed: every guarded entry point is free of eager Node builtins.');
