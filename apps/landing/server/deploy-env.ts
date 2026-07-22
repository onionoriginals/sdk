/**
 * Best-effort "are we running on a deployed instance?" check, used to decide
 * whether a missing ORIGINALS_DATA_DIR is a loud misconfiguration (deploy) or
 * just a dev default (local). Railway sets RAILWAY_* on every deploy; a generic
 * NODE_ENV=production covers other hosts. Pure over its env arg for testing.
 */
export function isLikelyDeployed(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env.RAILWAY_ENVIRONMENT ||
      env.RAILWAY_PROJECT_ID ||
      env.RAILWAY_SERVICE_ID ||
      env.NODE_ENV === 'production'
  );
}
