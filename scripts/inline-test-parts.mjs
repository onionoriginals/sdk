#!/usr/bin/env node
/*
 Inline consolidated test part files into their canonical test files.

 Steps per canonical test file:
 - Detect lines: import './<name>.part';
 - Resolve each corresponding part file: '<name>.part.(ts|tsx|js|jsx)'
 - Remove the import lines from the canonical file
 - Append the content of each part file to the end of the canonical file
 - Optionally add a small banner between parts for readability
 - Dedupe identical import lines across the combined file
 - Delete the part files
*/

import fs from 'fs';
import path from 'path';

const TEST_ROOT = path.resolve(process.cwd(), 'tests');

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
  }
  return files;
}

function isCanonicalTest(file) {
  return /\.test\.(ts|tsx|js|jsx)$/.test(file);
}

const PART_IMPORT_RE = /(^|\n)\s*import\s+['\"](\.\/.+?\.part)['\"];\s*(?=\n|$)/g;

function readFileUtf8(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function writeFileUtf8(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function resolvePartFile(fromDir, relNoExt) {
  const candidates = ['.ts', '.tsx', '.js', '.jsx'].map(ext => path.join(fromDir, relNoExt + ext));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return undefined;
}

function dedupeImportLines(content) {
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const importLineRegex = /^\s*import\s+.*?;\s*$/;
  const out = [];
  for (const line of lines) {
    if (importLineRegex.test(line)) {
      if (seen.has(line)) continue;
      seen.add(line);
    }
    out.push(line);
  }
  return out.join('\n');
}

function main() {
  if (!isDirSync(TEST_ROOT)) {
    console.error(`No tests directory found at: ${TEST_ROOT}`);
    process.exit(0);
  }
  const files = walkFiles(TEST_ROOT).filter(isCanonicalTest);
  /** @type {string[]} */
  const changes = [];
  /** @type {string[]} */
  const deleted = [];

  for (const canonical of files) {
    let content = readFileUtf8(canonical);
    /** @type {string[]} */
    const partRelNoExts = [];
    content.replace(PART_IMPORT_RE, (_m, _p1, rel) => {
      // rel like './Verifier.more.part'
      partRelNoExts.push(rel);
      return _m; // we will perform removal after collecting
    });
    if (partRelNoExts.length === 0) continue;

    // Remove all part import statements
    const contentWithoutPartImports = content.replace(PART_IMPORT_RE, (m) => {
      // keep newline boundary
      return m.startsWith('\n') ? '\n' : '';
    }).replace(/\n{3,}/g, '\n\n');

    const partsContents = [];
    for (const rel of partRelNoExts) {
      const noExt = rel; // already without extension
      const full = resolvePartFile(path.dirname(canonical), noExt);
      if (!full) {
        changes.push(`Missing part for ${path.relative(TEST_ROOT, canonical)}: ${rel}`);
        continue;
      }
      const part = readFileUtf8(full);
      // Add banner for visibility
      const banner = `\n\n/** Inlined from ${path.basename(full)} */\n`;
      partsContents.push(banner + part.trimStart() + '\n');
    }

    let merged = contentWithoutPartImports.trimEnd() + partsContents.join('');
    merged = dedupeImportLines(merged).trimEnd() + '\n';
    if (merged !== content) {
      writeFileUtf8(canonical, merged);
      changes.push(`Inlined ${partRelNoExts.length} part(s) into ${path.relative(TEST_ROOT, canonical)}`);
    }

    // Delete part files
    for (const rel of partRelNoExts) {
      const full = resolvePartFile(path.dirname(canonical), rel);
      if (!full) continue;
      try { fs.unlinkSync(full); deleted.push(path.relative(TEST_ROOT, full)); } catch {}
    }
  }

  if (changes.length === 0) {
    console.log('No .part imports found; nothing to inline.');
  } else {
    console.log('Inlined test parts:');
    for (const c of changes) console.log(' - ' + c);
    if (deleted.length) {
      console.log('Deleted part files:');
      for (const d of deleted) console.log(' - ' + d);
    }
  }
}

main();

