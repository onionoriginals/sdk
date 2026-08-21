/**
 * The boot-time configuration contract (U6 / R10, R23). Every rule here is a
 * pure function over an env snapshot + a data-dir probe, so a container is
 * never needed to assert "writable but not a mounted volume fails".
 */
import { describe, test, expect } from 'bun:test';
import {
  validateConfig,
  isMountedVolume,
  isStrictConfig,
  enforceConfig,
  resolveDataDir,
  authIntended,
  type ConfigIssue,
  type DataDirProbe,
} from '../config';

const DEPLOYED = { RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'production' };
/** A fully-valid deployed env; each test removes exactly one value from it. */
const GOOD = {
  ...DEPLOYED,
  JWT_SECRET: 'x'.repeat(32),
  TURNKEY_API_PUBLIC_KEY: 'pub',
  TURNKEY_API_PRIVATE_KEY: 'priv',
  TURNKEY_ORGANIZATION_ID: 'org',
  BTC_NETWORK: 'testnet4',
  ORIGINALS_DATA_DIR: '/data',
  TRUSTED_PROXY_HOPS: '1',
  RAILWAY_VOLUME_MOUNT_PATH: '/data',
};
const mounted: DataDirProbe = { path: '/data', writable: true, mountPoints: ['/data'] };

const errors = (issues: ConfigIssue[]) => issues.filter((i) => i.severity === 'error');
const keys = (issues: ConfigIssue[]) => issues.map((i) => i.key);
const without = (env: Record<string, string | undefined>, key: string) => {
  const next = { ...env };
  delete next[key];
  return next;
};

