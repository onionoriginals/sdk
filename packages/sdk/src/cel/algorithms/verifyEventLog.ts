/**
 * verifyEventLog Algorithm
 */

import type {
  EventLog,
  LogEntry,
  VerifyOptions,
  VerificationResult,
  EventVerification,
  DataIntegrityProof,
  RequiredEventOperation,
} from '../types';
import { computeDigestMultibase } from '../hash';

const REQUIRED_V11_CRYPTOSUITE = 'eddsa-jcs-2022';

function serializeEntry(entry: LogEntry): Uint8Array {
  const json = JSON.stringify(entry, Object.keys(entry).sort());
  return new TextEncoder().encode(json);
}

function getRequiredOperationForEvent(event: LogEntry): RequiredEventOperation | undefined {
  if (event.type === 'create') return 'ResourceAdded';
  if (event.type === 'update') return 'ResourceUpdated';
  return undefined;
}

function extractEventOperation(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const op = d.operation ?? d.op ?? d.eventType;
  return typeof op === 'string' ? op : undefined;
}

async function defaultVerifier(proof: DataIntegrityProof): Promise<boolean> {
  if (!proof.type || proof.type !== 'DataIntegrityProof') return false;
  if (!proof.cryptosuite) return false;
  if (!proof.proofValue || typeof proof.proofValue !== 'string' || proof.proofValue.length === 0) return false;
  if (!proof.verificationMethod || typeof proof.verificationMethod !== 'string') return false;
  if (!proof.proofPurpose || typeof proof.proofPurpose !== 'string') return false;

  const validCryptosuites = [REQUIRED_V11_CRYPTOSUITE, 'eddsa-rdfc-2022'];
  if (!validCryptosuites.includes(proof.cryptosuite)) return false;

  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) return false;

  return true;
}

function verifyChain(
  event: LogEntry,
  index: number,
  previousEvent: LogEntry | undefined
): { chainValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (index === 0) {
    if (event.previousEvent !== undefined) {
      errors.push(`Event ${index}: First event must not have previousEvent field`);
      return { chainValid: false, errors };
    }
  } else {
    if (event.previousEvent === undefined) {
      errors.push(`Event ${index}: Missing previousEvent reference`);
      return { chainValid: false, errors };
    }

    if (!previousEvent) {
      errors.push(`Event ${index}: Cannot verify chain - previous event not provided`);
      return { chainValid: false, errors };
    }

    const expectedHash = computeDigestMultibase(serializeEntry(previousEvent));

    if (event.previousEvent !== expectedHash) {
      errors.push(`Event ${index}: Hash chain broken - previousEvent does not match hash of prior event`);
      return { chainValid: false, errors };
    }
  }

  return { chainValid: true, errors: [] };
}

async function verifyEvent(
  event: LogEntry,
  index: number,
  verifier: (proof: DataIntegrityProof, data: unknown) => Promise<boolean>,
  previousEvent: LogEntry | undefined
): Promise<EventVerification> {
  const errors: string[] = [];

  const chainResult = verifyChain(event, index, previousEvent);
  const chainValid = chainResult.chainValid;
  errors.push(...chainResult.errors);

  if (!event.proof || !Array.isArray(event.proof) || event.proof.length === 0) {
    errors.push(`Event ${index}: No proofs found`);
    return { index, type: event.type, proofValid: false, chainValid, errors };
  }

  const requiredOperation = getRequiredOperationForEvent(event);
  const operation = requiredOperation ? extractEventOperation(event.data) : undefined;
  const hasExplicitRequiredOperation = Boolean(requiredOperation && operation === requiredOperation);

  if (requiredOperation && operation !== undefined && operation !== requiredOperation) {
    errors.push(`Event ${index}: Required operation mismatch (expected ${requiredOperation}, got ${operation})`);
  }

  let allProofsValid = true;
  const eventData = {
    type: event.type,
    data: event.data,
    ...(event.previousEvent ? { previousEvent: event.previousEvent } : {}),
  };

  for (let proofIndex = 0; proofIndex < event.proof.length; proofIndex++) {
    const proof = event.proof[proofIndex];

    if (hasExplicitRequiredOperation && proof.cryptosuite !== REQUIRED_V11_CRYPTOSUITE) {
      allProofsValid = false;
      errors.push(`Event ${index}, Proof ${proofIndex}: Required events must use ${REQUIRED_V11_CRYPTOSUITE}`);
      continue;
    }

    try {
      const isValid = await verifier(proof, eventData);
      if (!isValid) {
        allProofsValid = false;
        errors.push(`Event ${index}, Proof ${proofIndex}: Verification failed`);
      }
    } catch (error) {
      allProofsValid = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Event ${index}, Proof ${proofIndex}: ${message}`);
    }
  }

  const semanticValid = requiredOperation ? errors.every((e) => !e.includes(`Event ${index}: Required operation mismatch`)) : true;

  return {
    index,
    type: event.type,
    proofValid: allProofsValid && semanticValid,
    chainValid,
    errors,
  };
}

export async function verifyEventLog(
  log: EventLog,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const errors: string[] = [];
  const eventVerifications: EventVerification[] = [];

  const verifier = options?.verifier ?? defaultVerifier;

  if (!log || !log.events) {
    return { verified: false, errors: ['Invalid event log: missing events array'], events: [] };
  }
  if (!Array.isArray(log.events)) {
    return { verified: false, errors: ['Invalid event log: events is not an array'], events: [] };
  }
  if (log.events.length === 0) {
    return { verified: false, errors: ['Invalid event log: empty events array'], events: [] };
  }

  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const previousEvent = i > 0 ? log.events[i - 1] : undefined;
    const eventResult = await verifyEvent(event, i, verifier, previousEvent);
    eventVerifications.push(eventResult);

    if (!eventResult.proofValid || !eventResult.chainValid) {
      errors.push(...eventResult.errors);
    }
  }

  const allProofsValid = eventVerifications.every(ev => ev.proofValid);
  const allChainsValid = eventVerifications.every(ev => ev.chainValid);

  return {
    verified: allProofsValid && allChainsValid,
    errors,
    events: eventVerifications,
  };
}
