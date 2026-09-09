import { expect, test } from 'bun:test';
import { OriginalsSDK, type InscriptionRecoveryRecord } from '../../../src/index.js';
import { normalizeAssetId, canonicalizeValue } from '@originals/cel/v3';
import prepared from '../../fixtures/identity/sdk3-web-publication.json';

test('published SDK 3 signed hosted artifacts recover without changing identity, paths or signed bytes', async () => {
  const files = new Map<string, {content: Uint8Array; contentType?: string}>();
  const storageAdapter = {
    async putObject(domain: string, path: string, bytes: string | Uint8Array, options?: {contentType?: string}) {
      files.set(domain + '/' + path, {content: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice(), contentType: options?.contentType});
      return 'https://' + domain + '/' + path;
    },
    async getObject(domain: string, path: string) { return files.get(domain + '/' + path) ?? null; },
    async exists(domain: string, path: string) { return files.has(domain + '/' + path); },
  };
  const before = JSON.stringify(prepared);
  const published = await OriginalsSDK.create({storageAdapter}).lifecycle.publishPreparedToWeb(prepared);
  expect(published.did).toBe(prepared.did);
  const fresh = await OriginalsSDK.create({storageAdapter}).lifecycle.resolveAssetFromWeb(prepared.did);
  expect(fresh.verification.verified).toBe(true);
  expect(fresh.asset.id).toBe(normalizeAssetId(prepared.asset.assetDid));
  expect(fresh.asset.resources[0].content).toEqual(new Uint8Array([0,255,128,7]));
  expect(canonicalizeValue(fresh.asset.celLog)).toBe(canonicalizeValue(prepared.asset.eventLog));
  const methodFile = [...files].find(([key]) => key.endsWith('/did.jsonl'))!;
  const didLog = new TextDecoder().decode(methodFile[1].content).trim().split('\n').map(line => JSON.parse(line));
  expect(didLog).toEqual(prepared.didLog);
  expect(methodFile[0]).toContain(prepared.asset.assetDid.slice(8));
  expect(fresh.asset.serialize()).toMatchObject({version:4,assetId:fresh.asset.id});
  expect(JSON.stringify(prepared)).toBe(before);
});

test('published SDK 3 Bitcoin wrapper submits the original signed pair without custody', async () => {
  const { default: oldPair } = await import('../../fixtures/identity/sdk3-bitcoin-publication.json');
  const { Transaction } = await import('@scure/btc-signer');
  const sent: string[] = [];
  const records = new Map<string, InscriptionRecoveryRecord>();
  const provider = {
    async broadcastTransaction(hex: string) {
      expect(records.get(oldPair.transactions.commitTxId)?.prepared.signedCommitHex).toBe(oldPair.transactions.signedCommitHex);
      sent.push(hex);
      return Transaction.fromRaw(Buffer.from(hex, 'hex'), {allowUnknownInputs:true,allowUnknownOutputs:true}).id;
    },
    async getTransactionStatus() { return {confirmed:false}; },
  };
  const sdk = OriginalsSDK.create({network:'regtest',ordinalsProvider:provider as never});
  const before = JSON.stringify(oldPair);
  const result = await sdk.lifecycle.publishPreparedToBitcoin(oldPair as never, {recoveryStore:{
    async save(record) { records.set(record.recoveryId, structuredClone(record)); },
    async load(id) { return records.get(id); },
  }});
  expect(result.status).toBe('submitted');
  expect(sent).toEqual([oldPair.transactions.signedCommitHex, oldPair.transactions.revealTxHex]);
  expect(result.asset.id).toBe(normalizeAssetId(oldPair.asset.assetDid));
  expect(canonicalizeValue(result.asset.celLog)).toBe(canonicalizeValue(oldPair.asset.eventLog));
  expect(result.asset.resources[0].content).toEqual(new Uint8Array([0,255,128,7]));
  expect(JSON.stringify(oldPair)).toBe(before);
});
