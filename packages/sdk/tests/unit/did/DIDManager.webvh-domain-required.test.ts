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
    await expectDomainRequired(() =>
      // @ts-expect-error #531: `domain` is a required option — omitting it is a compile error and a runtime throw
      manager.createDIDWebVH({ paths: ['user', 'alice'] })
    );
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
      await expectDomainRequired(() =>
        // @ts-expect-error #531: `domain` is a required option — omitting it is a compile error and a runtime throw
        manager.createDIDWebVH({ paths: ['user', 'alice'] })
      );
    }
  );

  test('an explicit domain still mints a did:webvh', async () => {
    const manager = new DIDManager({ ...baseConfig, webvhNetwork: 'pichu' });
    const result = await manager.createDIDWebVH({ domain: 'example.com', paths: ['user', 'alice'] });
    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.did).toContain('example.com');
  }, 15000);

  // #764: a padded-but-nonblank domain must not mint a DID with embedded
  // whitespace — requireWebVHDomain now canonicalizes (trim/lowercase) via
  // canonicalizeWebVHDomain rather than only checking for blank input.
  test('a padded domain is trimmed rather than minting whitespace into the DID (#764)', async () => {
    const manager = new DIDManager({ ...baseConfig });
    const result = await manager.createDIDWebVH({ domain: '  example.com  ', paths: ['user', 'alice'] });
    expect(result.did).toContain(':example.com:');
    expect(result.did).not.toContain(' ');
  }, 15000);

  // #722: a mixed-case domain is a valid hostname and must be normalized,
  // not merely accepted verbatim (which would later fail deep in CEL history
  // verification instead of at this seam).
  test('a mixed-case domain is lowercased rather than passed through verbatim (#722)', async () => {
    const manager = new DIDManager({ ...baseConfig });
    const result = await manager.createDIDWebVH({ domain: 'Example.COM', paths: ['user', 'alice'] });
    expect(result.did).toContain(':example.com:');
    expect(result.did).not.toContain('Example.COM');
  }, 15000);

  test('a malformed nonblank domain fails at this seam with a domain-specific error', async () => {
    const manager = new DIDManager({ ...baseConfig });
    let thrown: unknown;
    try {
      await manager.createDIDWebVH({ domain: 'not a domain', paths: ['user', 'alice'] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    expect((thrown as StructuredError).code).toBe('INVALID_DOMAIN');
  });
});

describe('createDIDWebVH applies the CEL WebVH domain canonicalizer', () => {
  async function codeOf(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      return (err as StructuredError).code;
    }
    return undefined;
  }

  test('createDIDWebVH rejects an IP host with INVALID_DOMAIN, not an uncoded didwebvh-ts Error', async () => {
    const manager = new DIDManager({ ...baseConfig });
    expect(await codeOf(() => manager.createDIDWebVH({ domain: '127.0.0.1' }))).toBe('INVALID_DOMAIN');
  });

  test('createDIDWebVH drops the default :443 port', async () => {
    const manager = new DIDManager({ ...baseConfig });
    const result = await manager.createDIDWebVH({ domain: 'example.com:443' });
    expect(result.did).toMatch(/:example\.com$/);
  }, 15000);

  test('createDIDWebVH and migrateToDIDWebVH accept localhost[:port] for identity dev', async () => {
    const manager = new DIDManager({ ...baseConfig });
    expect((await manager.createDIDWebVH({ domain: 'localhost' })).did).toMatch(/:localhost$/);
    expect((await manager.createDIDWebVH({ domain: 'LOCALHOST:3000' })).did).toMatch(/:localhost%3A3000$/);
    const webDoc = (await manager.migrateToDIDWebVH(sourceDoc(), 'localhost:8080')).didDocument;
    expect(webDoc.id).toContain(':localhost%3A8080:');
  }, 15000);

  test('createDIDWebVH accepts a punycode host for an identity DID', async () => {
    const manager = new DIDManager({ ...baseConfig });
    expect((await manager.createDIDWebVH({ domain: 'XN--bcher-kva.example' })).did).toMatch(
      /:xn--bcher-kva\.example$/
    );
  }, 15000);

  test('createDIDWebVH names the failing path segment', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expect(
      manager.createDIDWebVH({ domain: 'example.com', paths: ['ok', ' bad'] })
    ).rejects.toThrow('paths[1]');
  });

  test.each(['intranet', 'web:3000'])(
    'createDIDWebVH rejects single-label host %j with INVALID_DOMAIN',
    async (domain) => {
      const manager = new DIDManager({ ...baseConfig });
      expect(await codeOf(() => manager.createDIDWebVH({ domain }))).toBe('INVALID_DOMAIN');
    },
  );
});

