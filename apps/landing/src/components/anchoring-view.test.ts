import { describe, expect, test } from 'bun:test';
import { demo, library } from '../content';
import type { AnchoringStatus } from '../sdk/anchoring';
import { AnchoringCancelledError, AnchoringSubmitError, SigningSessionExpiredError } from '../sdk/anchoring';
import { anchoringFailureMessage, anchoringInMotion, anchoringView, offChainPreview } from './anchoring-view';

const status = (over: Partial<AnchoringStatus>): AnchoringStatus => ({
  did: 'did:vh:x', sat: 'did:btco:reg:5000000000', publication: 'not-anchored', action: 'prepare',
  heads: { committed: '2-b', accepted: null, acceptedHeight: null, next: '2-b', queue: ['2-b'] }, current: false,
  ownership: null, indexes: { used: ['ord@quicknode'], compared: false }, recoveryIssues: [], satUtxo: null, heldByThisAccount: null,
  ...over,
});

describe('the anchoring panel (P9.18)', () => {
  test('each publication state has its own label; only anchored reads as done', () => {
    for (const publication of ['not-anchored', 'submitted-unobserved', 'pending-bitcoin-acceptance', 'anchored', 'unverified'] as const) {
      const v = anchoringView({ status: status({ publication }), unpublished: [] })!;
      expect(v.label).toBe(demo.anchoring.labels[publication]);
      expect(v.tone === 'ok').toBe(publication === 'anchored');
    }
    // A pair nothing shows on the network is never called pending acceptance.
    expect(anchoringView({ status: status({ publication: 'submitted-unobserved' }), unpublished: [] })!.label).not.toBe(demo.anchoring.labels['pending-bitcoin-acceptance']);
  });

  test('never current until Bitcoin shows the anchor (P7.10)', () => {
    expect(anchoringView({ status: status({ publication: 'pending-bitcoin-acceptance', action: 'wait-for-confirmation' }), unpublished: ['2-b'] })!.neverCurrentNote).toBe(demo.anchoring.neverCurrentNote);
    expect(anchoringView({ status: status({ publication: 'anchored', action: 'done' }), unpublished: [] })!.neverCurrentNote).toBeNull();
  });

  test('the holder and the index trust are separate lines, and one index is said to be one (P9.10, P9.11)', () => {
    const v = anchoringView({
      status: status({ publication: 'anchored', action: 'done', ownership: { status: 'provisional', output: 'aa:0', confirmations: 3, indexes: ['ord@quicknode'] }, heldByThisAccount: true }),
      unpublished: [],
    })!;
    expect(v.holder).toEqual({ output: 'aa:0', note: demo.anchoring.holderNote });
    expect(v.confirmations).toBe('3 confirmations');
    expect(v.indexNote).toBe(demo.anchoring.indexSingle('ord@quicknode'));
  });

  test('the next version can be inscribed only when the anchor is accepted, nothing is in flight, and the sat is at this address', () => {
    const anchored = status({ publication: 'anchored', action: 'done', heldByThisAccount: true });
    expect(anchoringView({ status: anchored, unpublished: ['3-c'] })!.canInscribeNext).toBe(true);
    expect(anchoringView({ status: anchored, unpublished: [] })!.canInscribeNext).toBe(false);
    expect(anchoringView({ status: { ...anchored, action: 'wait-for-confirmation' }, unpublished: ['3-c'] })!.canInscribeNext).toBe(false);
    expect(anchoringView({ status: { ...anchored, heldByThisAccount: false }, unpublished: ['3-c'] })!).toMatchObject({ canInscribeNext: false, holderElsewhere: true });
    expect(anchoringView({ status: status({ publication: 'pending-bitcoin-acceptance', action: 'wait-for-confirmation' }), unpublished: ['2-b', '3-c'] })!.canInscribeNext).toBe(false);
  });

  test('a settled panel is not polled; one still in motion is', () => {
    expect(anchoringInMotion({ status: status({ publication: 'anchored', action: 'done' }), unpublished: ['3-c'] })).toBe(false);
    expect(anchoringInMotion({ status: status({ publication: 'anchored', action: 'wait-for-confirmation' }), unpublished: [] })).toBe(true);
    expect(anchoringInMotion({ status: status({ publication: 'submitted-unobserved', action: 'resume' }), unpublished: [] })).toBe(true);
    expect(anchoringInMotion({ status: null, unpublished: [] })).toBe(false);
  });

  test('what Bitcoin will not hold is listed before signing: the files and the author\'s DID history', () => {
    expect(offChainPreview({ resource: { id: 'artwork.svg' } as never, metadata: { id: 'metadata.json' } as never, author: 'did:webvh:x:host:u' }))
      .toEqual(['artwork.svg', 'metadata.json', demo.anchoring.offChainIdentity('did:webvh:x:host:u')]);
  });

  test('cancel, expiry and a server refusal each have their own words', () => {
    expect(anchoringFailureMessage(new AnchoringCancelledError())).toBe(demo.anchoring.cancelled);
    expect(anchoringFailureMessage(new SigningSessionExpiredError())).toBe(demo.anchoring.sessionExpired);
    expect(anchoringFailureMessage(new AnchoringSubmitError(409, { code: 'SAT_MOVED', message: 'the sat moved' }))).toBe('the sat moved');
    expect(anchoringFailureMessage(new Error('other'))).toBeNull();
  });

  test('a refused pair names the reason and that it is kept; a fork says no branch is current (owner decision, 23 October 2026; P6.6, P9.6)', async () => {
    const { AnchoringRefusedError } = await import('../sdk/anchoring');
    const { ForkUnresolvedError } = await import('../sdk/engine');
    const refused = anchoringFailureMessage(new AnchoringRefusedError({ status: 409, code: 'original_forked', message: 'The copies diverge.', at: '2026-10-23T00:00:00Z' }));
    expect(refused).toBe(demo.anchoring.refused('The copies diverge.'));
    expect(refused).toMatch(/kept/);
    expect(anchoringFailureMessage(new ForkUnresolvedError({ version: 2, branches: [{ source: 'supplied', versionId: '2-a' }, { source: 'local', versionId: '2-b' }] }))).toBe(library.forkUnresolved);
    expect(library.forkUnresolved).toMatch(/Fork unresolved — no current branch/);
  });
});