describe('validateConfig — deployed environment', () => {
  test('a fully-configured deploy reports nothing', () => {
    expect(validateConfig({ env: GOOD, dataDir: mounted })).toEqual([]);
  });

  test('a missing JWT_SECRET is reported naming JWT_SECRET', () => {
    const issues = errors(validateConfig({ env: without(GOOD, 'JWT_SECRET'), dataDir: mounted }));
    expect(keys(issues)).toContain('JWT_SECRET');
    expect(issues[0].message).toContain('JWT_SECRET');
  });

  test('a JWT_SECRET shorter than 32 chars is caught at boot, not at every login', () => {
    const issues = errors(
      validateConfig({ env: { ...GOOD, JWT_SECRET: 'tooshort' }, dataDir: mounted })
    );
    expect(keys(issues)).toEqual(['JWT_SECRET']);
    expect(issues[0].message).toMatch(/32/);
  });

  test('each TURNKEY_* value is required once the auth surface is meant to be mounted', () => {
    for (const key of [
      'TURNKEY_API_PUBLIC_KEY',
      'TURNKEY_API_PRIVATE_KEY',
      'TURNKEY_ORGANIZATION_ID',
    ]) {
      expect(keys(errors(validateConfig({ env: without(GOOD, key), dataDir: mounted })))).toEqual([
        key,
      ]);
    }
  });

  test('no auth values at all means no auth surface — and no auth violations', () => {
    let env = { ...GOOD };
    for (const key of [
      'JWT_SECRET',
      'TURNKEY_API_PUBLIC_KEY',
      'TURNKEY_API_PRIVATE_KEY',
      'TURNKEY_ORGANIZATION_ID',
      'ORIGINALS_DATA_DIR',
    ]) {
      env = without(env, key);
    }
    expect(authIntended(env)).toBe(false);
    expect(errors(validateConfig({ env, dataDir: null }))).toEqual([]);
  });

  test('BTC_NETWORK must be set explicitly and be a network name', () => {
    expect(keys(errors(validateConfig({ env: without(GOOD, 'BTC_NETWORK'), dataDir: mounted })))).toEqual([
      'BTC_NETWORK',
    ]);
    expect(
      keys(errors(validateConfig({ env: { ...GOOD, BTC_NETWORK: 'testnet' }, dataDir: mounted })))
    ).toEqual(['BTC_NETWORK']);
  });

  test('a missing QUICKNODE_ENDPOINT with BTC_NETWORK=mainnet is reported', () => {
    const env = { ...GOOD, BTC_NETWORK: 'mainnet', VITE_BTC_NETWORK: 'mainnet' };
    expect(keys(errors(validateConfig({ env, dataDir: mounted })))).toContain('QUICKNODE_ENDPOINT');
    // …and is satisfied by setting it. (Errors only: a mainnet deploy on the
    // free deposit indexer still carries U4's standing BTC_INDEXER_API warn.)
    expect(
      errors(validateConfig({ env: { ...env, QUICKNODE_ENDPOINT: 'https://x.quiknode.pro/k/' }, dataDir: mounted }))
    ).toEqual([]);
  });

  test('QUICKNODE_ENDPOINT stays optional on testnet4 (inscribe degrades to mock by design)', () => {
    expect(validateConfig({ env: GOOD, dataDir: mounted })).toEqual([]);
  });

  test('a malformed QUICKNODE_ENDPOINT is reported even when it is present', () => {
    const issues = errors(
      validateConfig({ env: { ...GOOD, QUICKNODE_ENDPOINT: 'not a url' }, dataDir: mounted })
    );
    expect(keys(issues)).toContain('QUICKNODE_ENDPOINT');
  });

  test('a missing ORIGINALS_DATA_DIR is reported', () => {
    const issues = errors(
      validateConfig({ env: without(GOOD, 'ORIGINALS_DATA_DIR'), dataDir: null })
    );
    expect(keys(issues)).toContain('ORIGINALS_DATA_DIR');
  });

  test('an unwritable data directory is reported', () => {
    const issues = errors(
      validateConfig({ env: GOOD, dataDir: { ...mounted, writable: false } })
    );
    expect(keys(issues)).toEqual(['ORIGINALS_DATA_DIR']);
    expect(issues[0].message).toMatch(/writ/i);
  });

  test('a path that is writable but not a mounted volume fails', () => {
    const issues = errors(
      validateConfig({
        env: { ...GOOD, ORIGINALS_DATA_DIR: '/app/.originals-data', RAILWAY_VOLUME_MOUNT_PATH: '/data' },
        dataDir: { path: '/app/.originals-data', writable: true, mountPoints: ['/data'] },
      })
    );
    expect(keys(issues)).toEqual(['ORIGINALS_DATA_DIR']);
    expect(issues[0].message).toMatch(/volume|mount/i);
  });

  test('an absent trusted-proxy hop count is reported naming it', () => {
    const issues = errors(
      validateConfig({ env: without(GOOD, 'TRUSTED_PROXY_HOPS'), dataDir: mounted })
    );
    expect(keys(issues)).toEqual(['TRUSTED_PROXY_HOPS']);
    expect(issues[0].message).toContain('TRUSTED_PROXY_HOPS');
  });

  test('a non-integer trusted-proxy hop count is reported', () => {
    expect(
      keys(errors(validateConfig({ env: { ...GOOD, TRUSTED_PROXY_HOPS: 'yes' }, dataDir: mounted })))
    ).toEqual(['TRUSTED_PROXY_HOPS']);
    expect(
      keys(errors(validateConfig({ env: { ...GOOD, TRUSTED_PROXY_HOPS: '-1' }, dataDir: mounted })))
    ).toEqual(['TRUSTED_PROXY_HOPS']);
    expect(validateConfig({ env: { ...GOOD, TRUSTED_PROXY_HOPS: '0' }, dataDir: mounted })).toEqual([]);
  });

  /**
   * R1 — `Number('fifty')` is NaN, and NaN is not nullish, so a `?? default`
   * at the call site never fires. The sweep cap then silently disables the
   * only instrument that ever sees stranded funds. The call sites now guard
   * the parse; boot says so by name rather than leaving a value that reads
   * fine in the dashboard and does nothing.
   */
  test('a set-but-malformed numeric value is reported by name', () => {
    for (const key of ['DEPOSIT_SWEEP_MAX_PER_PASS', 'BTC_FAUCET_SATS', 'PORT']) {
      expect(
        keys(errors(validateConfig({ env: { ...GOOD, [key]: 'fifty' }, dataDir: mounted })))
      ).toEqual([key]);
      // Zero and negatives are equally unusable as a count/port/amount.
      expect(
        keys(errors(validateConfig({ env: { ...GOOD, [key]: '0' }, dataDir: mounted })))
      ).toEqual([key]);
      expect(
        keys(errors(validateConfig({ env: { ...GOOD, [key]: '-3' }, dataDir: mounted })))
      ).toEqual([key]);
      // A good value, and an ABSENT one (the default fires), are both clean.
      expect(validateConfig({ env: { ...GOOD, [key]: '50' }, dataDir: mounted })).toEqual([]);
    }
    expect(validateConfig({ env: GOOD, dataDir: mounted })).toEqual([]);
  });

  test('NODE_ENV must be production on a deployed instance', () => {
    const issues = errors(
      validateConfig({ env: { ...without(GOOD, 'NODE_ENV') }, dataDir: mounted })
    );
    expect(keys(issues)).toEqual(['NODE_ENV']);
  });
});

