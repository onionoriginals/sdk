#!/usr/bin/env node
/**
 * Gate: every install command we publish must resolve to the code we document.
 *
 * The failure this exists to prevent (launch review, item 1): the repo and every
 * doc described 3.x while `npm install @originals/sdk` resolved to 2.1.0 — a
 * major behind, with a different lifecycle API and no `./testing` subpath. An
 * outside developer followed the quick start against an SDK that no longer
 * existed and concluded the library was broken. Nothing in CI noticed, because
 * nothing in CI had ever asked the registry what our own install line returns.
 *
 * So: scrape every install command out of the shipped markdown, ask the registry
 * what each one actually resolves to, and require the answer to be on the same
 * MAJOR line as the workspace package it documents.
 *
 * Why major-only rather than an exact match: between merging the Version PR and
 * the publish job finishing, the workspace version is legitimately ahead of the
 * registry. Requiring equality would make that window red for a non-problem.
 * Major is the line where the API changes shape, which is exactly the breakage
 * this gate is for.
 *
 * Network failures FAIL, they do not skip — a gate that silently passes when it
 * could not check is the thing that let this ship in the first place. Same
 * choice release.yml already makes for its registry probe.
 *
 * Usage: node scripts/check-install-docs.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Directories that are not the shipped docs: historical planning material and
 * vendored code. `legacy/` in particular documents an SDK that is gone.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'legacy', 'plans', 'tasks',
  'specs', 'migrations', '.changeset', '.turbo', 'viewer', 'badges',
]);

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Install commands inside FENCED SHELL BLOCKS only. Prose that quotes a bare
 * `npm install @originals/sdk` to explain why you should not run it is not an
 * instruction, and flagging it would push the docs into never naming the wrong
 * command even to warn about it.
 */
const FENCE = /^```(bash|sh|shell|console|zsh)\s*$/;
const INSTALL = /\b(?:npm\s+(?:install|i|add)|bun\s+add|yarn\s+add|pnpm\s+add)\s+(?:-g\s+|--global\s+)?(@originals\/[a-z0-9-]+(?:@[^\s`]+)?)/g;

function installSpecs(file) {
  const found = [];
  let inFence = false;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('```')) {
      // A fence closes whatever is open; otherwise it opens one only if it is a
      // shell block. Non-shell blocks (typescript, json) still toggle correctly
      // because the close fence is a bare ```.
      inFence = inFence ? false : FENCE.test(line);
      continue;
    }
    if (!inFence) continue;
    for (const m of line.matchAll(INSTALL)) {
      found.push({ spec: m[1], file, line: i + 1 });
    }
  }
  return found;
}

/** Workspace packages, by name → local version. */
function workspacePackages() {
  const map = new Map();
  for (const scope of ['packages', 'apps']) {
    const base = join(ROOT, scope);
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const pkg = JSON.parse(readFileSync(join(base, entry, 'package.json'), 'utf8'));
        if (pkg.name && pkg.version) map.set(pkg.name, pkg.version);
      } catch {
        /* not a package */
      }
    }
  }
  return map;
}

const majorOf = (v) => String(v).split('.')[0];
const isPrerelease = (v) => /-/.test(String(v));

/**
 * What `npm install <spec>` would give you today. Throws on any registry
 * failure that is not a clean "this spec matches nothing".
 */
function resolve(spec) {
  try {
    const out = execFileSync('npm', ['view', spec, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    const parsed = JSON.parse(out);
    // A range spec can match many versions; npm returns them oldest-first and
    // installs the newest.
    return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  } catch (err) {
    const stderr = String(err.stderr ?? '');
    if (/E404|code E404|is not in this registry|No matching version/i.test(stderr)) return null;
    throw new Error(`registry lookup failed for "${spec}": ${stderr || err.message}`);
  }
}

const specs = markdownFiles(ROOT).flatMap(installSpecs);
if (specs.length === 0) {
  console.error('check-install-docs: found no install commands to check — the scraper is broken.');
  process.exit(1);
}

const local = workspacePackages();
const failures = [];
const checked = new Map();

for (const { spec, file, line } of specs) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const where = `${relative(ROOT, file)}:${line}`;

  const localVersion = local.get(name);
  if (!localVersion) {
    failures.push(`${where}: "${spec}" names ${name}, which is not a package in this workspace.`);
    continue;
  }

  if (!checked.has(spec)) checked.set(spec, resolve(spec));
  const resolved = checked.get(spec);

  if (resolved === null) {
    failures.push(
      `${where}: "${spec}" resolves to NOTHING on the registry — this command fails for anyone who runs it.`
    );
    continue;
  }
  if (majorOf(resolved) !== majorOf(localVersion)) {
    failures.push(
      `${where}: "${spec}" resolves to ${resolved}, but this repo documents ${name}@${localVersion}. ` +
        `A reader following these docs would install a different major. ` +
        `Either publish ${majorOf(localVersion)}.x to the tag this command names, or point the command at a tag that carries it.`
    );
    continue;
  }
  // Prerelease line documented, stable install line published: the reverse of
  // the bug above and just as wrong — the docs would describe unreleased API.
  if (isPrerelease(localVersion) && !isPrerelease(resolved) && !spec.includes('@next')) {
    failures.push(
      `${where}: "${spec}" resolves to the stable ${resolved} while this repo is on the prerelease ${localVersion}. ` +
        `Point the command at @next until ${majorOf(localVersion)}.0.0 ships to latest.`
    );
  }
}

for (const [spec, resolved] of checked) {
  console.log(`  ${spec} → ${resolved ?? 'NOTHING'}`);
}

if (failures.length > 0) {
  console.error(`\ncheck-install-docs: ${failures.length} install command(s) do not match what this repo documents:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\ncheck-install-docs: ${checked.size} distinct install command(s) across ${specs.length} site(s) all resolve to the documented major.`);
