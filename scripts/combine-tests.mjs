#!/usr/bin/env node
/*
 Consolidate variant test files into a single canonical test per subject.

 Rules:
 - For files matching: <dir>/<base>[.<variant>].test.<ext>
 - Group by <dir> + <base> + <ext>
 - Choose canonical: <dir>/<base>.test.<ext> (create if absent)
 - For each non-canonical file, rename to: <dir>/<base>.<variant>.part.<ext>
 - Ensure canonical file imports each part: import './<base>.<variant>.part'

 This keeps one *.test.* per subject while preserving all test cases.
*/

import fs from 'fs';
import path from 'path';

/** @typedef {{ dir:string, base:string, variant:string|undefined, ext:string, fullPath:string }} TestFile */

const TEST_ROOT = path.resolve(process.cwd(), 'tests');

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkRec(dir) {
  /** @type {string[]} */
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function parseTestFile(filePath) {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  // Match: name parts like: Base[.variant].test.ext
  const m = file.match(/^(.+?)(?:\.(.+))?\.test\.(ts|tsx|js|jsx)$/);
  if (!m) return undefined;
  const [, base, variant, ext] = m;
  return /** @type {TestFile} */ ({ dir, base, variant, ext, fullPath: filePath });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function writeFileIfChanged(p, content) {
  const existing = readFileSafe(p);
  if (existing === content) return false;
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
  return true;
}

function appendUniqueImports(canonicalPath, importRelPaths) {
  let content = readFileSafe(canonicalPath);
  const existingImports = new Set();
  const importRegex = /^\s*import\s+['\"][^'\"]+['\"];\s*$/gm;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const line = m[0].trim();
    const from = line.slice("import '".length, -2);
    existingImports.add(from);
  }
  const toAdd = [];
  for (const rel of importRelPaths) {
    if (!existingImports.has(rel)) {
      toAdd.push(`import '${rel}';`);
    }
  }
  if (toAdd.length === 0) return false;
  const bannerNeeded = content.trim().length === 0;
  const banner = `/** Auto-generated aggregator: imports split test parts. Do not remove. */\n`;
  content = (bannerNeeded ? banner : content.trimEnd() + '\n') + toAdd.join('\n') + '\n';
  fs.writeFileSync(canonicalPath, content, 'utf8');
  return true;
}

function main() {
  if (!isDirSync(TEST_ROOT)) {
    console.error(`No tests directory found at: ${TEST_ROOT}`);
    process.exit(0);
  }
  const allFiles = walkRec(TEST_ROOT);
  /** @type {TestFile[]} */
  const testFiles = [];
  for (const f of allFiles) {
    const parsed = parseTestFile(f);
    if (parsed) testFiles.push(parsed);
  }
  // Group by dir+base+ext
  /** @type {Map<string, TestFile[]>} */
  const groups = new Map();
  for (const tf of testFiles) {
    const key = `${tf.dir}|${tf.base}|${tf.ext}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tf);
  }

  /** @type {string[]} */
  const actions = [];

  for (const [key, files] of groups.entries()) {
    // Determine canonical path
    const sample = files[0];
    const canonical = path.join(sample.dir, `${sample.base}.test.${sample.ext}`);
    const byName = new Map(files.map(f => [path.basename(f.fullPath), f]));
    const hasCanonical = byName.has(path.basename(canonical));

    /** @type {TestFile[]} */
    const variants = files.filter(f => f.fullPath !== canonical);
    if (variants.length === 0) continue; // nothing to consolidate

    // Ensure canonical file exists
    if (!hasCanonical) {
      writeFileIfChanged(canonical, '/** Canonical test aggregator created by combine-tests script. */\n');
      actions.push(`Created canonical ${path.relative(TEST_ROOT, canonical)}`);
    }

    // Move variants to .part files and collect import paths
    /** @type {string[]} */
    const importRels = [];
    for (const v of variants) {
      if (!v.variant) {
        // Rare but if a file matches but is not canonical and has no variant, skip
        continue;
      }
      const newName = `${v.base}.${v.variant}.part.${v.ext}`;
      const newFull = path.join(v.dir, newName);
      if (newFull === v.fullPath) {
        importRels.push(`./${path.basename(newFull, path.extname(newFull))}`);
        continue;
      }
      if (isFileSync(newFull)) {
        // Already moved previously
        importRels.push(`./${path.basename(newFull, path.extname(newFull))}`);
        continue;
      }
      fs.renameSync(v.fullPath, newFull);
      actions.push(`Renamed ${path.relative(TEST_ROOT, v.fullPath)} -> ${path.relative(TEST_ROOT, newFull)}`);
      importRels.push(`./${path.basename(newFull, path.extname(newFull))}`);
    }

    // Append imports to canonical
    appendUniqueImports(canonical, importRels.sort());
  }

  if (actions.length === 0) {
    console.log('No consolidations needed.');
  } else {
    console.log('Consolidation actions performed:');
    for (const a of actions) console.log(' - ' + a);
  }
}

main();

