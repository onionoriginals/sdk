import { execFileSync } from 'node:child_process';

export function actionUpdateInputs(root, base, head, branch, requiredChecks) {
  const match = /^dependabot\/github_actions\/(actions\/(?:checkout|setup-node))-(\d+)$/.exec(branch);
  if (!match) throw new Error('Unsupported action update; supply a reviewed PR-specific contract');
  if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('invalid-revision');
  const git = (...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (git('rev-parse', 'HEAD').trim() !== head) throw new Error('head-not-checked-out');
  const mergeBase = git('merge-base', base, head).trim();
  const files = git('diff', '--no-renames', '--name-only', '-z', mergeBase, head, '--').split('\0').filter(Boolean);
  if (!files.length || files.some(path => !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) {
    throw new Error('Action update changes files outside workflows');
  }
  const [, action, major] = match;
  const target = `${action}@v${major}`;
  let replacements = 0;
  for (const path of files) {
    for (const revision of [mergeBase, head]) {
      if (!git('ls-tree', revision, '--', path).startsWith('100644 blob ')) throw new Error('Action update changes workflow file type');
    }
    const before = git('show', `${mergeBase}:${path}`);
    const after = git('show', `${head}:${path}`);
    const pattern = /^(\s*(?:-\s+)?uses:\s+)(actions\/(?:checkout|setup-node))@v(\d+)([ \t]*(?:#[^\r\n]*)?\r?)$/gm;
    // Some workflows already use newer refs in other jobs: permit updating any
    // subset, while comparing every other byte and preserving line order.
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    if (oldLines.length !== newLines.length) throw new Error('Action update changes workflow structure');
    let changed = 0;
    for (let i = 0; i < oldLines.length; i++) {
      if (oldLines[i] === newLines[i]) continue;
      pattern.lastIndex = 0;
      const line = pattern.exec(oldLines[i]);
      if (!line || line[2] !== action || Number(line[3]) >= Number(major)
        || newLines[i] !== `${line[1]}${target}${line[4]}`) {
        throw new Error('Action update contains unrelated edits or a downgrade');
      }
      changed++;
    }
    if (!changed) throw new Error('Action update has no version substitutions');
    replacements += changed;
  }
  const task = { version: 1, task: `Update ${action} to v${major} in SDK CI.`, criteria: [{
    id: 'action-update',
    description: `Change only existing ${action} uses references to v${major}. Preserve all other workflow content, permissions, job dependencies, commands, inputs and application files. The revision-bound probe must verify every changed byte is an upgrade of that reference, and all required SDK CI checks must pass with the new action. Review the full diffs for compatibility; a version-only change does not itself establish compatibility.`,
  }] };
  const contract = {
    request: { source: `Dependabot branch ${branch}`, text: `Update ${action} to v${major}, preserving SDK behavior and CI requirements. Include no unrelated changes and validate compatibility with existing CI.` },
    requiredChecks, mappings: Object.fromEntries(files.map(path => [path, ['action-update']])),
  };
  return { task, contract, observation: {
    id: 'action-update-probe', kind: 'behavior', source: 'immutable merge-base and head Git objects',
    content: JSON.stringify({ base, head, mergeBase, files, target, replacements, onlyReferenceUpgrades: true }),
  } };
}
