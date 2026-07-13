import { ProvenanceChain } from './OriginalsAsset.js';
import { LayerType } from '../types/index.js';

export type Migration = ProvenanceChain['migrations'][number];

/**
 * Base query class for provenance inspection
 */
export class ProvenanceQuery {
  protected provenance: ProvenanceChain;
  protected afterDate?: Date;
  protected beforeDate?: Date;

  constructor(provenance: ProvenanceChain) {
    this.provenance = provenance;
  }

  /**
   * Query migrations
   */
  migrations(): MigrationQuery {
    return new MigrationQuery(this.provenance, this.afterDate, this.beforeDate);
  }

  /**
   * Filter by date range - after a specific date
   */
  after(date: Date | string): this {
    this.afterDate = typeof date === 'string' ? new Date(date) : date;
    return this;
  }

  /**
   * Filter by date range - before a specific date
   */
  before(date: Date | string): this {
    this.beforeDate = typeof date === 'string' ? new Date(date) : date;
    return this;
  }

  /**
   * Filter by date range - between two dates
   */
  between(start: Date | string, end: Date | string): this {
    this.afterDate = typeof start === 'string' ? new Date(start) : start;
    this.beforeDate = typeof end === 'string' ? new Date(end) : end;
    return this;
  }

  /**
   * Get count of results
   */
  count(): number {
    return this.all().length;
  }

  /**
   * Get first result
   */
  first(): Migration | null {
    const results = this.all();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Get last result
   */
  last(): Migration | null {
    const results = this.all();
    return results.length > 0 ? results[results.length - 1] : null;
  }

  /**
   * Get all results
   */
  all(): Migration[] {
    const filtered = this.applyDateFilters([...this.provenance.migrations]);
    return filtered.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /**
   * Apply date filters to items
   */
  protected applyDateFilters<T extends { timestamp: string }>(items: T[]): T[] {
    let filtered = items;

    if (this.afterDate) {
      filtered = filtered.filter(item => new Date(item.timestamp) > this.afterDate!);
    }

    if (this.beforeDate) {
      filtered = filtered.filter(item => new Date(item.timestamp) < this.beforeDate!);
    }

    return filtered;
  }
}

/**
 * Query class for migrations
 */
export class MigrationQuery extends ProvenanceQuery {
  private fromLayerFilter?: LayerType;
  private toLayerFilter?: LayerType;
  private transactionIdFilter?: string;
  private inscriptionIdFilter?: string;

  constructor(provenance: ProvenanceChain, afterDate?: Date, beforeDate?: Date) {
    super(provenance);
    this.afterDate = afterDate;
    this.beforeDate = beforeDate;
  }

  /**
   * Filter by source layer
   */
  fromLayer(layer: LayerType): this {
    this.fromLayerFilter = layer;
    return this;
  }

  /**
   * Filter by destination layer
   */
  toLayer(layer: LayerType): this {
    this.toLayerFilter = layer;
    return this;
  }

  /**
   * Filter by transaction ID
   */
  withTransaction(txId: string): this {
    this.transactionIdFilter = txId;
    return this;
  }

  /**
   * Filter by inscription ID
   */
  withInscription(inscriptionId: string): this {
    this.inscriptionIdFilter = inscriptionId;
    return this;
  }

  /**
   * Get all filtered migrations
   */
  all(): Migration[] {
    let results = [...this.provenance.migrations];

    // Apply date filters
    results = this.applyDateFilters(results);

    // Apply layer filters
    if (this.fromLayerFilter) {
      results = results.filter(m => m.from === this.fromLayerFilter);
    }

    if (this.toLayerFilter) {
      results = results.filter(m => m.to === this.toLayerFilter);
    }

    // Apply transaction ID filter
    if (this.transactionIdFilter) {
      results = results.filter(m => m.transactionId === this.transactionIdFilter);
    }

    // Apply inscription ID filter
    if (this.inscriptionIdFilter) {
      results = results.filter(m => m.inscriptionId === this.inscriptionIdFilter);
    }

    return results;
  }

  /**
   * Override migrations to return this (method chaining)
   */
  migrations(): MigrationQuery {
    return this;
  }
}
