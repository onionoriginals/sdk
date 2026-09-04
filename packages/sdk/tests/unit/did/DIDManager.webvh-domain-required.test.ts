/**
 * #531 — the SDK must never guess a did:webvh domain.
 *
 * #520 decided the *.originals.build networks are never stood up, and a
 * did:webvh domain is permanent once published. So omitting `domain` on a
 * did:webvh mint must fail loudly with WEBVH_DOMAIN_REQUIRED rather than
 * silently defaulting to a host nobody serves — no matter which webvhNetwork
 * tier is configured. An explicit domain still works.
 */

import { describe, test, expect } from 'bun:test';

import { DIDManager } from '../../../src/did/DIDManager';
import { StructuredError } from '@originals/cel';
import type { OriginalsConfig, WebVHNetworkName } from '../../../src/types';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

const sourceDoc = () => ({
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: 'did:cel:domain-required-531',
});

/** Assert the thrown value is the named domain-required StructuredError. */
async function expectDomainRequired(fn: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StructuredError);
  expect((thrown as StructuredError).code).toBe('WEBVH_DOMAIN_REQUIRED');
}

describe('#531 — createDIDWebVH refuses to guess a domain', () => {
  test('throws WEBVH_DOMAIN_REQUIRED when domain is omitted', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() => manager.createDIDWebVH({ paths: ['user', 'alice'] }));
  });

  test('throws WEBVH_DOMAIN_REQUIRED when domain is an empty/whitespace string', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() => manager.createDIDWebVH({ domain: '   ', paths: ['user', 'alice'] }));
  });

  // The configured webvhNetwork tier must NOT rescue an omitted domain: its
  // only surviving job is the bitcoin-network mapping (#521), never a default
  // did:webvh host.
  test.each<WebVHNetworkName>(['pichu', 'cleffa', 'magby'])(
    'webvhNetwork=%s does not supply a default domain',
    async (webvhNetwork) => {
      const manager = new DIDManager({ ...baseConfig, webvhNetwork });
      await expectDomainRequired(() => manager.createDIDWebVH({ paths: ['user', 'alice'] }));
    }
  );

  test('an explicit domain still mints a did:webvh', async () => {
    const manager = new DIDManager({ ...baseConfig, webvhNetwork: 'pichu' });
    const result = await manager.createDIDWebVH({ domain: 'example.com', paths: ['user', 'alice'] });
    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.did).toContain('example.com');
  }, 15000);
});

describe('#531 — migrateToDIDWebVH refuses to guess a domain', () => {
  test('throws WEBVH_DOMAIN_REQUIRED when domain is omitted', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() => manager.migrateToDIDWebVH(sourceDoc()));
  });

  test('throws WEBVH_DOMAIN_REQUIRED when domain is an empty/whitespace string', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() => manager.migrateToDIDWebVH(sourceDoc(), '  '));
  });

  test.each<WebVHNetworkName>(['pichu', 'cleffa', 'magby'])(
    'webvhNetwork=%s does not supply a default domain',
    async (webvhNetwork) => {
      const manager = new DIDManager({ ...baseConfig, webvhNetwork });
      await expectDomainRequired(() => manager.migrateToDIDWebVH(sourceDoc()));
    }
  );

  test('an explicit domain still migrates to did:webvh', async () => {
    const manager = new DIDManager({ ...baseConfig, webvhNetwork: 'pichu' });
    const webDoc = (await manager.migrateToDIDWebVH(sourceDoc(), 'custom.example.com')).didDocument;
    expect(webDoc.id).toMatch(/^did:webvh:/);
    expect(webDoc.id).toContain('custom.example.com');
    expect(webDoc.id).not.toContain('pichu.originals.build');
  }, 15000);
});
