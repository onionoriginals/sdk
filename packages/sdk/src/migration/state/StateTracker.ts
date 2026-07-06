/**
 * StateTracker - Tracks migration state throughout the migration lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MigrationOptions,
  MigrationState,
  MigrationStateEnum,
  IStateTracker
} from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { StateMachine } from './StateMachine.js';

export class StateTracker implements IStateTracker {
  private states: Map<string, MigrationState>;
  private stateMachine: StateMachine;

  constructor(private config: OriginalsConfig) {
    this.states = new Map();
    this.stateMachine = new StateMachine();
  }

  /**
   * Create a new migration state
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async createMigration(options: MigrationOptions): Promise<MigrationState> {
    const migrationId = `mig_${uuidv4()}`;
    const sourceLayer = this.extractLayer(options.sourceDid);

    if (!sourceLayer) {
      throw new Error(`Invalid source DID format: ${options.sourceDid}`);
    }

    const state: MigrationState = {
      migrationId,
      state: MigrationStateEnum.PENDING,
      sourceDid: options.sourceDid,
      sourceLayer,
      targetLayer: options.targetLayer,
      progress: 0,
      currentOperation: 'Initializing migration',
      startTime: Date.now()
    };

    this.states.set(migrationId, state);
    return state;
  }

  /**
   * Update migration state
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateState(migrationId: string, updates: Partial<MigrationState>): Promise<void> {
    const currentState = this.states.get(migrationId);
    if (!currentState) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    // Validate state transition if state is being updated
    if (updates.state && updates.state !== currentState.state) {
      if (!this.stateMachine.canTransition(currentState.state, updates.state)) {
        throw new Error(
          `Invalid state transition from ${currentState.state} to ${updates.state}`
        );
      }
    }

    // Update the state
    const updatedState = {
      ...currentState,
      ...updates
    };

    // Set end time if migration is completed, failed, or rolled back
    if (
      updatedState.state === MigrationStateEnum.COMPLETED ||
      updatedState.state === MigrationStateEnum.FAILED ||
      updatedState.state === MigrationStateEnum.ROLLED_BACK ||
      updatedState.state === MigrationStateEnum.PARTIALLY_ROLLED_BACK ||
      updatedState.state === MigrationStateEnum.QUARANTINED
    ) {
      updatedState.endTime = Date.now();
    }

    this.states.set(migrationId, updatedState);
  }

  /**
   * Whether a transition from `fromState` to `toState` is permitted by the
   * state machine. Callers use this to avoid attempting (and having to catch)
   * an invalid transition — e.g. a manual rollback of a terminal COMPLETED
   * migration, which is intentionally not reflected in the tracked state.
   */
  canTransitionTo(fromState: MigrationStateEnum, toState: MigrationStateEnum): boolean {
    if (fromState === toState) return true;
    return this.stateMachine.canTransition(fromState, toState);
  }

  /**
   * Get migration state
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getState(migrationId: string): Promise<MigrationState | null> {
    return this.states.get(migrationId) || null;
  }

  /**
   * Query migration states by filters
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async queryStates(filters: Partial<MigrationState>): Promise<MigrationState[]> {
    const results: MigrationState[] = [];

    for (const state of this.states.values()) {
      let matches = true;

      for (const [key, value] of Object.entries(filters)) {
        if (state[key as keyof MigrationState] !== value) {
          matches = false;
          break;
        }
      }

      if (matches) {
        results.push(state);
      }
    }

    return results;
  }

  /**
   * Get all active (non-terminal) migrations. Includes every state in which a
   * migration is still doing work or holding resources — not just IN_PROGRESS.
   * Notably ANCHORING (a Bitcoin broadcast may be outstanding), so a caller
   * gating shutdown on this does not act while an anchoring tx is in flight.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getActiveMigrations(): Promise<MigrationState[]> {
    const activeStates = new Set<MigrationStateEnum>([
      MigrationStateEnum.PENDING,
      MigrationStateEnum.VALIDATING,
      MigrationStateEnum.CHECKPOINTED,
      MigrationStateEnum.IN_PROGRESS,
      MigrationStateEnum.ANCHORING
    ]);
    return Array.from(this.states.values()).filter((s) => activeStates.has(s.state));
  }

  /**
   * Clean up old terminal migrations.
   *
   * Successfully-terminal entries (COMPLETED / ROLLED_BACK /
   * PARTIALLY_ROLLED_BACK) are reclaimed after `olderThanMs` (default 7
   * days). Failure-terminal entries (FAILED / QUARANTINED) are ALSO
   * reclaimed — previously they were excluded entirely and accumulated
   * unboundedly — but with a separate, longer retention
   * (`failedOlderThanMs`, default 30 days) since they may still be under
   * manual review.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async cleanupOldStates(
    olderThanMs: number = 7 * 24 * 60 * 60 * 1000,
    failedOlderThanMs: number = 30 * 24 * 60 * 60 * 1000
  ): Promise<void> {
    const now = Date.now();
    const cutoffTime = now - olderThanMs;
    const failedCutoffTime = now - failedOlderThanMs;
    const toDelete: string[] = [];

    for (const [id, state] of this.states.entries()) {
      if (!state.endTime) continue;
      const isSuccessTerminal =
        state.state === MigrationStateEnum.COMPLETED ||
        state.state === MigrationStateEnum.ROLLED_BACK ||
        state.state === MigrationStateEnum.PARTIALLY_ROLLED_BACK;
      const isFailureTerminal =
        state.state === MigrationStateEnum.FAILED ||
        state.state === MigrationStateEnum.QUARANTINED;

      if (
        (isSuccessTerminal && state.endTime < cutoffTime) ||
        (isFailureTerminal && state.endTime < failedCutoffTime)
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.states.delete(id);
    }
  }

  private extractLayer(did: string): 'peer' | 'webvh' | 'btco' | null {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    return null;
  }
}
