// Previous-format regression; CEL 3 public behavior is tested in CelV3DefaultJourney.
import { expect, test } from 'bun:test';
import { OriginalsSDK } from '../previous-sdk';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';

test('the SDK still resolves ordinary DID-document inscriptions', async () => {
  const document = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:123' };
  const provider = new OrdMockProvider({
    inscriptionsById: new Map([['plain', { inscriptionId: 'plain', content: new TextEncoder().encode(JSON.stringify(document)), contentType: 'application/json', txid: 'tx-plain', vout: 0, satoshi: '123' }]]),
    inscriptionsBySatoshi: new Map([['123', ['plain']]]),
  });
  const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider });
  expect(await sdk.did.resolveDID(document.id)).toEqual(document);
});

test('a malformed CEL claim cannot fall back to an ordinary document', async () => {
  const document = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:123' };
  const provider = new OrdMockProvider({
    inscriptionsById: new Map([['claim', { inscriptionId: 'claim', content: new TextEncoder().encode(JSON.stringify(document)), contentType: 'application/json', txid: 'tx-claim', vout: 0, satoshi: '123', metadata: { didDocument: document, celLog: null } }]]),
    inscriptionsBySatoshi: new Map([['123', ['claim']]]),
  });
  const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider });
  expect(await sdk.did.resolveDID(document.id)).toBeNull();
});

test('fresh SDK DID and asset readers agree on a verified byte inscription, and recheck the chain', async () => {
  const provider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({ network: 'regtest', keyStore: new MockKeyStore(), ordinalsProvider: provider });
  const content = new Uint8Array([137, 80, 78, 71, 255]);
  const asset = await sdk.lifecycle.createAsset([{ id: 'bytes', type: 'data', contentType: 'application/octet-stream', content, hash: hashResource(content) }]);
  await sdk.lifecycle.inscribeOnBitcoin(asset, 2);
  const did = asset.bindings!['did:btco'];
  const fresh = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider });
  const recovered = await fresh.lifecycle.resolveAssetFromSat(did.split(':').at(-1)!);
  expect(await fresh.did.resolveDID(did)).toEqual(recovered.asset.serialize().didDocuments['did:btco']);
  // A resolution path is local to one call: simultaneous readers must not
  // mistake each other for a recursive proof reference.
  const simultaneous = await Promise.all(Array.from({ length: 4 }, () => fresh.did.resolveDID(did)));
  for (const document of simultaneous) {
    expect(document).toEqual(recovered.asset.serialize().didDocuments['did:btco']);
  }
  const original = provider.getInscriptionById.bind(provider);
  provider.getInscriptionById = async id => {
    const record = await original(id);
    return record ? { ...record, content: new Uint8Array([0]) } : null;
  };
  expect(await fresh.did.resolveDID(did)).toBeNull();
});

for (const assetCount of [1, 2]) {
  test(`cyclic proof references across ${assetCount} btco DID(s) fail in bounded reads`, async () => {
    const provider = new OrdMockProvider();
    const writer = OriginalsSDK.create({ network: 'regtest', keyStore: new MockKeyStore(), ordinalsProvider: provider });
    const dids: string[] = [];
    for (let i = 0; i < assetCount; i++) {
      const content = new Uint8Array([i, 255]);
      const asset = await writer.lifecycle.createAsset([
        { id: `bytes-${i}`, type: 'data', contentType: 'application/octet-stream', content, hash: hashResource(content) },
      ]);
      await writer.lifecycle.inscribeOnBitcoin(asset, 2);
      dids.push(asset.bindings!['did:btco']);
    }

    const original = provider.getInscriptionById.bind(provider);
    let reads = 0;
    provider.getInscriptionById = async id => {
      // Bound this reproduction even if cycle handling regresses. Hitting the
      // bound is a test failure, not a simulated provider failure to accept.
      if (++reads > 100) throw new Error('cyclic resolution exceeded the test read bound');
      const record = await original(id);
      if (!record?.metadata) return record;
      const metadata = structuredClone(record.metadata);
      const index = dids.indexOf(metadata.didDocument.id);
      expect(index).toBeGreaterThanOrEqual(0);
      // Keep the real did:key controller and event digest. Proof key lookup
      // happens before signer authorization, so this exercises that boundary.
      metadata.celLog.events[0].proof[0].verificationMethod = `${dids[(index + 1) % dids.length]}#key-0`;
      return { ...record, metadata };
    };

    const fresh = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider });
    expect(await fresh.did.resolveDID(dids[0])).toBeNull();
    expect(reads).toBeLessThan(40);
    reads = 0;
    await expect(fresh.lifecycle.resolveAssetFromSat(dids[0].split(':').at(-1)!)).rejects.toThrow();
    expect(reads).toBeLessThan(60);
  });
}
