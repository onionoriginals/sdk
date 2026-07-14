import { describe, test, expect, spyOn } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { DIDDocument, AssetResource } from '../../../src/types';

const resources: AssetResource[] = [
  { id: 'r1', type: 'data', contentType: 'application/json', hash: 'cafebabe' }
];

describe('DIDManager', () => {
  const sdk = OriginalsSDK.create();

  // createDIDPeer removed (did:peer purge, did:cel Phase 4·5/5): did:cel is the
  // sole genesis layer; the did:peer creation path and its unit tests are gone.

  test('migrateToDIDWebVH converts to did:webvh (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const migration = await sdk.did.migrateToDIDWebVH(didDoc, 'example.com');
    expect(migration.didDocument.id.startsWith('did:webvh:')).toBe(true);
    // The full result carries what a caller needs to host and update the DID
    expect(Array.isArray(migration.log)).toBe(true);
    expect(migration.keyPair.publicKey.length).toBeGreaterThan(0);
    expect(migration.previousDid).toBe('did:peer:xyz');
  });

  test('migrateToDIDWebVH creates a real SCID-first did:webvh, carrying VMs/services and the stable slug (issue #245)', async () => {
    const peer: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: 'did:peer:abc123',
      verificationMethod: [{ id: 'did:peer:abc123#0', type: 'Multikey', controller: 'did:peer:abc123', publicKeyMultibase: multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519') }],
      authentication: ['did:peer:abc123#0'],
      assertionMethod: ['did:peer:abc123#0'],
      service: [{ id: '#svc', type: 'Example', serviceEndpoint: 'https://api.example/svc' }]
    };
    const web = (await sdk.did.migrateToDIDWebVH(peer, 'Example.COM')).didDocument;
    // Spec format: did:webvh:{SCID}:{domain}:{slug} — a genuine SCID, not a renamed peer doc
    const parts = web.id.split(':');
    expect(parts.length).toBe(5);
    expect(parts.slice(0, 2).join(':')).toBe('did:webvh');
    expect(parts[2].length).toBeGreaterThan(10); // SCID
    expect(parts[3]).toBe('example.com');
    expect(parts[4]).toBe('abc123'); // stable slug from the peer suffix
    // The peer verification method is carried over (verification-only)
    const carried = (web.verificationMethod || []).map(vm => vm.publicKeyMultibase);
    expect(carried).toContain(peer.verificationMethod![0].publicKeyMultibase);
    // All VM ids/controllers are rooted at the new did:webvh. A relative
    // fragment id (e.g. the signing key's '#key-0', issue #334) resolves
    // against the document id per DID Core, so it is equally rooted.
    for (const vm of web.verificationMethod || []) {
      expect(vm.id!.startsWith(web.id) || vm.id!.startsWith('#')).toBe(true);
      expect(vm.controller).toBe(web.id);
    }
    // Services preserved, old DID recorded in alsoKnownAs
    expect(web.service?.[0].id).toBe('#svc');
    expect((web as any).alsoKnownAs).toContain('did:peer:abc123');
  });

  test('migrateToDIDWebVH returns the signed log and generated key pair', async () => {
    const peer: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz789' };
    const detailed = await sdk.did.migrateToDIDWebVH(peer, 'example.com');
    expect(detailed.previousDid).toBe('did:peer:xyz789');
    expect(detailed.did).toBe(detailed.didDocument.id);
    expect(Array.isArray(detailed.log)).toBe(true);
    expect(detailed.log.length).toBeGreaterThan(0);
    // The log entry is signed and carries the SCID parameter
    expect((detailed.log[0].parameters as any).scid).toBeDefined();
    expect(Array.isArray(detailed.log[0].proof)).toBe(true);
    expect(detailed.keyPair.publicKey.length).toBeGreaterThan(0);
    expect(detailed.keyPair.privateKey.length).toBeGreaterThan(0);
  });

  test('migrateToDIDWebVH roots verification methods and relationships at the new DID', async () => {
    const peer: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: 'did:peer:abc123',
      verificationMethod: [{ id: 'did:peer:abc123#0', type: 'Multikey', controller: 'did:peer:abc123', publicKeyMultibase: multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519') }],
      authentication: ['did:peer:abc123#0'],
      assertionMethod: ['did:peer:abc123#0']
    };
    const web = (await sdk.did.migrateToDIDWebVH(peer, 'example.com')).didDocument;
    // No reference to the retired did:peer remains outside alsoKnownAs.
    // Relative fragment ids ('#key-0') resolve against the document id per
    // DID Core, so they carry no did:peer reference either (issue #334).
    for (const vm of web.verificationMethod || []) {
      expect(vm.id!.startsWith(web.id) || vm.id!.startsWith('#')).toBe(true);
      expect(vm.controller).toBe(web.id);
    }
    const rels = ([] as unknown[]).concat(web.authentication || [], web.assertionMethod || []);
    for (const ref of rels) {
      if (typeof ref === 'string') {
        expect(ref === web.id || ref.startsWith('#') || ref.startsWith(web.id)).toBe(true);
      }
    }
  });

  test('migrateToDIDWebVH preserves keyAgreement / capability relationships (#299)', async () => {
    const kaKey = multikey.encodePublicKey(new Uint8Array(32).fill(9), 'Ed25519'); // keyAgreement (referenced by id)
    const ciKey = multikey.encodePublicKey(new Uint8Array(32).fill(11), 'Ed25519'); // capabilityInvocation (referenced)
    const embeddedKaKey = multikey.encodePublicKey(new Uint8Array(32).fill(13), 'Ed25519'); // keyAgreement embedded only
    const peer: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: 'did:peer:rel1',
      verificationMethod: [
        { id: 'did:peer:rel1#sign', type: 'Multikey', controller: 'did:peer:rel1', publicKeyMultibase: multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519') },
        { id: 'did:peer:rel1#ka', type: 'Multikey', controller: 'did:peer:rel1', publicKeyMultibase: kaKey },
        { id: 'did:peer:rel1#ci', type: 'Multikey', controller: 'did:peer:rel1', publicKeyMultibase: ciKey }
      ],
      authentication: ['did:peer:rel1#sign'],
      assertionMethod: ['did:peer:rel1#sign'],
      keyAgreement: [
        'did:peer:rel1#ka',
        // A key embedded directly in the relationship array (not in verificationMethod).
        { id: 'did:peer:rel1#ka2', type: 'Multikey', controller: 'did:peer:rel1', publicKeyMultibase: embeddedKaKey }
      ],
      capabilityInvocation: ['did:peer:rel1#ci']
    };

    const web = (await sdk.did.migrateToDIDWebVH(peer, 'example.com')).didDocument as any;

    // Helper: the migrated VM id for a given source public key.
    const idFor = (pub: string): string | undefined =>
      (web.verificationMethod || []).find((vm: any) => vm.publicKeyMultibase === pub)?.id;

    // Every carried key exists as a verification method in the migrated doc...
    for (const pub of [kaKey, ciKey, embeddedKaKey]) {
      expect(idFor(pub)).toBeDefined();
    }
    // ...and authorizes the relationship it held in the source document.
    expect(web.keyAgreement).toContain(idFor(kaKey));
    expect(web.keyAgreement).toContain(idFor(embeddedKaKey));
    expect(web.capabilityInvocation).toContain(idFor(ciKey));
    // authentication/assertionMethod remain the new signing key only.
    expect(web.authentication).toEqual(['#key-0']);
    expect(web.assertionMethod).toEqual(['#key-0']);
  });

  test('migrateToDIDWebVH percent-encodes a domain port so it stays one authority segment', async () => {
    const peer: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc123' };
    const web = (await sdk.did.migrateToDIDWebVH(peer, 'localhost:8080')).didDocument;
    // The port colon must be percent-encoded (%3A), otherwise splitting the DID
    // on ':' would parse `8080` as a path segment.
    const parts = web.id.split(':');
    // did / webvh / <scid> / <authority> / <slug> — exactly one authority segment.
    expect(parts.length).toBe(5);
    expect(decodeURIComponent(parts[3])).toBe('localhost:8080');
    // saveDIDLog decodes didParts[3] as the authority; the slug (not the port)
    // must be the only path segment.
    expect(parts.slice(4)).toEqual(['abc123']);
  });

  test('migrateToDIDBTCO converts to did:btco (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:xyz' };
    const btcoDoc = await sdk.did.migrateToDIDBTCO(didDoc, '123');
    expect(btcoDoc.id.startsWith('did:btco:')).toBe(true);
  });

  test('resolveDID returns null for an unresolvable did:peer instead of a stub', async () => {
    const doc = await sdk.did.resolveDID('did:peer:abc');
    expect(doc).toBeNull();
  });

  test('validateDIDDocument returns true for valid doc (expected to fail until implemented)', () => {
    const doc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    expect(sdk.did.validateDIDDocument(doc)).toBe(true);
  });
});

