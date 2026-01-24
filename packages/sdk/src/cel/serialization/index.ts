/**
 * CEL Serialization Module
 * 
 * Provides serialization formats for EventLog:
 * - JSON: Human-readable, standard format
 * - CBOR: Compact binary format for bandwidth-sensitive applications
 */

export * from './json';
export * from './cbor';