describe('#531 — migrateToDIDWebVH refuses to guess a domain', () => {
  test('throws WEBVH_DOMAIN_REQUIRED when domain is omitted', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() =>
      // @ts-expect-error #531: `domain` is a required argument — omitting it is a compile error and a runtime throw
      manager.migrateToDIDWebVH(sourceDoc())
    );
  });

  test('throws WEBVH_DOMAIN_REQUIRED when domain is an empty/whitespace string', async () => {
    const manager = new DIDManager({ ...baseConfig });
    await expectDomainRequired(() => manager.migrateToDIDWebVH(sourceDoc(), '  '));
  });

  test.each<WebVHNetworkName>(['pichu', 'cleffa', 'magby'])(
    'webvhNetwork=%s does not supply a default domain',
    async (webvhNetwork) => {
      const manager = new DIDManager({ ...baseConfig, webvhNetwork });
      await expectDomainRequired(() =>
        // @ts-expect-error #531: `domain` is a required argument — omitting it is a compile error and a runtime throw
        manager.migrateToDIDWebVH(sourceDoc())
      );
    }
  );

  test('an explicit domain still migrates to did:webvh', async () => {
    const manager = new DIDManager({ ...baseConfig, webvhNetwork: 'pichu' });
    const webDoc = (await manager.migrateToDIDWebVH(sourceDoc(), 'custom.example.com')).didDocument;
    expect(webDoc.id).toMatch(/^did:webvh:/);
    expect(webDoc.id).toContain('custom.example.com');
    expect(webDoc.id).not.toContain('pichu.originals.build');
  }, 15000);

  // #764/#722: migrateToDIDWebVH already trimmed/lowercased its own domain
  // (it is not affected by the underlying bug), but it now shares the exact
  // canonicalizeWebVHDomain primitive instead of a hand-rolled duplicate.
  test('a padded, mixed-case domain is canonicalized rather than embedding whitespace', async () => {
    const manager = new DIDManager({ ...baseConfig });
    const webDoc = (await manager.migrateToDIDWebVH(sourceDoc(), '  Custom.Example.COM  ')).didDocument;
    expect(webDoc.id).toContain(':custom.example.com:');
    expect(webDoc.id).not.toContain(' ');
    expect(webDoc.id).not.toContain('Custom.Example.COM');
  }, 15000);
});

describe('default CEL 3 SDK identity utilities require the caller host', () => {
  test('missing hosts fail through both inherited public methods', async () => {
    const { OriginalsSDK } = await import('../../../src/core/OriginalsSDK3');
    const sdk = OriginalsSDK.create();
    await expectDomainRequired(() =>
      // @ts-expect-error Missing domain is rejected by the public type and runtime.
      sdk.did.createDIDWebVH({ paths: ['identity'] })
    );
    await expectDomainRequired(() =>
      // @ts-expect-error Missing domain is rejected by the public type and runtime.
      sdk.did.migrateToDIDWebVH(sourceDoc())
    );
  });

  test('explicit host succeeds through the default SDK', async () => {
    const { OriginalsSDK } = await import('../../../src/core/OriginalsSDK3');
    const sdk = OriginalsSDK.create();
    const result = await sdk.did.createDIDWebVH({ domain: 'example.com', paths: ['identity'] });
    expect(result.did).toContain(':example.com:identity');
  });
});
