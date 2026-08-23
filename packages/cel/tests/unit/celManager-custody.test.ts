/**
 * The managers' getCurrentState custody fold — item 5's SECOND line of
 * defense: holder entries (post-anchor updates signed outside the creator
 * lineage) fold ONLY into state.custody. Even a hand-built holder entry that
 * (impossibly, past the verifier) carries `name` must not touch state — the
 * fold does not trust the verifier to have caught it.
 */
import { describe, test, expect } from 'bun:test';
import { PeerCelManager } from '../../src/layers/PeerCelManager';
import type { EventLog, LogEntry, DataIntegrityProof } from '../../src/types';

const CREATOR = 'did:key:z6MkCreatorCreatorCreatorCreatorCreatorCreator1';
const HOLDER = 'did:key:z6MkHolderHolderHolderHolderHolderHolderHolder2';

function proofBy(did: string): DataIntegrityProof {
  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: 'x',
    verificationMethod: `${did}#${did.slice('did:key:'.length)}`,
    proofPurpose: 'assertionMethod',
    proofValue: 'zunchecked',
  };
}

function entry(type: LogEntry['type'], data: Record<string, unknown>, signer: string, previousEvent?: string): LogEntry {
  return { type, data, ...(previousEvent ? { previousEvent } : {}), proof: [proofBy(signer)] } as LogEntry;
}

/** Hand-built (UNVERIFIED — that is the point) anchored log with extra events. */
function anchoredLog(extraEvents: LogEntry[]): EventLog {
  return {
    events: [
      entry('create', {
        name: 'Original Name',
        controller: CREATOR,
        resources: [{ id: 'art', digestMultibase: 'uEiA' }],
        createdAt: 'x',
        nonce: 'custody-1',
      }, CREATOR),
      entry('migrate', {
        sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest',
        to: 'did:btco:reg:123', migratedAt: 'x',
      }, CREATOR, 'uEiFake1'),
      ...extraEvents,
    ],
  };
}

// The fold never verifies proofs, so a signer-agnostic manager works for all
// three layer folds (they share beginCustodyFold/custodyFoldStep).
const manager = new PeerCelManager(async () => proofBy(CREATOR));

describe('getCurrentState custody fold', () => {
  test('a holder entry with `statement` folds into custody; name/resources unchanged', () => {
    const log = anchoredLog([
      entry('update', { author: HOLDER, statement: 'in my collection', occurredAt: 't1' }, HOLDER, 'uEiFake2'),
    ]);
    const state = manager.getCurrentState(log);
    expect(state.name).toBe('Original Name');
    expect(state.resources).toEqual([{ id: 'art', digestMultibase: 'uEiA' }]);
    expect(state.custody).toEqual([
      { author: HOLDER, statement: 'in my collection', occurredAt: 't1', eventIndex: 2 },
    ]);
    expect(state.holders).toEqual([HOLDER]);
  });

  test('a hand-built holder entry carrying `name` STILL leaves state unchanged — the fold does not trust the verifier', () => {
    const log = anchoredLog([
      entry('update', {
        author: HOLDER,
        name: 'Untitled (attributed to someone else)',
        resources: [{ id: 'fake', digestMultibase: 'uEiB' }],
        statement: 'smuggled',
      }, HOLDER, 'uEiFake2'),
    ]);
    const state = manager.getCurrentState(log);
    expect(state.name).toBe('Original Name');
    expect(state.resources).toEqual([{ id: 'art', digestMultibase: 'uEiA' }]);
    expect(state.metadata?.statement).toBeUndefined();
    expect(state.custody).toHaveLength(1);
    expect(state.custody![0].author).toBe(HOLDER);
  });

  test('a post-anchor creator update still folds normally (lineage, not boundary, decides)', () => {
    const log = anchoredLog([
      entry('update', { author: CREATOR, name: 'Renamed by creator', updatedAt: 't1' }, CREATOR, 'uEiFake2'),
    ]);
    const state = manager.getCurrentState(log);
    expect(state.name).toBe('Renamed by creator');
    expect(state.custody).toBeUndefined();
  });

  test('a post-anchor rotateKey touches NOTHING (never valid after the anchor)', () => {
    const log = anchoredLog([
      entry('rotateKey', { newController: HOLDER, rotatedAt: 't1' }, HOLDER, 'uEiFake2'),
      // …and an update by that "rotated-in" key is STILL a holder entry.
      entry('update', { author: HOLDER, name: 'takeover' }, HOLDER, 'uEiFake3'),
    ]);
    const state = manager.getCurrentState(log);
    expect(state.controller).toBe(CREATOR);
    expect(state.name).toBe('Original Name');
    expect(state.custody).toHaveLength(1);
  });

  test('a pre-anchor rotation extends the lineage: the rotated key\'s post-anchor update is a creator claim', () => {
    const ROTATED = 'did:key:z6MkRotatedRotatedRotatedRotatedRotatedRotated3';
    const log: EventLog = {
      events: [
        entry('create', { name: 'Original Name', controller: CREATOR, resources: [], createdAt: 'x', nonce: 'c2' }, CREATOR),
        entry('rotateKey', { newController: ROTATED, rotatedAt: 'x' }, CREATOR, 'uEiFake1'),
        entry('migrate', { sourceDid: 'x', layer: 'btco', network: 'regtest', to: 'did:btco:reg:123', migratedAt: 'x' }, ROTATED, 'uEiFake2'),
        entry('update', { author: ROTATED, name: 'Renamed after anchor' }, ROTATED, 'uEiFake3'),
      ],
    };
    const state = manager.getCurrentState(log);
    expect(state.name).toBe('Renamed after anchor');
    expect(state.custody).toBeUndefined();
  });
});
