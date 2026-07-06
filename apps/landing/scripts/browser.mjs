// Shared Chromium resolution for the browser harnesses (smoke/shots/tti).
// Priority: explicit env override → this repo's managed-CI path → whatever
// playwright-core resolves on the local machine (undefined lets it look up
// its own installed browser and fail with its descriptive error otherwise).
import { existsSync } from 'node:fs';

export function chromiumExecutablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  return undefined;
}
