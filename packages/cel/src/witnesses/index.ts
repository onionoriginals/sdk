/**
 * CEL Witness Services
 * 
 * Pluggable witness interfaces and implementations for third-party attestations.
 */

export type { WitnessService } from './WitnessService.js';
export { HttpWitness, HttpWitnessError } from './HttpWitness.js';
export type { HttpWitnessOptions } from './HttpWitness.js';
export { BitcoinWitness, BitcoinWitnessError } from './BitcoinWitness.js';
export type { BitcoinWitnessOptions, BitcoinWitnessProof } from './BitcoinWitness.js';
