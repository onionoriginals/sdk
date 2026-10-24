/**
 * What the anchoring outbox does with each answer to a resent pair (owner
 * decision, 23 October 2026, and decision A of the #996 review; P9.6). A pair
 * is never deleted silently, and it is judged by the server's category and
 * code, not its HTTP status alone:
 * - auth, gate, rate, server and network failures, transient categories and
 *   codes, and any code not known to be permanent keep the pair unchanged and
 *   it is sent again;
 * - only refusals the same signed bytes can never pass mark it refused, kept
 *   for recovery, and not sent again; only an explicit abandon deletes it.
 */
import { describe, expect, test } from 'bun:test';
import { base64 } from '@scure/base';
import type { PreparedEntryInscription } from '@originals/sdk/originals/bitcoin';
import {
  AnchoringRefusedError, AnchoringSubmitError, abandonRefused, isPairRefusal, memoryOutbox, resendWaiting,
  type AnchoringOutbox, type AnchoringTransport, type OutboxEntry,
} from './anchoring';

const DID = 'did:vh:QmRefusalTest';
const entry = (): OutboxEntry => ({
  pair: { versionId: '2-QmEntry', prepared: { commitTxId: 'c0', revealTxId: 'r0' } } as unknown as PreparedEntryInscription,
  evidence: base64.encode(new Uint8Array([1, 2, 3])),
  savedAt: '2026-10-23T10:00:00.000Z',
});

function transport(answer: () => Promise<unknown>) {
  let calls = 0;
  const t = { submit: async () => { calls++; return answer(); } } as unknown as AnchoringTransport;
  return { t, calls: () => calls };
}

type Body = { error?: string; code?: string; category?: string; message?: string };

/** Pair-permanent refusals, as server/originals-anchoring.ts and server/bitcoin.ts answer them. */
const refusals: Array<[string, number, Body]> = [
  ['original_forked', 409, { error: 'original_forked', message: 'The copies diverge.' }],
  ['signed_pair_mismatch', 409, { error: 'signed_pair_mismatch', message: 'Different signed bytes.' }],
  ['SAT_MOVED', 409, { error: 'not_sendable', code: 'SAT_MOVED', category: 'stale-parent', message: 'The sat moved.' }],
  ['sat_not_first', 409, { error: 'sat_not_first', message: 'The sat is not first.' }],
  ['payload_too_large', 413, { error: 'payload_too_large' }],
  ['INSCRIPTION_TOO_LARGE', 413, { error: 'not_sendable', code: 'INSCRIPTION_TOO_LARGE', category: 'limit-exceeded', message: 'Too large.' }],
  ['bad_request', 400, { error: 'bad_request' }],
  ['evidence_not_verified', 422, { error: 'evidence_not_verified', code: 'COMMIT_VERIFICATION_FAILED', category: 'invalid-evidence', message: 'Does not verify.' }],
  ['commit_fee_excessive', 400, { error: 'commit_fee_excessive', message: 'Fee too high.' }],
  ['commit_change_omitted', 400, { error: 'commit_change_omitted', message: 'Change missing.' }],
];

describe('a pair-permanent refusal is kept, marked refused, and not resent (decision A; P9.6)', () => {
  for (const [name, status, body] of refusals) {
    test(name, async () => {
      const outbox = memoryOutbox();
      const saved = entry();
      await outbox.put(DID, saved);
      const { t, calls } = transport(() => Promise.reject(new AnchoringSubmitError(status, body)));

      const first = await resendWaiting(t, outbox, DID).catch((e) => e);
      expect(first).toBeInstanceOf(AnchoringRefusedError);
      const refusal = (first as AnchoringRefusedError).refusal;
      expect(refusal.status).toBe(status);
      expect(refusal.code).toBe(body.code ?? body.error!);
      expect(refusal.error).toBe(body.error);
      expect(refusal.category).toBe(body.category);
      // Kept, byte for byte, with the reason beside it: never deleted silently.
      const kept = await outbox.get(DID);
      expect(kept?.pair).toEqual(saved.pair);
      expect(kept?.evidence).toBe(saved.evidence);
      expect(kept?.refused).toEqual(refusal);

      // Not sent again automatically.
      await expect(resendWaiting(t, outbox, DID)).rejects.toBeInstanceOf(AnchoringRefusedError);
      expect(calls()).toBe(1);

      // Only an explicit abandon removes it, and then a new pair can be prepared.
      expect(await abandonRefused(outbox, DID)).toBe(true);
      expect(await outbox.get(DID)).toBeUndefined();
      expect(await resendWaiting(t, outbox, DID)).toBeNull();
    });
  }
});

