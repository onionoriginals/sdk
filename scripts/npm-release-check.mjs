/** Read-only npm observations. Never prints a credential, token identifier or raw response. */
import { pathToFileURL } from 'node:url';

const packages = ['@originals/sdk', '@originals/cel', '@originals/auth'];
export async function inspectNpmCredential(token, request = fetch) {
  if (!token) return { authenticated: false, reason: 'missing_credential' };
  const get = async (path) => {
    try {
      const response = await request(`https://registry.npmjs.org${path}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
      return {
        status: response.status,
        body: response.ok ? await response.json() : null,
      };
    } catch {
      return { status: 0, body: null };
    }
  };
  const identity = await get('/-/whoami');
  if (
    identity.status !== 200 ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(identity.body?.username ?? '')
  ) {
    return { authenticated: false, status: identity.status };
  }
  const access = await get(
    `/-/user/${encodeURIComponent(identity.body.username)}/package`,
  );
  const listed = await get('/-/npm/v1/tokens?perPage=100&page=0');
  const mask = token.slice(0, 8) + '...' + token.slice(-4);
  const complete =
    Array.isArray(listed.body?.objects) &&
    Number.isSafeInteger(listed.body.total) &&
    listed.body.total === listed.body.objects.length &&
    !listed.body.urls?.next;
  const matches = complete
    ? listed.body.objects.filter((row) => row.token === mask)
    : [];
  const row = matches.length === 1 ? matches[0] : null;
  const expiry =
    row &&
    typeof row.expiry === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(row.expiry) &&
    Number.isFinite(Date.parse(row.expiry))
      ? new Date(row.expiry).toISOString()
      : null;
  return {
    authenticated: true,
    // Account-level rights do not establish the granular token's own scope.
    accountPackageAccess: Object.fromEntries(
      packages.map((name) => [
        name,
        ['read-write', 'read-only'].includes(access.body?.[name])
          ? access.body[name]
          : 'unavailable',
      ]),
    ),
    accessStatus: access.status,
    tokenMetadataStatus: listed.status,
    tokenMetadataComplete: complete,
    tokenMetadataMatched: !!row,
    expiry,
    expired: expiry ? Date.parse(expiry) <= Date.now() : null,
    readOnly: typeof row?.readonly === 'boolean' ? row.readonly : null,
    bypass2FA: typeof row?.bypass_2fa === 'boolean' ? row.bypass_2fa : null,
    scopePermissions: Array.isArray(row?.permissions)
      ? row.permissions
          .filter(
            (p) =>
              /^[a-zA-Z_-]{1,40}$/.test(p.name) &&
              /^[a-zA-Z_-]{1,40}$/.test(p.action),
          )
          .map((p) => ({ name: p.name, action: p.action }))
      : [],
    originalsScopes: Array.isArray(row?.scopes)
      ? row.scopes
          .filter(
            (s) =>
              ['@originals', 'originals', ...packages].includes(s.name) &&
              /^[a-zA-Z_-]{1,40}$/.test(s.type),
          )
          .map((s) => ({ name: s.name, type: s.type }))
      : [],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await inspectNpmCredential(process.env.NODE_AUTH_TOKEN);
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.authenticated ||
    result.expired === true ||
    result.readOnly === true
  )
    process.exitCode = 1;
  if (!result.tokenMetadataMatched)
    console.log(
      'Token expiry and granular scope require account verification; these observations do not prove publish permission.',
    );
}
