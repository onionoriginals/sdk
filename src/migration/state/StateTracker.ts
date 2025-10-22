/**
 * StateTracker - Tracks migration state throughout the migration lifecycle
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MigrationOptions,
  MigrationState,
  MigrationStateEnum,
  IStateTracker
} from '../types';
import { OriginalsConfig } from '../../types';
import { StateMachine } from './StateMachine';

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
      updatedState.state === MigrationStateEnum.QUARANTINED
    ) {
      updatedState.endTime = Date.now();
    }

    this.states.set(migrationId, updatedState);
  }

  /**
   * Get migration state
   */
  async getState(migrationId: string): Promise<MigrationState | null> {
    return this.states.get(migrationId) || null;
  }

  /**
   * Query migration states by filters
   */
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
   * Get all active migrations
   */
  async getActiveMigrations(): Promise<MigrationState[]> {
    return this.queryStates({
      state: MigrationStateEnum.IN_PROGRESS
    });
  }

  /**
   * Clean up old completed migrations
   */
  async cleanupOldStates(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoffTime = Date.now() - olderThanMs;
    const toDelete: string[] = [];

    for (const [id, state] of this.states.entries()) {
      if (
        state.endTime &&
        state.endTime < cutoffTime &&
        (state.state === MigrationStateEnum.COMPLETED ||
          state.state === MigrationStateEnum.ROLLED_BACK)
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