/** Inlined from DIDManager.createBtco.part.ts */
import { multikey } from '../../../src/crypto/Multikey';

describe('DIDManager.createBtcoDidDocument method', () => {
  test('creates btco DID document via manager wrapper', () => {
    const sdk = OriginalsSDK.create();
    const pub = new Uint8Array(32).fill(1);
    const doc = sdk.did.createBtcoDidDocument('123', 'mainnet', { publicKey: pub, keyType: 'Ed25519' });
    expect(doc.id).toBe('did:btco:123');
    const vm = doc.verificationMethod![0];
    expect(vm.id).toBe('did:btco:123#0');
    const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
    expect(decoded.type).toBe('Ed25519');
  });
});




import { DIDManager } from '../../../src/did/DIDManager';

// getLayerFromDID removed (did:peer purge, did:cel Phase 4·5/5): the private
// layer-from-DID helper is gone; layer is derived by OriginalsAsset.determineCurrentLayer.





/** Inlined from DIDManager.resolve.catch.part.ts */
import { BtcoDidResolver } from '../../../src/did/BtcoDidResolver';

describe('DIDManager.resolveDID catch path', () => {
  test('returns null when resolver throws', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://localhost:3000', network: 'mainnet' });
    const spy = spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockImplementationOnce(async () => { throw new Error('resolver failed'); });
    const res = await sdk.did.resolveDID('did:btco:123');
    expect(res).toBeNull();
    spy.mockRestore();
  });
});




