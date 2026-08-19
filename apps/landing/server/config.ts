/**
 * The boot-time configuration contract (R10, R23).
 *
 * One place decides whether this process is configured to do what its
 * environment implies it should do, and every violation NAMES the value at
 * fault. A deployed instance reports errors; locally the same violations are
 * warnings and the server degrades exactly as it does today.
 *
 * Strict mode (`CONFIG_STRICT=1`) turns a deployed-environment error into a
 * startup throw. It is OFF by default on purpose: this ships to a live
 * deployment with `restartPolicyMaxRetries: 5`, so a value production does not
 * actually have would take the site DOWN rather than degrade it. Land it
 * warn-only, read the boot log against the real environment, then set
 * CONFIG_STRICT=1. Rollback is unsetting that one variable — no redeploy of
 * code.
 *
 * Every rule is a pure function over an env snapshot plus a data-dir probe, so
 * "writable but not a mounted volume" is testable without a container.
 */
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { isLikelyDeployed } from './deploy-env';
import { isBitcoinConfigured, serverBtcNetwork } from './bitcoin';

export type ConfigSeverity = 'error' | 'warn';

export interface ConfigIssue {
  /** The env var at fault. Always named — a report you cannot act on is noise. */
  key: string;
  severity: ConfigSeverity;
  message: string;
}

/** What the disk told us about ORIGINALS_DATA_DIR. Gathered impurely, judged purely. */
export interface DataDirProbe {
  path: string;
  writable: boolean;
  /** Mount points visible to this process (platform volume var + /proc/mounts). */
  mountPoints: string[];
}

export interface ConfigInput {
  env: Record<string, string | undefined>;
  /** null when the dir was never probed (not configured, or probing was skipped). */
  dataDir?: DataDirProbe | null;
}

/** The in-container fallback — fine for dev, wiped by every redeploy on a host. */
export const DEFAULT_DATA_DIR = './.originals-data';

/** Minimum JWT secret length: below this the HMAC is the weak link, not the token. */
const MIN_JWT_SECRET_LENGTH = 32;

const AUTH_KEYS = [
  'JWT_SECRET',
  'TURNKEY_API_PUBLIC_KEY',
  'TURNKEY_API_PRIVATE_KEY',
  'TURNKEY_ORGANIZATION_ID',
] as const;

/**
 * Is the auth surface meant to be mounted? Same conditional shape as
 * `isBitcoinConfigured()`: any one of the four present means the operator
 * intended auth, so all four are then required.
 */
export function authIntended(env: Record<string, string | undefined>): boolean {
  return AUTH_KEYS.some((k) => !!env[k]);
}

export function resolveDataDir(env: Record<string, string | undefined>): {
  path: string;
  explicit: boolean;
} {
  const explicit = !!env.ORIGINALS_DATA_DIR;
  return { path: env.ORIGINALS_DATA_DIR ?? DEFAULT_DATA_DIR, explicit };
}

const stripTrailingSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Is `path` backed by one of `mountPoints`? A writable path proves nothing —
 * the container filesystem is writable everywhere and a redeploy deletes it,
 * and this path holds the only copies of signed reveal transactions. The
 * container root is never proof of a volume.
 */
export function isMountedVolume(path: string, mountPoints: string[]): boolean {
  if (!isAbsolute(path)) return false;
  const target = stripTrailingSlash(path);
  return mountPoints.some((raw) => {
    if (!raw || !isAbsolute(raw)) return false;
    const mount = stripTrailingSlash(raw);
    if (mount === '/') return false;
    return target === mount || target.startsWith(mount + '/');
  });
}

/**
 * The platform-injected volume mount path(s). Railway sets
 * RAILWAY_VOLUME_MOUNT_PATH on any service with a volume attached; the generic
 * VOLUME_MOUNT_PATH covers other hosts. Same family of variables
 * `deploy-env.ts` already reads.
 */
export function declaredVolumeMounts(env: Record<string, string | undefined>): string[] {
  return [env.RAILWAY_VOLUME_MOUNT_PATH, env.VOLUME_MOUNT_PATH].filter(
    (v): v is string => !!v
  );
}

/** Linux mount table cross-check — best effort, absent on macOS and that is fine. */
export function readProcMounts(read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  try {
    return read('/proc/mounts')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter((p): p is string => !!p && p.startsWith('/'));
  } catch {
    return [];
  }
}

