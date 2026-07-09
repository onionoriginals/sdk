import { createTurnkeyClient } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';

let cached: Turnkey | null = null;

export function getTurnkey(): Turnkey {
  if (!cached) cached = createTurnkeyClient(); // reads TURNKEY_* env; throws if missing
  return cached;
}
