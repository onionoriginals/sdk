import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const run = (cwd, command, args) => execFileSync(command, args, {
  cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

// Run only in the unprivileged evidence job. Reproduce from the PR's merge base,
// never from its modified scripts. This checks all tracked changes, not an allowlist.
export async function reproduceRelease(root, base, head, generate = dir => {
  run(dir, 'bun', ['install', '--frozen-lockfile']);
  run(dir, 'bun', ['run', 'version']);
}) {
  if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('invalid-revision');
  const git = (...args) => run(root, 'git', args);
  if (git('rev-parse', 'HEAD').trim() !== head) throw new Error('head-not-checked-out');
  const mergeBase = git('merge-base', base, head).trim();
  const temp = await mkdtemp(resolve(tmpdir(), 'rev-release-'));
  const worktree = resolve(temp, 'source');
  try {
    git('worktree', 'add', '--detach', worktree, mergeBase);
    await generate(worktree);
    run(worktree, 'git', ['add', '-A']);
    const flags = ['--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index'];
    const expected = run(worktree, 'git', ['diff', '--cached', ...flags, 'HEAD', '--']);
    const actual = git('diff', ...flags, mergeBase, head, '--');
    if (!expected.trim()) throw new Error('Release generation produced no changes');
    if (actual !== expected) throw new Error('Release PR differs from regenerated version output');
    const files = git('diff', '--no-renames', '--name-only', '-z', mergeBase, head, '--').split('\0').filter(Boolean);
    return { base, head, mergeBase, files, command: 'bun install --frozen-lockfile && bun run version', exactMatch: true };
  } finally {
    try { git('worktree', 'remove', '--force', worktree); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}

export async function releaseInputs(root, base, head) {
  const task = JSON.parse(await readFile(resolve(root, '.rev/release-task.json'), 'utf8'));
  const contract = JSON.parse(await readFile(resolve(root, '.rev/release-contract.json'), 'utf8'));
  const result = await reproduceRelease(root, base, head);
  // Exact reproduction gives each path relevant behavioral evidence. The full
  // diff still goes through the pinned collector and model coverage evaluation.
  contract.mappings = Object.fromEntries(result.files.map(path => [path, ['release-output']]));
  return { task, contract, observation: {
    id: 'release-reproduction', kind: 'behavior', source: 'isolated merge-base worktree',
    content: JSON.stringify(result),
  } };
}
