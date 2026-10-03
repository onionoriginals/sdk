/** Sync release-only workspace metadata that Bun 1.2.22 leaves unchanged. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function syncReleaseLockfile(root = process.cwd()) {
  const path = resolve(root, 'bun.lock');
  // Bun's generated text lock is JSON with trailing commas. Match strings first
  // so commas/closing braces inside dependency names or URLs are never changed.
  const raw = readFileSync(path, 'utf8');
  const lock = JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g,
    token => token.startsWith('"') ? token : ''));
  const manifests = Object.fromEntries(Object.keys(lock.workspaces).map(dir =>
    [dir, JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8'))]));
  const names = new Set(Object.values(manifests).map(pkg => pkg.name));
  for (const [dir, workspace] of Object.entries(lock.workspaces)) {
    const manifest = manifests[dir];
    if (workspace.name !== manifest.name) throw new Error(`Workspace name mismatch: ${dir}`);
    if (dir && manifest.version) workspace.version = manifest.version;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(workspace[field] ?? {})) {
        if (names.has(name) && manifest[field]?.[name]) {
          workspace[field][name] = manifest[field][name];
        }
      }
    }
  }
  // Replace only the workspace object. Preserve the resolved graph and Bun's
  // configVersion byte-for-byte: older Bun formatters drop configVersion,
  // which changes the linker layout when newer Bun installs the same lock.
  const match = /"workspaces"\s*:\s*\{/.exec(raw);
  if (!match) throw new Error('Missing lockfile workspaces');
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end;
  for (const token of raw.slice(start).matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
    if (token[0] === '{') depth++;
    if (token[0] === '}' && --depth === 0) {
      end = start + token.index + 1;
      break;
    }
  }
  if (end === undefined) throw new Error('Unterminated lockfile workspaces');
  const formatted = JSON.stringify(lock.workspaces, null, 2).replace(/\n/g, '\n  ');
  writeFileSync(path, raw.slice(0, start) + formatted + raw.slice(end));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syncReleaseLockfile();
}