describe('validateConfig — local environment', () => {
  test('nothing configured locally produces no issues at all', () => {
    expect(validateConfig({ env: {}, dataDir: null })).toEqual([]);
    expect(validateConfig({ env: { NODE_ENV: 'development' }, dataDir: null })).toEqual([]);
  });

  test('locally a missing ORIGINALS_DATA_DIR warns rather than erroring', () => {
    const env = {
      JWT_SECRET: 'x'.repeat(32),
      TURNKEY_API_PUBLIC_KEY: 'pub',
      TURNKEY_API_PRIVATE_KEY: 'priv',
      TURNKEY_ORGANIZATION_ID: 'org',
    };
    const issues = validateConfig({ env, dataDir: null });
    expect(errors(issues)).toEqual([]);
    expect(keys(issues)).toContain('ORIGINALS_DATA_DIR');
  });

  test('locally a broken value still warns — severity is the only thing that changes', () => {
    const issues = validateConfig({ env: { JWT_SECRET: 'short' }, dataDir: null });
    expect(errors(issues)).toEqual([]);
    expect(keys(issues)).toContain('JWT_SECRET');
  });

  test('a local data dir is never required to be a mounted volume', () => {
    const issues = validateConfig({
      env: { JWT_SECRET: 'x'.repeat(32), ORIGINALS_DATA_DIR: './.originals-data' },
      dataDir: { path: './.originals-data', writable: true, mountPoints: [] },
    });
    expect(keys(issues)).not.toContain('ORIGINALS_DATA_DIR');
  });
});

/**
 * R11 — the build-time browser flag and the runtime server network are set in
 * different places at different times, and the browser's own check only ever
 * sees its half. Boot sees both.
 */
describe('validateConfig — network skew, both directions', () => {
  const REAL = {
    ...GOOD,
    BTC_NETWORK: 'mainnet',
    QUICKNODE_ENDPOINT: 'https://x.quiknode.pro/k/',
  };

  test('the matching pair is not flagged', () => {
    // Errors only — U4's BTC_INDEXER_API warn stands on any mainnet deploy
    // reading deposits from the free public API.
    expect(errors(validateConfig({ env: { ...REAL, VITE_BTC_NETWORK: 'mainnet' }, dataDir: mounted }))).toEqual([]);
  });

  test('browser on a real network, server on another chain (the dangerous direction)', () => {
    const issues = errors(
      validateConfig({
        env: { ...REAL, BTC_NETWORK: 'testnet4', VITE_BTC_NETWORK: 'mainnet' },
        dataDir: mounted,
      })
    );
    expect(keys(issues)).toEqual(['VITE_BTC_NETWORK']);
    expect(issues[0].message).toMatch(/mainnet.*testnet4/);
  });

  test('browser off against a real server network (the silent direction)', () => {
    const issues = errors(validateConfig({ env: without(REAL, 'VITE_BTC_NETWORK'), dataDir: mounted }));
    expect(keys(issues)).toEqual(['VITE_BTC_NETWORK']);
    expect(issues[0].message).toMatch(/silently disabled/);
  });

  test('browser on a real network the server never mounted routes for', () => {
    const issues = errors(
      validateConfig({
        env: { ...GOOD, VITE_BTC_NETWORK: 'testnet4' }, // GOOD has no QUICKNODE_ENDPOINT
        dataDir: mounted,
      })
    );
    expect(keys(issues)).toEqual(['VITE_BTC_NETWORK']);
    expect(issues[0].message).toMatch(/not mounted/);
  });

  test('a mock-on-both-sides deploy is not flagged', () => {
    expect(validateConfig({ env: GOOD, dataDir: mounted })).toEqual([]);
  });

  test('the legacy VITE_BTC_TESTNET=1 alias is resolved the same way the bundle does', () => {
    expect(
      validateConfig({
        env: { ...REAL, BTC_NETWORK: 'testnet4', BTC_FAUCET_ADDRESS: 'tb1q', BTC_FAUCET_WIF: 'c', VITE_BTC_TESTNET: '1' },
        dataDir: mounted,
      })
    ).toEqual([]);
  });
});

describe('isMountedVolume', () => {
  test('the dir itself or a path under a mount point counts', () => {
    expect(isMountedVolume('/data', ['/data'])).toBe(true);
    expect(isMountedVolume('/data/originals', ['/data'])).toBe(true);
    expect(isMountedVolume('/data/', ['/data'])).toBe(true);
  });

  test('a writable container path with no volume behind it does not', () => {
    expect(isMountedVolume('/app/.originals-data', ['/data'])).toBe(false);
    expect(isMountedVolume('/data', [])).toBe(false);
    // A prefix match that is not a path-segment boundary is not a mount.
    expect(isMountedVolume('/database', ['/data'])).toBe(false);
  });

  test('the container root is never proof of a volume', () => {
    expect(isMountedVolume('/app/data', ['/'])).toBe(false);
  });

  test('a relative path can never be verified as a volume', () => {
    expect(isMountedVolume('./.originals-data', ['/data'])).toBe(false);
  });
});

