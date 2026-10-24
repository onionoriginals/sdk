/**
 * What the anchoring outbox does with each answer to a resent pair (owner
 * decision, 23 October 2026; P9.6). A pair is never deleted silently:
 * - auth, gate, rate and server failures (401, 404, 408, 429, 5xx) and network
 *   errors keep the pair unchanged and it is sent again next time;
 * - a refusal of this pair itself (400, 409, 422, as server/originals-anchoring.ts
 *   and server/bitcoin.ts answer them) marks it refused, kept for recovery, and
 *   it is not sent again; only an explicit abandon deletes it.
 */
import { describe, expect, test } from 'bun:test';
import { base64 } from '@scure/base';
import type { PreparedEntryInscription } from '@originals/sdk/originals/bitcoin';
import {
  AnchoringRefusedError, AnchoringSubmitError, abandonRefused, isPairRefusal, memoryOutbox, resendWaiting,
  type AnchoringTransport, type OutboxEntry,
} from './anchoring';

const DID = 'did:vh:QmRefusalTest';
const entry = (): OutboxEntry => ({
  pair: { versionId: '2-QmEntry', prepared: { commitTxId: 'c0', revealTxId: 'r0' } } as unknown as PreparedEntryInscription,
  evidence: base64.encode(new Uint8Array([1, 2, 3])),
  savedAt: '2026-10-23T10:00:00.000Z',
});

function transport(answer: () => Promise<unknown>) {
  let calls = 0;
  const t = {
    submit: async () => { calls++; return answer(); },
  } as unknown as AnchoringTransport;
  return { t, calls: () => calls };
}

const refusals: Array<[number, string]> = [
  [409, 'original_forked'],
  [409, 'signed_pair_mismatch'],
  [422, 'evidence_not_verified'],
  [422, 'not_sendable'],
  [400, 'bad_request'],
];

describe('a pair the server refuses is kept, marked refused, and not resent (owner decision, 23 October 2026; P9.6)', () => {
  for (const [status, code] of refusals) {
    test(`${status} ${code}`, async () => {
      const outbox = memoryOutbox();
      const saved = entry();
      await outbox.put(DID, saved);
      const message = `The server refused it (${code}).`;
      const { t, calls } = transport(() => Promise.reject(new AnchoringSubmitError(status, { error: code, message })));

      const first = await resendWaiting(t, outbox, DID).catch((e) => e);
      expect(first).toBeInstanceOf(AnchoringRefusedError);
      expect((first as AnchoringRefusedError).refusal).toMatchObject({ status, code, message });
      // Kept, byte for byte, with the reason beside it: never deleted silently.
      const kept = await outbox.get(DID);
      expect(kept?.pair).toEqual(saved.pair);
      expect(kept?.evidence).toBe(saved.evidence);
      expect(kept?.refused).toMatchObject({ status, code, message });

      // Not sent again automatically.
      await expect(resendWaiting(t, outbox, DID)).rejects.toBeInstanceOf(AnchoringRefusedError);
      expect(calls()).toBe(1);

      // Only an explicit abandon removes it, and then a new pair can be prepared.
      await abandonRefused(outbox, DID);
      expect(await outbox.get(DID)).toBeUndefined();
      expect(await resendWaiting(t, outbox, DID)).toBeNull();
    });
  }
});

describe('a pair whose answer may still come is kept unchanged and resent (P9.6)', () => {
  const keeps: Array<[string, () => unknown]> = [
    ['401 unauthorized', () => new AnchoringSubmitError(401, { error: 'unauthorized' })],
    ['404 anchoring off', () => new AnchoringSubmitError(404, { error: 'bitcoin_anchoring_off' })],
    ['408 timeout', () => new AnchoringSubmitError(408, { error: 'timeout' })],
    ['429 rate limited', () => new AnchoringSubmitError(429, { error: 'inscribe_user_cap' })],
    ['500 server error', () => new AnchoringSubmitError(500, { error: 'internal' })],
    ['502 writer failure', () => new AnchoringSubmitError(502, { error: 'not_sendable' })],
    ['503 incomplete evidence', () => new AnchoringSubmitError(503, { error: 'evidence_not_verified', code: 'X', message: 'later' })],
    ['network error', () => new TypeError('Failed to fetch')],
  ];
  for (const [name, error] of keeps) {
    test(name, async () => {
      const outbox = memoryOutbox();
      const saved = entry();
      await outbox.put(DID, saved);
      const { t, calls } = transport(() => Promise.reject(error()));
      const thrown = await resendWaiting(t, outbox, DID).catch((e) => e);
      expect(thrown).not.toBeInstanceOf(AnchoringRefusedError);
      expect(isPairRefusal(thrown)).toBe(false);
      expect(await outbox.get(DID)).toEqual(saved);
      await resendWaiting(t, outbox, DID).catch(() => undefined);
      expect(calls()).toBe(2);
      // Abandoning is only for a refused pair: an uncertain one may already be on its way.
      await expect(abandonRefused(outbox, DID)).rejects.toThrow();
      expect(await outbox.get(DID)).toEqual(saved);
    });
  }
});
