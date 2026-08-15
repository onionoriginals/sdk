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
  { dist: 'packages/cel/dist', entry: 'index.js', browserFirst: true },
  // @originals/auth's root is types + the isomorphic turnkeySignBytes, and its
  // client entry runs in a browser by definition. Neither was guarded, which is
  // how a Buffer-dependent "isomorphic" export shipped green (plan 046, item 2).
  { dist: 'packages/auth/dist', entry: 'index.js', browserFirst: true },
  { dist: 'packages/auth/dist', entry: 'client/index.js', browserFirst: true },
];

/**
 * `Buffer` is a Node global, not an import, so the builtin scan above cannot
 * see it — a guarded entry can reference it and still pass. In a browser
 * without a bundler shim that is a ReferenceError on first use.
 *
 * This GATES only the `browserFirst` entries (@originals/cel, @originals/auth),
 * whose whole reason to exist is running in a browser. The SDK's entries import
 * Node-only paths (inscription builders, server providers) that a browser
 * consumer can import but would never call, so Buffer there is reported as a
 * warning rather than failing the build — a static scan cannot tell "reachable"
 * from "actually invoked in a browser".
 */
const BUFFER_GLOBAL = /(?<![.\w$])Buffer\s*\.\s*(?:from|alloc|allocUnsafe|concat|isBuffer|byteLength)\b/;

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
function findBufferGlobals(entry, dist) {
  const seen = new Set();
  const hits = new Map();
  const queue = [[entry, [relative(dist, entry)]]];
  while (queue.length) {
    const [file, chain] = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (BUFFER_GLOBAL.test(readFileSync(file, 'utf8')) && !hits.has(file)) {
      hits.set(file, chain);
    }
    for (const spec of staticSpecifiers(file)) {
      const next = resolveRelative(file, spec);
      if (next && !seen.has(next)) queue.push([next, [...chain, relative(dist, next)]]);
    }
  }
  return hits;
}

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
for (const { dist, entry, browserFirst = false } of GUARDED_ENTRIES) {
  const distAbs = resolve(ROOT, dist);
  const abs = resolve(distAbs, entry);
  const label = `${dist}/${entry}`;
  if (!existsSync(abs)) {
    console.error(`✗ ${label} — not found in dist. Run \`bun run build\` first.`);
    failed = true;
    continue;
  }
  const violations = findEagerBuiltins(abs, distAbs);
  const bufferHits = browserFirst ? findBufferGlobals(abs, distAbs) : new Map();
  const bufferAdvisory = browserFirst ? new Map() : findBufferGlobals(abs, distAbs);
  if (bufferAdvisory.size > 0) {
    console.warn(`! ${label} — Buffer global reachable in ${bufferAdvisory.size} module(s) (advisory):`);
    for (const [file] of bufferAdvisory) console.warn(`    ${relative(distAbs, file)}`);
  }
  if (violations.size === 0 && bufferHits.size === 0) {
    const note = bufferAdvisory.size > 0 ? ' (Buffer advisory above)' : '';
    console.log(`✓ ${label} — no eager Node builtins${browserFirst ? ' or Buffer globals' : ''}${note}`);
    continue;
  }
  failed = true;
  if (violations.size > 0) {
    console.error(`✗ ${label} — ${violations.size} Node builtin(s) statically reachable:`);
    for (const [builtin, chain] of violations) {
      console.error(`    ${builtin}`);
      console.error(`      via ${chain.join(' -> ')}`);
    }
  }
  if (bufferHits.size > 0) {
    console.error(`✗ ${label} — Buffer global reachable in ${bufferHits.size} module(s):`);
    for (const [file, chain] of bufferHits) {
      console.error(`    ${relative(distAbs, file)}`);
      console.error(`      via ${chain.join(' -> ')}`);
    }
  }
}

if (failed) {
  console.error(
    '\nBrowser-safety check failed. Load the Node module lazily instead:\n' +
      "  let fs = null;\n" +
      "  async function loadNodeModules() { fs ??= await import('node:fs/promises'); return fs; }\n" +
      '\nSee FileLogOutput in src/utils/Logger.ts for the established pattern.' +
      '\n\nFor Buffer: use Uint8Array, and @noble/hashes/utils bytesToHex/hexToBytes\n' +
      'for hex conversion. Buffer is a Node global — in a browser it is a\n' +
      'ReferenceError, which no import scan can catch.'
  );
  process.exit(1);
}

console.log('\nBrowser-safety check passed: every guarded entry point is free of eager Node builtins.');
