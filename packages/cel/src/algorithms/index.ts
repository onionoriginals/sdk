/**
 * CEL Algorithms
 * 
 * Core algorithms for working with Cryptographic Event Logs.
 */

export { createEventLog } from './createEventLog.js';
export { appendEvent } from './appendEvent.js';
export { updateEventLog } from './updateEventLog.js';
export { deactivateEventLog } from './deactivateEventLog.js';
export { verifyEventLog, verifyDidKeyEd25519Proof, selectNewestAnchorInscription } from './verifyEventLog.js';
export { witnessEvent } from './witnessEvent.js';
