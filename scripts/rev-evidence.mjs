import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Run only in the unprivileged evidence job, never in the evaluator job.
export function collect(root, headSha, baseSha) {
  for (const sha of [headSha, baseSha]) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Expected full head and base SHAs');
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (git('rev-parse', 'HEAD').trim() !== headSha) throw new Error('Checkout does not match PR head');
  if (!git('diff', baseSha, headSha, '--', '.rev/task.json').trim()) {
    throw new Error('Update .rev/task.json with acceptance criteria for this PR');
  }
  const sources = JSON.parse(readFileSync(resolve(root, '.rev/sources.json'), 'utf8'));
  const task = JSON.parse(readFileSync(resolve(root, '.rev/task.json'), 'utf8'));
  if (!Array.isArray(sources) || sources.length > 39) throw new Error('Expected at most 39 sources');
  const ids = new Set(['pr-diff']);
  const items = sources.map(({ id, kind, path }) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || id === 'none' || ids.has(id)) throw new Error('Invalid or duplicate source ID');
    ids.add(id);
    if (!['code', 'diff', 'test', 'behavior', 'report'].includes(kind)) throw new Error('Invalid source kind');
    const file = realpathSync(resolve(root, path));
    if (!file.startsWith(realpathSync(root) + sep)) throw new Error('Source escapes repository');
    return { id, kind, source: path, content: readFileSync(file, 'utf8') };
  });
  items.unshift({ id: 'pr-diff', kind: 'diff', source: `${baseSha}..${headSha}`, content: git('diff', '--no-ext-diff', baseSha, headSha, '--', '.', ':!.rev', ':!bun.lock') });
  if (!items.some(item => ['test', 'behavior'].includes(item.kind))) throw new Error('Behavioral evidence is required');
  if (!Array.isArray(task.criteria) || task.criteria.length * (items.length + 1) > 100) throw new Error('Too many assessments');
  const evidence = JSON.stringify({ version: 1, headSha, items }, null, 2);
  if (Buffer.byteLength(evidence) + Buffer.byteLength(JSON.stringify(task)) > 1024 * 1024) throw new Error('Evidence exceeds REV limit');
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeFileSync('.rev/evidence.json', collect(process.cwd(), process.env.REV_HEAD_SHA, process.env.REV_BASE_SHA));
}
