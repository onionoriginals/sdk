import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectNpmCredential } from './npm-release-check.mjs';

const token = 'npm_abcdEXAMPLE_ONLY_NOT_A_REAL_TOKEN1234';
const replies = (rows) => async (url, options) => {
  assert.ok(url.startsWith('https://registry.npmjs.org/'));
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, `Bearer ${token}`);
  return rows.shift();
};
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
test('unavailable/expired credentials stop before account or token enumeration without leaking errors', async () => {
  let calls = 0;
  const result = await inspectNpmCredential(token, async () => {
    calls++;
    return new Response(token, { status: 401 });
  });
  assert.deepEqual(result, { authenticated: false, status: 401 });
  assert.equal(calls, 1);
  assert.deepEqual(
    await inspectNpmCredential(token, async () => {
      throw new Error(token);
    }),
    { authenticated: false, status: 0 },
  );
});
test('account rights are distinct from inaccessible token scope and expiry', async () => {
  const result = await inspectNpmCredential(
    token,
    replies([
      json({ username: 'owner' }),
      json({
        '@originals/sdk': 'read-write',
        '@another/private': 'read-write',
      }),
      new Response('', { status: 403 }),
    ]),
  );
  assert.equal(result.authenticated, true);
  assert.equal(result.accountPackageAccess['@originals/sdk'], 'read-write');
  assert.equal(result.expiry, null);
  assert.equal(result.tokenMetadataMatched, false);
  assert.ok(!JSON.stringify(result).includes('@another'));
});
test('only uniquely matched token metadata is returned, with no token fields or arbitrary metadata', async () => {
  const row = {
    token: token.slice(0, 8) + '...' + token.slice(-4),
    key: 'private-identifier',
    description: token,
    expiry: '2099-01-01T00:00:00Z',
    readonly: false,
    bypass_2fa: true,
    permissions: [{ name: 'package', action: 'write' }],
    scopes: [{ name: '@originals', type: 'scope' }],
  };
  const result = await inspectNpmCredential(
    token,
    replies([
      json({ username: 'owner' }),
      json({}),
      json({ objects: [row], total: 1 }),
    ]),
  );
  assert.equal(result.expiry, new Date(row.expiry).toISOString());
  assert.equal(result.readOnly, false);
  assert.equal(result.bypass2FA, true);
  const output = JSON.stringify(result);
  for (const sensitive of [token, row.token, row.key])
    assert.ok(!output.includes(sensitive));
  const ambiguous = await inspectNpmCredential(
    token,
    replies([
      json({ username: 'owner' }),
      json({}),
      json({ objects: [row, row], total: 2 }),
    ]),
  );
  assert.equal(ambiguous.tokenMetadataMatched, false);
  assert.equal(ambiguous.expiry, null);
  const incomplete = await inspectNpmCredential(
    token,
    replies([
      json({ username: 'owner' }),
      json({}),
      json({
        objects: [row],
        total: 101,
        urls: { next: 'https://registry.npmjs.org/-/npm/v1/tokens?page=1' },
      }),
    ]),
  );
  assert.equal(incomplete.tokenMetadataMatched, false);
  assert.equal(incomplete.expiry, null);
});
