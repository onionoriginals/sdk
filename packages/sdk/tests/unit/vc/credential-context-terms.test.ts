import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import originalsContext from '../../../src/contexts/originals.json';
import type { OriginalsConfig } from '../../../src/types';

/**
 * #371 (narrowed): the ONLY credential the live lifecycle emits is the
 * `ResourceMigrated` credential from `LifecycleManager.issuePublicationCredential`
 * (attached to `asset.credentials` during publishToWeb). Its subject
 * ({ id, migratedTo, resourceId, fromLayer, toLayer, migratedAt }) must be fully
 * defined by the Originals context the credential declares — otherwise `@vocab`
 * absorbs the undefined terms into a different namespace (`…/vocab#X`) than the
 * defined ones. Verification is CEL-based (verifyEventLog never reads credentials),
 * so this is about the emitted credential being well-formed JSON-LD, and a guard
 * so a new ResourceMigrated subject field can't ship without a context entry.
 *
 * The other CredentialManager factory methods (MigrationCompleted /
 * OwnershipTransferred / ResourceCreated / ResourceUpdated) and the
 * KeyRecoveryCredential have NO internal callers — deliberately not gold-plated
 * here; whether they stay at all is the VC-vs-CEL question in #370/#405.
 */
const config = { network: 'regtest', defaultKeyType: 'Ed25519' } as unknown as OriginalsConfig;
const cm = new CredentialManager(config);

// Mirror the subject issuePublicationCredential builds (LifecycleManager).
const resourceMigrated = cm.createResourceCredential(
  'ResourceMigrated',
  { id: 'did:cel:x', migratedTo: 'did:webvh:x', resourceId: 'res-1', fromLayer: 'did:cel', toLayer: 'did:webvh', migratedAt: '2026-01-01T00:00:00Z' } as never,
  'did:key:zIssuer'
);

const contextTerms = new Set(Object.keys((originalsContext as { '@context': Record<string, unknown> })['@context']));

describe('#371 — the live ResourceMigrated credential is well-formed in the Originals context', () => {
  test('declares the originals context', () => {
    expect((resourceMigrated as { '@context': string[] })['@context']).toContain('https://originals.build/context');
  });

  test('type + every subject key is explicitly defined in the context', () => {
    expect(contextTerms.has(resourceMigrated.type[resourceMigrated.type.length - 1])).toBe(true);
    for (const key of Object.keys(resourceMigrated.credentialSubject as Record<string, unknown>)) {
      expect({ term: key, defined: contextTerms.has(key) }).toEqual({ term: key, defined: true });
    }
  });
});
