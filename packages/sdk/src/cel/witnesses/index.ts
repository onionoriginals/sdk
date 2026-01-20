/**
 * CEL Witness Services
 * 
 * Pluggable witness interfaces and implementations for third-party attestations.
 */

export type { WitnessService } from './WitnessService';
export { HttpWitness, HttpWitnessError } from './HttpWitness';
export type { HttpWitnessOptions } from './HttpWitness';
