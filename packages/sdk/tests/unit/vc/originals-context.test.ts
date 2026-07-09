import { describe, test, expect } from 'bun:test';
import originalsContext from '../../../src/contexts/originals.json' with { type: 'json' };
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';

/**
 * Guards against #371: every credential type the SDK emits while declaring the
 * Originals JSON-LD context must actually be defined by that context. Before the
 * fix, `MigrationCompleted` and `OwnershipTransferred` were emitted with
 * `@context: [..., 'https://originals.build/context']` but were not defined in
 * it, so they only resolved via the `@vocab` fallback — into a different
 * namespace than the explicitly-defined `Resource*` types.
 */
describe('Originals JSON-LD context', () => {
  const terms = (originalsContext as { '@context': Record<string, unknown> })['@context'];

  test('defines every credential type the SDK emits with this context', () => {
    const emittedTypes = [
      'ResourceCreated',
      'ResourceUpdated',
      'ResourceMigrated',
      'MigrationCompleted',
      'OwnershipTransferred'
    ];
    for (const type of emittedTypes) {
      expect(terms[type]).toBeDefined();
    }
  });

  test('all Originals credential types share the Originals: namespace', () => {
    // Consistency: none of these should be left to the @vocab fallback.
    for (const type of ['ResourceCreated', 'ResourceMigrated', 'MigrationCompleted', 'OwnershipTransferred']) {
      expect(terms[type]).toBe(`Originals:${type}`);
    }
  });

  test('emitted MigrationCompleted / OwnershipTransferred credentials carry a defined type term', () => {
    const didManager = new DIDManager({} as any);
    const cm = new CredentialManager({ defaultKeyType: 'ES256K', network: 'regtest' } as any, didManager);

    const migration = cm.issueMigrationCredential(
      'did:peer:abc',
      'did:webvh:example.com:asset',
      'did:peer',
      'did:webvh',
      'did:webvh:example.com:publisher'
    );
    const ownership = cm.issueOwnershipCredential(
      'did:btco:12345',
      'bc1qold',
      'bc1qnew',
      'txid123',
      'did:btco:12345'
    );

    for (const cred of [migration, ownership]) {
      // The credential must declare the Originals context...
      expect(cred['@context']).toContain('https://originals.build/context');
      // ...and its non-base type must be a term that context defines.
      const specificType = (cred.type as string[]).find(t => t !== 'VerifiableCredential')!;
      expect(terms[specificType]).toBeDefined();
    }
  });
});
