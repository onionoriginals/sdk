import { execFileSync } from 'node:child_process';

type Git = (args: string[]) => string;

const runGit: Git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The commit this SPA was built from, for /api/version and the hosted
 * acceptance receipt (#976 B, G6). Railway sets RAILWAY_GIT_COMMIT_SHA at build
 * time, for a clean checkout of that commit. Elsewhere git answers, and a tree
 * with uncommitted changes, or one whose status can't be read, is marked
 * `-dirty`, so it never equals a clean source SHA. Unknown is null, never a
 * guess.
 */
export function buildRevision(env: Record<string, string | undefined> = process.env, git: Git = runGit): string | null {
  const fromEnv = env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv && /^[0-9a-f]{7,64}$/.test(fromEnv)) return fromEnv;
  let sha: string;
  try {
    sha = git(['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  let dirty: boolean;
  try {
    dirty = git(['status', '--porcelain']).trim() !== '';
  } catch {
    dirty = true;
  }
  return dirty ? `${sha}-dirty` : sha;
}
