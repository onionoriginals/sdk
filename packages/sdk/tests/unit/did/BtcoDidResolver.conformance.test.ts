import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BtcoDidResolver } from '../../../src/did/BtcoDidResolver';

describe('BtcoDidResolver v1.1 conformance errors', () => {
  test('uses machine-readable resolver error contract', async () => {
    const fixturePath = join(import.meta.dir, '../../fixtures/resolver-errors-v1.1.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { errors: string[] };

    const resolver = new BtcoDidResolver();

    const invalidDid = await resolver.resolve('did:btc:123');
    const notFound = await resolver.resolve('did:btco:123');
    const repNotSupported = await resolver.resolve('did:btco:123/path', { accept: 'application/did+ld+json' });

    expect(fixture.errors).toContain(invalidDid.resolutionMetadata.error);
    expect(fixture.errors).toContain(notFound.resolutionMetadata.error);
    expect(fixture.errors).toContain(repNotSupported.resolutionMetadata.error);

    expect(invalidDid.resolutionMetadata.error).toBe('invalidDid');
    expect(notFound.resolutionMetadata.error).toBe('notFound');
    expect(repNotSupported.resolutionMetadata.error).toBe('representationNotSupported');
  });
});