describe('resolveDataDir', () => {
  test('falls back to the in-container default and says it was not explicit', () => {
    expect(resolveDataDir({})).toEqual({ path: './.originals-data', explicit: false });
    expect(resolveDataDir({ ORIGINALS_DATA_DIR: '/data' })).toEqual({ path: '/data', explicit: true });
  });
});

describe('strict mode', () => {
  test('warn-only is the default — strict is an explicit opt-in', () => {
    expect(isStrictConfig({})).toBe(false);
    expect(isStrictConfig({ ...DEPLOYED })).toBe(false);
    expect(isStrictConfig({ CONFIG_STRICT: '1' })).toBe(true);
    expect(isStrictConfig({ CONFIG_STRICT: 'true' })).toBe(true);
    expect(isStrictConfig({ CONFIG_STRICT: '0' })).toBe(false);
  });

  test('enforceConfig throws in strict mode, naming every offending value', () => {
    const issues = validateConfig({
      env: without(without(GOOD, 'JWT_SECRET'), 'TRUSTED_PROXY_HOPS'),
      dataDir: mounted,
    });
    expect(() => enforceConfig(issues, { strict: true, log: () => {} })).toThrow(/JWT_SECRET/);
    expect(() => enforceConfig(issues, { strict: true, log: () => {} })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  test('warn-only mode reports the same violations without throwing', () => {
    const lines: string[] = [];
    const issues = validateConfig({ env: without(GOOD, 'JWT_SECRET'), dataDir: mounted });
    expect(() => enforceConfig(issues, { strict: false, log: (m) => lines.push(m) })).not.toThrow();
    expect(lines.join('\n')).toContain('JWT_SECRET');
  });

  test('a clean config neither throws nor logs, in either mode', () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    enforceConfig([], { strict: true, log });
    enforceConfig([], { strict: false, log });
    expect(lines).toEqual([]);
  });
});

/**
 * U4 / KTD4 — the deposit indexer is a configuration seam. The contract's job
 * is to make the seam's state legible at boot: which index a mainnet deploy is
 * actually reading strangers' deposits from, and whether that read is
 * authenticated. Shipping on the free public default is a SANCTIONED choice
 * (KTD4), so it warns rather than erroring — CONFIG_STRICT=1 must not refuse
 * to start the very deploy this decision describes.
 */
describe('validateConfig — the deposit indexer seam', () => {
  const MAINNET = { ...GOOD, BTC_NETWORK: 'mainnet', QUICKNODE_ENDPOINT: 'https://q.example', VITE_BTC_NETWORK: 'mainnet' };

  test('a mainnet deploy on the free default is warned about, never errored', () => {
    const issues = validateConfig({ env: MAINNET, dataDir: mounted });
    const indexer = issues.filter((i) => i.key === 'BTC_INDEXER_API');
    expect(indexer).toHaveLength(1);
    expect(indexer[0].severity).toBe('warn');
    expect(errors(issues)).toEqual([]);
  });

  test('a configured indexer silences the warning', () => {
    const env = { ...MAINNET, BTC_INDEXER_API: 'https://idx.example/api', BTC_INDEXER_TOKEN: 'tok' };
    expect(keys(validateConfig({ env, dataDir: mounted }))).not.toContain('BTC_INDEXER_API');
  });

  test('a non-https indexer base URL is an error — the token would ride in cleartext', () => {
    const env = { ...MAINNET, BTC_INDEXER_API: 'http://idx.example/api' };
    const issues = errors(validateConfig({ env, dataDir: mounted }));
    expect(keys(issues)).toContain('BTC_INDEXER_API');
  });

  test('a token without a custom endpoint is reported — mempool.space ignores it', () => {
    const env = { ...MAINNET, BTC_INDEXER_TOKEN: 'tok' };
    expect(keys(validateConfig({ env, dataDir: mounted }))).toContain('BTC_INDEXER_TOKEN');
  });

  test('an auth header named with no token behind it is reported', () => {
    const env = { ...MAINNET, BTC_INDEXER_API: 'https://idx.example/api', BTC_INDEXER_AUTH_HEADER: 'X-Api-Key' };
    expect(keys(validateConfig({ env, dataDir: mounted }))).toContain('BTC_INDEXER_AUTH_HEADER');
  });

  test('a testnet4 deploy is not nagged about the free API', () => {
    expect(keys(validateConfig({ env: GOOD, dataDir: mounted }))).not.toContain('BTC_INDEXER_API');
  });
});
