/**
 * CEL Algorithms
 * 
 * Core algorithms for working with Cryptographic Event Logs.
 */

export { createEventLog } from './createEventLog.js';
export { appendEvent } from './appendEvent.js';
export { updateEventLog } from './updateEventLog.js';
export { deactivateEventLog } from './deactivateEventLog.js';
export { verifyEventLog, verifyDidKeyEd25519Proof, selectNewestAnchorInscription, selfCertifyingKeyHexes } from './verifyEventLog.js';
export {
  classifyLogEntries,
  claimedSignerDid,
  beginCustodyFold,
  custodyFoldStep,
  finishCustodyFold,
  type ClassifiedEntry,
  type CustodyFoldState,
  type CustodyStepAction,
} from './classifyEntries.js';
export { witnessEvent } from './witnessEvent.js';