describe('a pair whose answer may still come is kept unchanged and resent (decision A; P9.6)', () => {
  const keeps: Array<[string, () => unknown]> = [
    ['401 unauthorized', () => new AnchoringSubmitError(401, { error: 'unauthorized' })],
    ['404 anchoring off', () => new AnchoringSubmitError(404, { error: 'bitcoin_anchoring_off' })],
    ['408 timeout', () => new AnchoringSubmitError(408, { error: 'timeout' })],
    ['429 rate limited', () => new AnchoringSubmitError(429, { error: 'inscribe_user_cap' })],
    ['500 server error', () => new AnchoringSubmitError(500, { error: 'internal' })],
    ['502 writer failure', () => new AnchoringSubmitError(502, { error: 'not_sendable' })],
    ['503 incomplete evidence', () => new AnchoringSubmitError(503, { error: 'evidence_not_verified', code: 'X', category: 'incomplete-evidence', message: 'later' })],
    ['unavailable-bytes category, whatever the status', () => new AnchoringSubmitError(422, { error: 'not_sendable', code: 'SOMETHING', category: 'unavailable-bytes' })],
    ['incomplete-evidence category on a 4xx', () => new AnchoringSubmitError(422, { error: 'evidence_not_verified', code: 'AUTHOR_HISTORY_MISSING', category: 'incomplete-evidence' })],
    ['SAT_READ_INCOMPLETE', () => new AnchoringSubmitError(422, { error: 'not_sendable', code: 'SAT_READ_INCOMPLETE' })],
    ['BLOCK_TIME_UNAVAILABLE', () => new AnchoringSubmitError(422, { error: 'not_sendable', code: 'BLOCK_TIME_UNAVAILABLE' })],
    ['funding_input_spent (index lag)', () => new AnchoringSubmitError(409, { error: 'funding_input_spent', message: 'spent or unconfirmed' })],
    ['PAIR_IN_FLIGHT', () => new AnchoringSubmitError(409, { error: 'not_sendable', code: 'PAIR_IN_FLIGHT', category: 'stale-parent' })],
    ['HEAD_NOT_NEXT', () => new AnchoringSubmitError(409, { error: 'not_sendable', code: 'HEAD_NOT_NEXT', category: 'stale-parent' })],
    ['403 address_not_bound', () => new AnchoringSubmitError(403, { error: 'address_not_bound' })],
    ['an unknown 4xx code', () => new AnchoringSubmitError(422, { error: 'not_sendable', code: 'SOMETHING_NEW' })],
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

describe('abandoning is one check-and-delete (P9.6)', () => {
  test('nothing to abandon is reported as nothing abandoned', async () => {
    expect(await abandonRefused(memoryOutbox(), DID)).toBe(false);
  });

  test('the check and the delete are one outbox step: a pair that became uncertain in between is kept', async () => {
    const inner = memoryOutbox();
    await inner.put(DID, { ...entry(), refused: { status: 409, code: 'original_forked', message: 'm', at: 'now' } });
    // A read-then-delete would see the refused pair; the delete must check again in its own step.
    // Here another tab replaces it with a fresh uncertain pair just before that step.
    const racing: AnchoringOutbox = {
      ...inner,
      get: async () => { throw new Error('abandon must not decide from a separate read'); },
      delete: async () => { throw new Error('abandon must not delete without checking in the same step'); },
      deleteIf: async (did, keep) => { await inner.put(did, entry()); return inner.deleteIf(did, keep); },
    };
    await expect(abandonRefused(racing, DID)).rejects.toThrow(/may still be accepted/);
    expect((await inner.get(DID))?.refused).toBeUndefined();
  });
});
