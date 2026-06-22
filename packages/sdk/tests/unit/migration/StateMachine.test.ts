/**
 * Unit tests for StateMachine
 * Covers CORE-MIG-EVENTS-021 (valid/invalid transitions)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { StateMachine } from '../../../src/migration/state/StateMachine';
import { MigrationStateEnum } from '../../../src/migration/types';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine();
  });

  // CORE-MIG-EVENTS-021/happy — valid state transition paths
  describe('canTransition() — valid transitions', () => {
    it('PENDING → VALIDATING is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.PENDING, MigrationStateEnum.VALIDATING)).toBe(true);
    });

    it('PENDING → FAILED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.PENDING, MigrationStateEnum.FAILED)).toBe(true);
    });

    it('VALIDATING → CHECKPOINTED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.VALIDATING, MigrationStateEnum.CHECKPOINTED)).toBe(true);
    });

    it('VALIDATING → FAILED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.VALIDATING, MigrationStateEnum.FAILED)).toBe(true);
    });

    it('CHECKPOINTED → IN_PROGRESS is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.CHECKPOINTED, MigrationStateEnum.IN_PROGRESS)).toBe(true);
    });

    it('CHECKPOINTED → FAILED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.CHECKPOINTED, MigrationStateEnum.FAILED)).toBe(true);
    });

    it('IN_PROGRESS → ANCHORING is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.IN_PROGRESS, MigrationStateEnum.ANCHORING)).toBe(true);
    });

    it('IN_PROGRESS → COMPLETED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.IN_PROGRESS, MigrationStateEnum.COMPLETED)).toBe(true);
    });

    it('IN_PROGRESS → FAILED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.IN_PROGRESS, MigrationStateEnum.FAILED)).toBe(true);
    });

    it('ANCHORING → COMPLETED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.ANCHORING, MigrationStateEnum.COMPLETED)).toBe(true);
    });

    it('ANCHORING → FAILED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.ANCHORING, MigrationStateEnum.FAILED)).toBe(true);
    });

    it('FAILED → ROLLED_BACK is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.FAILED, MigrationStateEnum.ROLLED_BACK)).toBe(true);
    });

    it('FAILED → QUARANTINED is valid', () => {
      expect(sm.canTransition(MigrationStateEnum.FAILED, MigrationStateEnum.QUARANTINED)).toBe(true);
    });

    it('full happy-path sequence: PENDING → VALIDATING → CHECKPOINTED → IN_PROGRESS → COMPLETED', () => {
      const path = [
        [MigrationStateEnum.PENDING, MigrationStateEnum.VALIDATING],
        [MigrationStateEnum.VALIDATING, MigrationStateEnum.CHECKPOINTED],
        [MigrationStateEnum.CHECKPOINTED, MigrationStateEnum.IN_PROGRESS],
        [MigrationStateEnum.IN_PROGRESS, MigrationStateEnum.COMPLETED],
      ] as [MigrationStateEnum, MigrationStateEnum][];

      for (const [from, to] of path) {
        expect(sm.canTransition(from, to)).toBe(true);
      }
    });

    it('btco path: IN_PROGRESS → ANCHORING → COMPLETED', () => {
      expect(sm.canTransition(MigrationStateEnum.IN_PROGRESS, MigrationStateEnum.ANCHORING)).toBe(true);
      expect(sm.canTransition(MigrationStateEnum.ANCHORING, MigrationStateEnum.COMPLETED)).toBe(true);
    });
  });

  // CORE-MIG-EVENTS-021/error — invalid transitions are rejected
  describe('canTransition() — invalid transitions', () => {
    it('PENDING → COMPLETED is invalid (skips steps)', () => {
      expect(sm.canTransition(MigrationStateEnum.PENDING, MigrationStateEnum.COMPLETED)).toBe(false);
    });

    it('PENDING → IN_PROGRESS is invalid', () => {
      expect(sm.canTransition(MigrationStateEnum.PENDING, MigrationStateEnum.IN_PROGRESS)).toBe(false);
    });

    it('COMPLETED → FAILED is invalid (terminal state)', () => {
      expect(sm.canTransition(MigrationStateEnum.COMPLETED, MigrationStateEnum.FAILED)).toBe(false);
    });

    it('COMPLETED → PENDING is invalid (no backward transitions)', () => {
      expect(sm.canTransition(MigrationStateEnum.COMPLETED, MigrationStateEnum.PENDING)).toBe(false);
    });

    it('ROLLED_BACK → PENDING is invalid (terminal state)', () => {
      expect(sm.canTransition(MigrationStateEnum.ROLLED_BACK, MigrationStateEnum.PENDING)).toBe(false);
    });

    it('QUARANTINED → FAILED is invalid (terminal state)', () => {
      expect(sm.canTransition(MigrationStateEnum.QUARANTINED, MigrationStateEnum.FAILED)).toBe(false);
    });

    it('VALIDATING → PENDING is invalid (no backward transitions)', () => {
      expect(sm.canTransition(MigrationStateEnum.VALIDATING, MigrationStateEnum.PENDING)).toBe(false);
    });

    it('ANCHORING → IN_PROGRESS is invalid (no backward transitions)', () => {
      expect(sm.canTransition(MigrationStateEnum.ANCHORING, MigrationStateEnum.IN_PROGRESS)).toBe(false);
    });

    it('VALIDATING → COMPLETED is invalid (skips steps)', () => {
      expect(sm.canTransition(MigrationStateEnum.VALIDATING, MigrationStateEnum.COMPLETED)).toBe(false);
    });

    it('returns false for an unrecognized fromState', () => {
      // Cast an unknown string as MigrationStateEnum to simulate unknown state
      expect(sm.canTransition('unknown_state' as MigrationStateEnum, MigrationStateEnum.COMPLETED)).toBe(false);
    });
  });

  describe('getValidTransitions()', () => {
    it('returns all valid transitions from PENDING', () => {
      const transitions = sm.getValidTransitions(MigrationStateEnum.PENDING);
      expect(transitions).toContain(MigrationStateEnum.VALIDATING);
      expect(transitions).toContain(MigrationStateEnum.FAILED);
      expect(transitions).toHaveLength(2);
    });

    it('returns empty array for terminal state COMPLETED', () => {
      expect(sm.getValidTransitions(MigrationStateEnum.COMPLETED)).toHaveLength(0);
    });

    it('returns empty array for terminal state ROLLED_BACK', () => {
      expect(sm.getValidTransitions(MigrationStateEnum.ROLLED_BACK)).toHaveLength(0);
    });

    it('returns empty array for terminal state QUARANTINED', () => {
      expect(sm.getValidTransitions(MigrationStateEnum.QUARANTINED)).toHaveLength(0);
    });

    it('returns a copy — mutations do not affect the machine', () => {
      const transitions = sm.getValidTransitions(MigrationStateEnum.PENDING);
      transitions.push('injected' as MigrationStateEnum);
      // After mutation, the machine should still return the original transitions
      const transitionsAgain = sm.getValidTransitions(MigrationStateEnum.PENDING);
      expect(transitionsAgain).not.toContain('injected');
    });
  });

  describe('isTerminalState()', () => {
    it('COMPLETED is terminal', () => {
      expect(sm.isTerminalState(MigrationStateEnum.COMPLETED)).toBe(true);
    });

    it('ROLLED_BACK is terminal', () => {
      expect(sm.isTerminalState(MigrationStateEnum.ROLLED_BACK)).toBe(true);
    });

    it('QUARANTINED is terminal', () => {
      expect(sm.isTerminalState(MigrationStateEnum.QUARANTINED)).toBe(true);
    });

    it('PENDING is not terminal', () => {
      expect(sm.isTerminalState(MigrationStateEnum.PENDING)).toBe(false);
    });

    it('IN_PROGRESS is not terminal', () => {
      expect(sm.isTerminalState(MigrationStateEnum.IN_PROGRESS)).toBe(false);
    });

    it('FAILED is not terminal (can transition to ROLLED_BACK or QUARANTINED)', () => {
      expect(sm.isTerminalState(MigrationStateEnum.FAILED)).toBe(false);
    });
  });
});
