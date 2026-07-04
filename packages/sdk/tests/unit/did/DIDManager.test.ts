import { describe, test, expect, spyOn } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { DIDDocument, AssetResource } from '../../../src/types';

const resources: AssetResource[] = [
  { id: 'r1', type: 'data', contentType: 'application/json', hash: 'cafebabe' }
];

describe('DIDManager', () => {
  const sdk = OriginalsSDK.create();

  test('createDIDPeer returns a valid DID document (expected to fail until implemented)', async () => {
    const didDoc = await sdk.did.createDIDPeer(resources);
    expect(didDoc.id.startsWith('did:peer:')).toBe(true);
    expect(didDoc['@context']).toBeDefined();
    // Includes Multikey verification method
    expect(Array.isArray(didDoc.verificationMethod)).toBe(true);
    const vm = didDoc.verificationMethod![0];
    expect(vm.type).toBe('Multikey');
    expect(vm.publicKeyMultibase[0]).toBe('z');
    const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
    expect(decoded && decoded.key instanceof Uint8Array).toBe(true);
    // Relationships reference by fragment
    expect(didDoc.authentication).toContain(vm.id);
    expect(didDoc.assertionMethod).toContain(vm.id);
  });

  test('migrateToDIDWebVH converts to did:webvh (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const webDoc = await sdk.did.migrateToDIDWebVH(didDoc, 'example.com');
    expect(webDoc.id.startsWith('did:webvh:')).toBe(true);
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
    const web = await sdk.did.migrateToDIDWebVH(peer, 'Example.COM');
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
    // All VM ids/controllers are rooted at the new did:webvh
    for (const vm of web.verificationMethod || []) {
      expect(vm.id!.startsWith(web.id)).toBe(true);
      expect(vm.controller).toBe(web.id);
    }
    // Services preserved, old DID recorded in alsoKnownAs
    expect(web.service?.[0].id).toBe('#svc');
    expect((web as any).alsoKnownAs).toContain('did:peer:abc123');
  });

  test('migrateToDIDWebVHDetailed returns the signed log and generated key pair', async () => {
    const peer: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz789' };
    const detailed = await sdk.did.migrateToDIDWebVHDetailed(peer, { domain: 'example.com' });
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
    const web = await sdk.did.migrateToDIDWebVH(peer, 'example.com');
    // No reference to the retired did:peer remains outside alsoKnownAs
    for (const vm of web.verificationMethod || []) {
      expect(vm.id!.startsWith(web.id)).toBe(true);
      expect(vm.controller).toBe(web.id);
    }
    const rels = ([] as unknown[]).concat(web.authentication || [], web.assertionMethod || []);
    for (const ref of rels) {
      if (typeof ref === 'string') {
        expect(ref === web.id || ref.startsWith('#') || ref.startsWith(web.id)).toBe(true);
      }
    }
  });

  test('migrateToDIDWebVH percent-encodes a domain port so it stays one authority segment', async () => {
    const peer: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc123' };
    const web = await sdk.did.migrateToDIDWebVH(peer, 'localhost:8080');
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

  test('resolveDID resolves a real did:peer document', async () => {
    const created = await sdk.did.createDIDPeer();
    const doc = await sdk.did.resolveDID(created.id);
    expect(doc).not.toBeNull();
    expect(doc?.id).toBe(created.id);
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




/** Inlined from DIDManager.getLayer.throw.part.ts */
import { DIDManager } from '../../../src/did/DIDManager';

describe('DIDManager.getLayerFromDID error branch', () => {
  test('throws Unsupported DID method', () => {
    const dm: any = new DIDManager({} as any);
    expect(() => dm["getLayerFromDID"]('did:example:xyz')).toThrow('Unsupported DID method');
  });
});




/** Inlined from DIDManager.private.part.ts */

describe('DIDManager private getLayerFromDID', () => {
  const sdk = OriginalsSDK.create();
  const dm: any = sdk.did as any;

  test('returns correct layer for each DID method (expected to pass)', () => {
    expect(dm["getLayerFromDID"]('did:peer:abc')).toBe('did:peer');
    expect(dm["getLayerFromDID"]('did:webvh:example.com:abc')).toBe('did:webvh');
    expect(dm["getLayerFromDID"]('did:btco:123')).toBe('did:btco');
  });

  test('throws on unsupported method (expected to pass)', () => {
    expect(() => dm["getLayerFromDID"]('did:web:example.com')).toThrow('Unsupported DID method');
  });
});





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

describe('DIDManager.resolveDID uses default rpcUrl and network fallbacks', () => {
  test('falls back to http://localhost:3000 and mainnet when config missing', async () => {
    const dm = new DIDManager({} as any);
    const spy = spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:xyz' } });
    const res = await dm.resolveDID('did:btco:xyz');
    expect(res?.id).toBe('did:btco:xyz');
    spy.mockRestore();
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
