/**
 * The HTTP status a writer refusal is answered with (decision A of the #996
 * review). A Bitcoin read that is missing bytes is transient, so it is a 503
 * the browser keeps and resends, never a 4xx that would mark the pair refused.
 */
import { expect, test } from 'bun:test';
import { OriginalsError } from '@originals/vh';
import { refusal } from '@originals/host';
import { AnchoringSubmitError, isPairRefusal } from '../../src/sdk/anchoring';

test('unavailable-bytes is 503 and the browser keeps the pair (P9.6)', () => {
  const r = refusal(new OriginalsError('unavailable-bytes', 'SAT_READ_INCOMPLETE', 'the sat was not read in full'), 'not_sendable');
  expect(r.httpStatus).toBe(503);
  expect(isPairRefusal(new AnchoringSubmitError(r.httpStatus, r))).toBe(false);
});

test('the other categories keep their statuses', () => {
  expect(refusal(new OriginalsError('incomplete-evidence', 'X', 'm'), 'not_sendable').httpStatus).toBe(503);
  expect(refusal(new OriginalsError('stale-parent', 'SAT_MOVED', 'm'), 'not_sendable').httpStatus).toBe(409);
  expect(refusal(new OriginalsError('limit-exceeded', 'INSCRIPTION_TOO_LARGE', 'm'), 'not_sendable').httpStatus).toBe(413);
  expect(refusal(new OriginalsError('invalid-evidence', 'X', 'm'), 'evidence_not_verified').httpStatus).toBe(422);
});
