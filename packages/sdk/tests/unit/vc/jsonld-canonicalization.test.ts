import { describe, expect, test } from 'bun:test';
import { canonize } from '../../../src/vc/utils/jsonld';

describe('retained VC utility RDFC-1.0 canonical literals', () => {
  test.each([
    ['ordinary text', 'ordinary text'],
    ['has\ttab', 'has\\ttab'],
    ['has\u0001control', 'has\\u0001control'],
  ])('canonicalizes %j to the signed N-Quads bytes', async (value, escaped) => {
    const document = {
      '@context': { value: 'urn:predicate' },
      '@id': 'urn:subject',
      value,
    };
    const result = await canonize(document, {
      documentLoader: async () => {
        throw new Error('This inline-context fixture must not fetch remote documents');
      },
    });

    expect(result).toBe(`<urn:subject> <urn:predicate> "${escaped}" .\n`);
  });
});
