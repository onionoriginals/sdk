#!/usr/bin/env node
/**
 * Render the publish plan for a pending "Version Packages" PR as markdown.
 *
 * The Version PR is the single approval surface for a release: merging it
 * publishes. So it has to state plainly what merging will DO — every package,
 * its old and new version, and the dist-tag it lands on. That last column is
 * the one that surprises: in prerelease mode `changeset publish` sends a
 * package whose ONLY published versions are already `-<pre.tag>.N` prereleases
 * to `latest` instead of the pre tag (see the dist-tag rule below).
 *
 * Usage: node scripts/publish-plan.mjs <git-ref>   (e.g. origin/changeset-release/main)
 * Exits non-zero on a registry error — a plan that guessed would be worse than none.
 */
import { execFileSync } from 'node:child_process';

const ref = process.argv[2];
if (!ref) {
  console.error('usage: publish-plan.mjs <git-ref>');
  process.exit(2);
}

// A stack trace here would land verbatim in the PR comment's failure notice.
process.on('uncaughtException', (err) => {
  console.error(err.message);
  process.exit(1);
});

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** Read a file out of the ref, or null when it isn't there. */
function show(path) {
  try {
    // stderr silenced: a missing path is an expected answer here, not a failure.
    return execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

/**
 * Published versions from the registry; [] only for a genuine 404.
 * Anything else (timeout, auth, rate limit) throws: mistaking a blip for "never
 * published" would print a wrong `from` and a wrong dist-tag on the one surface
 * a maintainer approves the release from. Mirrors changesets' own infoAllow404.
 */
function publishedVersions(name) {
  let out;
  try {
    out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    // npm --json puts `{"error":{"code":"E404",...}}` on stdout even when it exits 1.
    const body = String(err.stdout ?? '');
    let reported;
    try {
      reported = JSON.parse(body)?.error;
    } catch {
      /* not JSON — fall through to the throw below */
    }
    if (reported?.code === 'E404') return [];
    const detail =
      reported?.summary?.trim() ||
      String(err.stderr ?? '')
        .trim()
        .split('\n')
        .slice(0, 3)
        .join(' ') ||
      `exit ${err.status}`;
    throw new Error(`npm view ${name} versions failed (${reported?.code ?? 'unknown error'}): ${detail}`);
  }
  if (!out.trim()) return []; // registries without an auto-`latest` answer empty for a new package
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** First prerelease identifier: `next` for `1.2.3-next.0`, null for a normal version. */
const prereleaseId = (v) => /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(v)?.[1] ?? null;

// Package manifests live one level under packages/ and apps/.
const manifests = git('ls-tree', '-r', '--name-only', ref, '--', 'packages', 'apps')
  .split('\n')
  .filter((p) => /^(packages|apps)\/[^/]+\/package\.json$/.test(p));

const preRaw = show('.changeset/pre.json');
const pre = preRaw ? JSON.parse(preRaw) : null;

const rows = [];
for (const path of manifests) {
  const raw = show(path);
  if (!raw) continue;
  const pkg = JSON.parse(raw);
  if (pkg.private || !pkg.name || !pkg.version) continue;

  const published = publishedVersions(pkg.name);
  if (published.includes(pkg.version)) continue; // already on the registry — publish skips it

  // changesets' actual rule (getReleaseTag: `publishedState !== "only-pre"`):
  // pre mode uses its tag, EXCEPT a package already published and whose every
  // published version carries that same pre identifier — that one goes to
  // `latest`. A never-published package is NOT the exception; it gets pre.tag.
  const onlyPre = published.length > 0 && published.every((v) => prereleaseId(v) === pre?.tag);
  const tag = pre && !onlyPre ? pre.tag : 'latest';

  rows.push({
    name: pkg.name,
    from: published.length ? published[published.length - 1] : '—',
    to: pkg.version,
    tag,
    brandNew: published.length === 0
  });
}

const out = ['<!-- publish-plan -->', '## What merging this PR publishes', ''];

if (rows.length === 0) {
  out.push('Nothing — every version in this PR is already on the registry.');
} else {
  out.push('| package | from | to | dist-tag |');
  out.push('|---|---|---|---|');
  for (const r of rows) {
    out.push(`| \`${r.name}\` | ${r.from} | **${r.to}** | \`${r.tag}\` |`);
  }
  out.push('');
  if (pre) {
    out.push(`Prerelease mode is **on** (tag \`${pre.tag}\`).`);
    const promoted = rows.filter((r) => r.tag === 'latest');
    if (promoted.length) {
      const names = promoted.map((r) => `\`${r.name}\``).join(', ');
      out.push(
        `> ⚠️ ${names} ${promoted.length === 1 ? 'has' : 'have'} only ever been published as ` +
          `\`${pre.tag}\` prereleases, so \`changeset publish\` moves \`latest\` onto ` +
          `${promoted.length === 1 ? 'this prerelease' : 'these prereleases'} rather than using \`${pre.tag}\` — ` +
          'that is its rule for a package with no normal release yet, not a misconfiguration. ' +
          '`npm install` with no tag will get the prerelease.'
      );
    }
    const fresh = rows.filter((r) => r.brandNew);
    if (fresh.length) {
      const names = fresh.map((r) => `\`${r.name}\``).join(', ');
      out.push(
        `> ℹ️ ${names} ${fresh.length === 1 ? 'has' : 'have'} never been published; a first publish ` +
          `goes to \`${pre.tag}\`, and npm additionally auto-assigns \`latest\` to it.`
      );
    }
  } else {
    out.push('Prerelease mode is **off** — these are normal `latest` releases.');
  }
  out.push('');
  out.push(
    'Merging publishes immediately: no second approval, no Actions tab. ' +
      'npm publishes are effectively permanent (unpublish is limited to 72h and breaks installs), so check the versions above before merging.'
  );
}

console.log(out.join('\n'));
