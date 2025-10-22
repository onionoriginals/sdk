/**
 * StateMachine - Defines valid migration state transitions
 */

import { MigrationStateEnum } from '../types';

export class StateMachine {
  private transitions: Map<MigrationStateEnum, MigrationStateEnum[]>;

  constructor() {
    this.transitions = this.initializeTransitions();
  }

  /**
   * Initialize valid state transitions
   */
  private initializeTransitions(): Map<MigrationStateEnum, MigrationStateEnum[]> {
    const transitions = new Map<MigrationStateEnum, MigrationStateEnum[]>();

    // PENDING can transition to VALIDATING or FAILED
    transitions.set(MigrationStateEnum.PENDING, [
      MigrationStateEnum.VALIDATING,
      MigrationStateEnum.FAILED
    ]);

    // VALIDATING can transition to CHECKPOINTED or FAILED
    transitions.set(MigrationStateEnum.VALIDATING, [
      MigrationStateEnum.CHECKPOINTED,
      MigrationStateEnum.FAILED
    ]);

    // CHECKPOINTED can transition to IN_PROGRESS or FAILED
    transitions.set(MigrationStateEnum.CHECKPOINTED, [
      MigrationStateEnum.IN_PROGRESS,
      MigrationStateEnum.FAILED
    ]);

    // IN_PROGRESS can transition to ANCHORING (for btco), COMPLETED, or FAILED
    transitions.set(MigrationStateEnum.IN_PROGRESS, [
      MigrationStateEnum.ANCHORING,
      MigrationStateEnum.COMPLETED,
      MigrationStateEnum.FAILED
    ]);

    // ANCHORING can transition to COMPLETED or FAILED
    transitions.set(MigrationStateEnum.ANCHORING, [
      MigrationStateEnum.COMPLETED,
      MigrationStateEnum.FAILED
    ]);

    // FAILED can transition to ROLLED_BACK or QUARANTINED
    transitions.set(MigrationStateEnum.FAILED, [
      MigrationStateEnum.ROLLED_BACK,
      MigrationStateEnum.QUARANTINED
    ]);

    // COMPLETED, ROLLED_BACK, and QUARANTINED are terminal states
    transitions.set(MigrationStateEnum.COMPLETED, []);
    transitions.set(MigrationStateEnum.ROLLED_BACK, []);
    transitions.set(MigrationStateEnum.QUARANTINED, []);

    return transitions;
  }

  /**
   * Check if a state transition is valid
   */
  canTransition(fromState: MigrationStateEnum, toState: MigrationStateEnum): boolean {
    const validTransitions = this.transitions.get(fromState);
    if (!validTransitions) {
      return false;
    }
    return validTransitions.includes(toState);
  }

  /**
   * Get all valid transitions from a given state
   * Returns a copy to prevent external mutation of the transition table
   */
  getValidTransitions(fromState: MigrationStateEnum): MigrationStateEnum[] {
    const transitions = this.transitions.get(fromState);
    return transitions ? [...transitions] : [];
  }

  /**
   * Check if a state is terminal (no further transitions)
   */
  isTerminalState(state: MigrationStateEnum): boolean {
    const validTransitions = this.transitions.get(state);
    return !validTransitions || validTransitions.length === 0;
  }
}
