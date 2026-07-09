import type { SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';

// Real implementation lands in Phase 2 (Task 11).
export function createDidRoutes(_deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { createDid: Handler } {
  return { createDid: () => json({ message: 'Not implemented' }, 501) };
}
