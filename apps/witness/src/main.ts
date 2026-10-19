/**
 * Start a witness. Author DIDs are read with the SSRF-safe fetcher from where
 * did:webvh publishes them, each time an entry is approved (P9.8).
 */
import { FileWitnessLedger } from "@originals/sdk/originals/fs";
import { webvhAuthorSource } from "@originals/sdk/originals";
import { safeFetch } from "@originals/vh/fetch";
import { createWitnessApp } from "./app.js";
import { parseWitnessConfig } from "./config.js";

const config = parseWitnessConfig(process.env);
const app = createWitnessApp({
  secretKey: config.secretKey,
  path: config.path,
  ledger: await FileWitnessLedger.open(config.dataDir),
  authors: webvhAuthorSource(async (url) => (await safeFetch(url)).bytes),
});
Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`witness ${app.id} listening on :${config.port}${config.path}`);
