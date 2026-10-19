/**
 * Witness service configuration, from the environment.
 *
 *   WITNESS_SECRET_KEY  64 hex characters: the Ed25519 secret behind the
 *                       witness's did:key. A secret; never logged.
 *   WITNESS_DATA_DIR    where the durable approval ledger lives.
 *   WITNESS_PATH        the endpoint path, default /witness.
 *   PORT                default 8080.
 */
export interface WitnessConfig {
  secretKey: Uint8Array;
  dataDir: string;
  path: string;
  port: number;
}

export function parseWitnessConfig(env: Record<string, string | undefined>): WitnessConfig {
  const problems: string[] = [];
  const hex = env.WITNESS_SECRET_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) problems.push("WITNESS_SECRET_KEY must be 64 hex characters");
  const dataDir = env.WITNESS_DATA_DIR ?? "";
  if (dataDir === "") problems.push("WITNESS_DATA_DIR is required");
  const path = env.WITNESS_PATH ?? "/witness";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path === "/health") problems.push("WITNESS_PATH must be a plain path other than /health");
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) problems.push("PORT must be a port number");
  if (problems.length > 0) throw new Error(`witness configuration: ${problems.join("; ")}`);
  const secretKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secretKey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { secretKey, dataDir, path, port };
}
