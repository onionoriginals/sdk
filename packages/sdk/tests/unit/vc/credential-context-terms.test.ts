import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import originalsContext from '../../../src/contexts/originals.json';
import type { OriginalsConfig } from '../../../src/types';

/**
 * #371: every credential type the factory emits — and every key of its
 * credentialSubject — must be EXPLICITLY defined by the Originals context the
 * credentials declare (`https://originals.build/context` → contexts/originals.json).
 * `@vocab` would otherwise silently absorb any undefined term into a DIFFERENT
 * namespace (`…/vocab#X` instead of `…/X`), an inconsistency this guards against
 * so a new credential field can't ship without a context entry.
 */
const config = { network: 'regtest', defaultKeyType: 'Ed25519' } as unknown as OriginalsConfig;
const cm = new CredentialManager(config);

const ISSUER = 'did:key:z6MkExampleIssuerKeyForContextTermsTest0000';
const ASSET = 'did:cel:uExampleAssetForContextTermsTest0000';

// Build one of every credential the factories emit — all optional fields set so
// EVERY possible subject key is present.
const emitted = [
  cm.issueResourceCredential(
    { id: 'res-1', type: 'image', contentType: 'image/svg+xml', hash: 'deadbeef', createdAt: '2026-01-01T00:00:00Z' } as never,
    ASSET,
    ISSUER
  ),
  cm.issueResourceUpdateCredential('res-1', ASSET, 'oldhash', 'newhash', 1, 2, ISSUER, 'fix'),
  cm.issueMigrationCredential('did:cel:src', 'did:webvh:tgt', 'did:peer', 'did:webvh', ISSUER, {
    transactionId: 'tx', inscriptionId: 'ins', satoshi: '123', migrationReason: 'publish'
  }),
  cm.issueOwnershipCredential(ASSET, 'addr-a', 'addr-b', 'tx', ISSUER, { satoshi: '123', transferReason: 'sale' }),
  // KeyRecoveryCredential is emitted by WebVHManager; assert its fixed shape too.
  {
    type: ['VerifiableCredential', 'KeyRecoveryCredential'],
    credentialSubject: {
      id: ASSET,
      recoveredAt: '2026-01-01T00:00:00Z',
      recoveryReason: 'lost key',
      previousVerificationMethods: ['#key-0'],
      newVerificationMethod: '#key-1'
    }
  }
];

const contextTerms = new Set(Object.keys((originalsContext as { '@context': Record<string, unknown> })['@context']));

describe('#371 — every factory credential term is defined in the Originals context', () => {
  for (const cred of emitted) {
    const credType = cred.type[cred.type.length - 1];
    test(`${credType}: type + all subject keys are explicitly in the context`, () => {
      // The credential type (last, most-specific entry) must be defined.
      expect(contextTerms.has(credType)).toBe(true);
      // Every credentialSubject key must be defined (id → @id counts).
      for (const key of Object.keys(cred.credentialSubject as Record<string, unknown>)) {
        expect({ term: key, defined: contextTerms.has(key) }).toEqual({ term: key, defined: true });
      }
    });
  }
});
