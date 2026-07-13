/**
 * did:cel — genesis identity derived from the CEL create event.
 *
 * did:cel:<digestMultibase(canonicalizeEntryForChain(genesisEvent))>
 *
 * Reuses the exact chain-link digest (proof excluded, {type,data} preimage
 * for a first event), so a log's second event's `previousEvent` equals the
 * DID suffix by construction. The genesis event must NOT embed the asset
 * DID (it is derived from the event); the holder's key lives in
 * `data.controller` instead.
 */
import type { EventLog, LogEntry, VerifyOptions } from './types.js';
import type { DIDDocument } from '../types/index.js';
import { computeDigestMultibase, digestMultibaseEquals } from './hash.js';
import { canonicalizeEntryForChain } from './canonicalize.js';
import { currentControllerVm } from './signerAdapter.js';

export const DID_CEL_PREFIX = 'did:cel:';

export function deriveDidCelFromGenesis(genesis: LogEntry): string {
  if (genesis.type !== 'create') {
    throw new Error('did:cel derives from a create event; got ' + String(genesis.type));
  }
  return DID_CEL_PREFIX + computeDigestMultibase(canonicalizeEntryForChain(genesis));
}

export function deriveDidCel(log: EventLog): string {
  if (!log.events || log.events.length === 0) {
    throw new Error('Cannot derive did:cel from an empty event log');
  }
  return deriveDidCelFromGenesis(log.events[0]);
}

export function isDidCel(did: string): boolean {
  return typeof did === 'string' && did.startsWith(DID_CEL_PREFIX);
}

/** Suffix comparison via digestMultibaseEquals (tolerates legacy bare digests). */
export function didCelMatchesLog(did: string, log: EventLog): boolean {
  if (!isDidCel(did) || !log.events || log.events.length === 0) return false;
  if (log.events[0].type !== 'create') return false; // create-check as guard, not a throw
  const expected = deriveDidCelFromGenesis(log.events[0]).slice(DID_CEL_PREFIX.length);
  return digestMultibaseEquals(did.slice(DID_CEL_PREFIX.length), expected);
}

/**
 * Build a minimal did:cel DID Document facade for a genesis controller key.
 * Single Multikey VM (#key-0) bound to authentication + assertionMethod;
 * `alsoKnownAs` records the did:key form of the same key for resolvers that
 * only know did:key. Consumed by asset creation (Phase-2 Task 3).
 */
/**
 * Resolves a did:cel from its event log: verifies the WHOLE chain against the
 * DID (`expectedDid` binds the log to it) and, on success, folds the CURRENT
 * controller (genesis `controller`, handed off by valid rotateKey events) into
 * a DID document. Returns null — never a fabricated document — when the log
 * does not verify, does not back `did`, or the current controller is not a
 * did:key (its key material would not be derivable offline).
 *
 * By default the verify options are minimal (no resolveKey/ordinalsProvider):
 * that suffices for genesis-layer logs whose proofs are did:key-based, while
 * logs carrying bitcoin witness proofs fail closed. Pass `opts` to thread a
 * key resolver (proofs whose key lives in a remote DID document) and/or an
 * ordinals provider (btco-anchored logs) so those verify too.
 */
export async function resolveDidCel(
  did: string,
  log: EventLog,
  opts?: Pick<VerifyOptions, 'resolveKey' | 'ordinalsProvider'>
): Promise<DIDDocument | null> {
  if (!isDidCel(did)) return null;
  // Lazy import: verifyEventLog statically imports this module (derivation
  // helpers), so a static reverse edge would create an import cycle.
  const { verifyEventLog } = await import('./algorithms/verifyEventLog.js');
  const result = await verifyEventLog(log, {
    expectedDid: did,
    resolveKey: opts?.resolveKey,
    ordinalsProvider: opts?.ordinalsProvider
  });
  if (!result.verified) return null;
  try {
    const controller = currentControllerVm(log).split('#')[0];
    if (!controller.startsWith('did:key:')) return null;
    return createCelDidDocument(did, controller.slice('did:key:'.length));
  } catch {
    return null;
  }
}

export function createCelDidDocument(didCel: string, controllerPublicKeyMultibase: string): DIDDocument {
  const vmId = `${didCel}#key-0`;
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: didCel,
    verificationMethod: [
      {
        id: vmId,
        type: 'Multikey',
        controller: didCel,
        publicKeyMultibase: controllerPublicKeyMultibase,
      },
    ],
    authentication: [vmId],
    assertionMethod: [vmId],
    alsoKnownAs: [`did:key:${controllerPublicKeyMultibase}`],
  };
}