/** Inlined from DIDManager.resolve.defaults.part.ts */

describe('DIDManager.resolveDID did:btco provider selection (issue #266)', () => {
  test('fails loudly with ORD_PROVIDER_REQUIRED instead of defaulting to localhost:3000', async () => {
    // Previously this silently constructed an OrdinalsClient against
    // http://localhost:3000 — resolving against whatever unrelated service
    // happened to listen there, or failing far from the cause with a null.
    const dm = new DIDManager({} as any);
    await expect(dm.resolveDID('did:btco:xyz')).rejects.toThrow(/ordinalsProvider/);
  });

  test('routes resolution through the configured ordinalsProvider (no HTTP)', async () => {
    const { OrdMockProvider } = await import('../../../src/adapters/providers/OrdMockProvider');
    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:123'
    };
    const provider = new OrdMockProvider({
      inscriptionsById: new Map([[
        'insc-1',
        {
          inscriptionId: 'insc-1',
          content: Buffer.from(JSON.stringify(didDoc), 'utf8'),
          contentType: 'application/json',
          txid: 'tx-1',
          vout: 0,
          satoshi: '123'
        }
      ]]),
      inscriptionsBySatoshi: new Map([['123', ['insc-1']]])
    });

    const dm = new DIDManager({
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      ordinalsProvider: provider
    } as any);

    const res = await dm.resolveDID('did:btco:123', { skipCache: true });
    expect(res?.id).toBe('did:btco:123');
  });

  test('ordinalsProvider takes precedence over bitcoinRpcUrl', async () => {
    const { OrdMockProvider } = await import('../../../src/adapters/providers/OrdMockProvider');
    const provider = new OrdMockProvider({
      inscriptionsById: new Map([[
        'insc-2',
        {
          inscriptionId: 'insc-2',
          content: Buffer.from(JSON.stringify({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:456' }), 'utf8'),
          contentType: 'application/json',
          txid: 'tx-2',
          vout: 0,
          satoshi: '456'
        }
      ]]),
      inscriptionsBySatoshi: new Map([['456', ['insc-2']]])
    });

    // If the OrdinalsClient path were taken, resolution would issue HTTP to
    // this unreachable URL and return null; the provider path needs no HTTP.
    const dm = new DIDManager({
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      bitcoinRpcUrl: 'http://unreachable.invalid:9999',
      ordinalsProvider: provider
    } as any);

    const res = await dm.resolveDID('did:btco:456', { skipCache: true });
    expect(res?.id).toBe('did:btco:456');
  });
});




/** Inlined from DIDManager.resolve.methods.part.ts */

describe('DIDManager.resolveDID covers btco method variants', () => {
  test('resolves did:btco:test:* via resolver', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://x', network: 'mainnet' });
    const spy = spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:test:1' } });
    const res = await sdk.did.resolveDID('did:btco:test:1');
    expect(res?.id).toBe('did:btco:test:1');
    spy.mockRestore();
  });

  test('resolves did:btco:sig:* via resolver', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://x', network: 'mainnet' });
    const spy = spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:sig:2' } });
    const res = await sdk.did.resolveDID('did:btco:sig:2');
    expect(res?.id).toBe('did:btco:sig:2');
    spy.mockRestore();
  });
});




/** Inlined from DIDManager.validate.false.part.ts */

describe('DIDManager.validateDIDDocument false branch', () => {
  test('returns false when context missing', () => {
    const dm = new DIDManager({} as any);
    const res = dm.validateDIDDocument({ id: 'did:peer:xyz' } as any);
    expect(res).toBe(false);
  });
});


import { createCelDidDocument } from '../../../src/cel/celDid';

describe('DIDManager.resolveDID did:cel branch (#Phase2 Task 8)', () => {
  test('returns null on a cache miss — no fake resolution', async () => {
    const dm = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false } as any);
    expect(await dm.resolveDID('did:cel:uEiUnknownDigest')).toBeNull();
  });

  test('returns a cached did:cel document (cache-only resolution)', async () => {
    const dm = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false } as any);
    const did = 'did:cel:uEiCachedDigest';
    const doc = createCelDidDocument(did, 'z6MkfakePublicKey');
    await dm.cache.set(did, doc);
    expect(await dm.resolveDID(did)).toEqual(doc);
  });

  test('warns naming resolveDidCel(did, log) when logging is enabled', async () => {
    const dm = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: true } as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await dm.resolveDID('did:cel:uEiUnknownDigest')).toBeNull();
      expect(warnSpy.mock.calls.some(args => args.join(' ').includes('resolveDidCel'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