/**
 * Probe the data dir: can we actually write there, and what mount points are
 * visible? Creates the dir the same way the stores do (lazily, recursive), so
 * a first boot on a fresh volume is not reported as unwritable.
 */
export function probeDataDir(
  path: string,
  env: Record<string, string | undefined> = process.env
): DataDirProbe {
  let writable = false;
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  return {
    path,
    writable,
    mountPoints: [...declaredVolumeMounts(env), ...readProcMounts()],
  };
}

/**
 * The contract. Pure: same inputs, same issues, no disk and no process.env.
 */
export function validateConfig(input: ConfigInput): ConfigIssue[] {
  const env = input.env;
  const deployed = isLikelyDeployed(env);
  const issues: ConfigIssue[] = [];
  const severity: ConfigSeverity = deployed ? 'error' : 'warn';
  const report = (key: string, message: string) => issues.push({ key, severity, message });

  // NODE_ENV: a deployed instance running in dev mode is a different program.
  if (deployed && env.NODE_ENV !== 'production') {
    report(
      'NODE_ENV',
      `NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'} on a deployed instance — set NODE_ENV=production.`
    );
  }

  // Auth: required only when the auth surface is meant to be mounted.
  if (authIntended(env)) {
    if (!env.JWT_SECRET) {
      report('JWT_SECRET', 'JWT_SECRET is missing — the auth API cannot mount without it.');
    } else if (env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
      report(
        'JWT_SECRET',
        `JWT_SECRET is ${env.JWT_SECRET.length} characters — at least ${MIN_JWT_SECRET_LENGTH} are required.`
      );
    }
    for (const key of AUTH_KEYS.filter((k) => k !== 'JWT_SECRET')) {
      if (!env[key]) report(key, `${key} is missing — the auth API cannot mount without it.`);
    }
  }

  // Bitcoin network: on a deploy the silent testnet4 default is itself a bug.
  const btcNetwork = env.BTC_NETWORK;
  if (!btcNetwork) {
    if (deployed) {
      report(
        'BTC_NETWORK',
        'BTC_NETWORK is not set — a deploy must name its chain (mainnet|testnet4) rather than inherit the testnet4 default.'
      );
    }
  } else if (btcNetwork !== 'mainnet' && btcNetwork !== 'testnet4') {
    report(
      'BTC_NETWORK',
      `BTC_NETWORK="${btcNetwork}" is not a network this server speaks (mainnet|testnet4) — it silently falls back to testnet4.`
    );
  }

  // QuickNode: required once the network names the chain that spends real
  // money. On testnet4 its absence is a documented mock-mode degrade.
  if (btcNetwork === 'mainnet' && !env.QUICKNODE_ENDPOINT) {
    report(
      'QUICKNODE_ENDPOINT',
      'QUICKNODE_ENDPOINT is missing with BTC_NETWORK=mainnet — real inscription would silently stay mock.'
    );
  }
  if (env.QUICKNODE_ENDPOINT && !/^https:\/\/\S+$/.test(env.QUICKNODE_ENDPOINT)) {
    report('QUICKNODE_ENDPOINT', 'QUICKNODE_ENDPOINT is not an https:// URL.');
  }

  // Network skew, server side (R11). VITE_BTC_NETWORK is baked into the bundle
  // at BUILD time and BTC_NETWORK is read at RUNTIME; the browser's own check
  // only ever sees its half. Both directions are reported here:
  //   browser real, server elsewhere → the dangerous one (deposit address the
  //     server can never spend from) — the browser also blocks it at click time;
  //   browser off, server real → the silent one: a mainnet deploy serving a
  //     mock site with nobody noticing.
  const browserFlag = browserBtcFlag(env);
  const serverChain = serverBtcNetwork(env);
  const serverReal = isBitcoinConfigured(env);
  if (browserFlag !== 'off' && browserFlag !== serverChain) {
    report(
      'VITE_BTC_NETWORK',
      `VITE_BTC_NETWORK="${browserFlag}" but the server speaks ${serverChain} — the built bundle and this process disagree about the chain.`
    );
  } else if (browserFlag !== 'off' && !serverReal) {
    report(
      'VITE_BTC_NETWORK',
      `VITE_BTC_NETWORK="${browserFlag}" but the server's Bitcoin routes are not mounted (QUICKNODE_ENDPOINT${serverChain === 'mainnet' ? '' : '/BTC_FAUCET_*'} absent) — inscribing is blocked for every visitor.`
    );
  } else if (browserFlag === 'off' && serverReal) {
    report(
      'VITE_BTC_NETWORK',
      `VITE_BTC_NETWORK is unset/off while the server is fully configured for ${serverChain} — the real path is silently disabled for every visitor. Set it and REBUILD the SPA (Vite bakes it at build time).`
    );
  }

  // Durable data. Only signed-in users have any, so this follows the auth surface.
  if (authIntended(env)) {
    const { explicit } = resolveDataDir(env);
    if (!explicit) {
      report(
        'ORIGINALS_DATA_DIR',
        `ORIGINALS_DATA_DIR is not set — durable Originals fall back to ${DEFAULT_DATA_DIR}, which a redeploy wipes.`
      );
    }
    const probe = input.dataDir;
    if (probe) {
      if (!probe.writable) {
        report('ORIGINALS_DATA_DIR', `ORIGINALS_DATA_DIR (${probe.path}) is not writable.`);
      } else if (deployed && explicit && !isMountedVolume(probe.path, probe.mountPoints)) {
        report(
          'ORIGINALS_DATA_DIR',
          `ORIGINALS_DATA_DIR (${probe.path}) is writable but is not a mounted volume — attach a persistent volume and point it at the mount path. Writability alone survives nothing: a redeploy deletes this path, and it holds the only copies of signed reveal transactions.`
        );
      }
    }
  }

  // Trusted proxy hops: every rate limit's correctness rests on it, and unset
  // degrades silently to one site-wide bucket (U7 reads this value).
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops === undefined || hops === '') {
    if (deployed) {
      report(
        'TRUSTED_PROXY_HOPS',
        'TRUSTED_PROXY_HOPS is not set — behind a proxy, every client collapses into one rate-limit bucket. Set it to the number of proxies in front of this service (Railway: 1).'
      );
    }
  } else if (!/^\d+$/.test(hops)) {
    report('TRUSTED_PROXY_HOPS', `TRUSTED_PROXY_HOPS="${hops}" is not a non-negative integer.`);
  }

  return issues;
}

