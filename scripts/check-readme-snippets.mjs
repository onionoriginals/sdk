#!/usr/bin/env node
/**
 * Gate: the quick starts we ship must actually run.
 *
 * The failure this exists to prevent (launch review, item 2): the root README's
 * quick start — the first code any adopter executes — threw `NO_CUSTODY` on the
 * happy path, verbatim, against the built dist. Nothing caught it because
 * nothing had ever run it. Prose rots silently; only execution notices.
 *
 * Every fenced block preceded by `<!-- readme:run -->` is extracted, pointed at
 * the BUILT dist (not src — consumers get the dist, and a dist-only breakage is
 * exactly the class of bug the ESM gate exists for), and executed. A non-zero
 * exit fails this script with the snippet's own stderr.
 *
 * Marking is opt-in on purpose: most blocks in these files are illustrative
 * fragments that were never meant to run standalone. A block that claims to be
 * a quick start should carry the marker and earn it.
 *
 * Usage: bun run build && node scripts/check-readme-snippets.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Files whose marked snippets are executed. */
const DOCS = ['README.md', 'packages/sdk/README.md'];

const MARKER = '<!-- readme:run -->';

/** Built entry points a snippet's bare specifiers are rewritten to. */
const DIST = {
  '@originals/sdk/testing': join(ROOT, 'packages/sdk/dist/testing/index.js'),
  '@originals/sdk/types': join(ROOT, 'packages/sdk/dist/types/index.js'),
  '@originals/sdk/cel': join(ROOT, 'packages/sdk/dist/cel/index.js'),
  '@originals/sdk': join(ROOT, 'packages/sdk/dist/index.js'),
  '@originals/cel': join(ROOT, 'packages/cel/dist/index.js'),
};

for (const [spec, path] of Object.entries(DIST)) {
  if (!existsSync(path)) {
    console.error(
      `check-readme-snippets: ${path} is missing — run \`bun run build\` first ` +
        `(this gate runs against the built dist, which is what consumers get, not src).`
    );
    process.exit(1);
  }
}

/** Marked fenced blocks, with the line the fence opens on for error messages. */
function markedSnippets(file) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== MARKER) continue;
    // The fence may be separated from the marker by blank lines.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const open = lines[j] ?? '';
    if (!/^```(ts|typescript|js|javascript)\s*$/.test(open.trim())) {
      console.error(`check-readme-snippets: ${file}:${i + 1}: ${MARKER} is not followed by a ts/js code fence.`);
      process.exit(1);
    }
    const body = [];
    let k = j + 1;
    for (; k < lines.length && !lines[k].startsWith('```'); k++) body.push(lines[k]);
    if (k >= lines.length) {
      console.error(`check-readme-snippets: ${file}:${j + 1}: unterminated code fence.`);
      process.exit(1);
    }
    out.push({ file, line: j + 1, code: body.join('\n') });
    i = k;
  }
  return out;
}

/**
 * Point bare `@originals/*` specifiers at the built dist. Longest specifier
 * first so `@originals/sdk/testing` is not eaten by the `@originals/sdk` rule.
 */
function rewriteImports(code) {
  let out = code;
  for (const [spec, path] of Object.entries(DIST)) {
    out = out.replaceAll(`'${spec}'`, `'${path}'`).replaceAll(`"${spec}"`, `"${path}"`);
  }
  return out;
}

const snippets = DOCS.flatMap(markedSnippets);
if (snippets.length === 0) {
  console.error(`check-readme-snippets: no ${MARKER} blocks found — the quick starts lost their marker.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'readme-snippets-'));
let failed = 0;
try {
  for (const { file, line, code } of snippets) {
    const path = join(dir, `${file.replace(/[^a-z0-9]+/gi, '-')}-${line}.ts`);
    writeFileSync(path, rewriteImports(code));
    // Bun, not node: the snippets are TypeScript and use top-level await, which
    // is exactly how a Bun/tsx consumer runs them.
    const run = spawnSync('bun', ['run', path], { encoding: 'utf8', cwd: ROOT });
    if (run.status === 0) {
      console.log(`  ok   ${file}:${line}`);
      continue;
    }
    failed++;
    console.error(`  FAIL ${file}:${line} (exit ${run.status})`);
    const detail = [run.stdout, run.stderr].filter(Boolean).join('\n').trimEnd();
    console.error(detail.split('\n').map((l) => `       ${l}`).join('\n'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(
    `\ncheck-readme-snippets: ${failed} of ${snippets.length} documented snippet(s) do not run. ` +
      `This is the first code an adopter executes — fix the snippet or fix the API.`
  );
  process.exit(1);
}
console.log(`\ncheck-readme-snippets: ${snippets.length} documented snippet(s) run against the built dist.`);
