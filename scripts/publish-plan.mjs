#!/usr/bin/env node
/**
 * Render the publish plan for a pending "Version Packages" PR as markdown.
 *
 * The Version PR is the single approval surface for a release: merging it
 * publishes. So it has to state plainly what merging will DO — every package,
 * its old and new version, and the dist-tag it lands on. That last column is
 * the one that surprises: `changeset publish` sends a package with no prior
 * NORMAL release to `latest` even in prerelease mode, so a brand-new package
 * skips `next` entirely.
 *
 * Usage: node scripts/publish-plan.mjs <git-ref>   (e.g. origin/changeset-release/main)
 */
import { execFileSync } from 'node:child_process';

const ref = process.argv[2];
if (!ref) {
  console.error('usage: publish-plan.mjs <git-ref>');
  process.exit(2);
}

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

/** Published versions from the registry; [] when the package is brand new. */
function publishedVersions(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return []; // 404 (never published) or a registry blip — treated the same downstream
  }
}

const isPrerelease = (v) => /-/.test(v);

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

  // changesets' own rule: pre mode uses its tag, EXCEPT for a package with no
  // prior normal release, which goes to `latest` regardless.
  const hadNormalRelease = published.some((v) => !isPrerelease(v));
  const tag = pre && hadNormalRelease ? pre.tag : 'latest';

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
        `> ⚠️ ${names} ${promoted.length === 1 ? 'has' : 'have'} no prior normal release, ` +
          `so ${promoted.length === 1 ? 'it lands' : 'they land'} on \`latest\` rather than \`${pre.tag}\` — ` +
          'that is `changeset publish`\'s behaviour for a first publish, not a misconfiguration.'
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