/**
 * The browser build flag as the SERVER sees it — the same resolution
 * src/sdk/network-flag.ts does in the bundle, including the legacy
 * VITE_BTC_TESTNET=1 alias, so the two halves cannot drift apart.
 */
export function browserBtcFlag(
  env: Record<string, string | undefined>
): 'mainnet' | 'testnet4' | 'off' {
  const v = env.VITE_BTC_NETWORK;
  if (v === 'mainnet' || v === 'testnet4') return v;
  if (v === undefined || v === '') return env.VITE_BTC_TESTNET === '1' ? 'testnet4' : 'off';
  return 'off';
}

/** Warn-only unless explicitly opted in. See the module header for why. */
export function isStrictConfig(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CONFIG_STRICT;
  return v === '1' || v === 'true';
}

export function formatConfigReport(issues: ConfigIssue[], strict: boolean): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const head = strict
    ? 'Refusing to start — the configuration contract is not met:'
    : errors.length > 0
      ? 'Configuration contract NOT met (warn-only: set CONFIG_STRICT=1 to make this fatal):'
      : 'Configuration warnings (degrading as configured):';
  const lines = issues.map((i) => `  [${i.severity}] ${i.key}: ${i.message}`);
  return `[landing] ${head}\n${lines.join('\n')}`;
}

/**
 * Report the issues, and in strict mode throw on the first deployed-environment
 * error. Pure over its `log` sink so a test never writes to the console.
 */
export function enforceConfig(
  issues: ConfigIssue[],
  opts: { strict?: boolean; log?: (message: string) => void } = {}
): void {
  if (issues.length === 0) return;
  const strict = opts.strict ?? isStrictConfig();
  const log = opts.log ?? ((m: string) => console.warn(m));
  const errors = issues.filter((i) => i.severity === 'error');
  const message = formatConfigReport(issues, strict && errors.length > 0);
  if (strict && errors.length > 0) throw new Error(message);
  log(message);
}

/**
 * The boot-time entry point: probe what needs probing, validate, report.
 * Returns the issues so serve.ts can log a one-line summary alongside them.
 */
export function checkConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (message: string) => void } = {}
): ConfigIssue[] {
  const { path } = resolveDataDir(env);
  const dataDir = authIntended(env) ? probeDataDir(path, env) : null;
  const issues = validateConfig({ env, dataDir });
  enforceConfig(issues, { strict: isStrictConfig(env), log: opts.log });
  return issues;
}
