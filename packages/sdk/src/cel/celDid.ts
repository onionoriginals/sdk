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
import type { EventLog, LogEntry } from './types.js';
import type { DIDDocument } from '../types/index.js';
import { computeDigestMultibase, digestMultibaseEquals } from './hash.js';
import { canonicalizeEntryForChain } from './canonicalize.js';

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
