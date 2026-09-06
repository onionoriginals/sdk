import { parseAssetDid, type BitcoinNetwork, type SatSnapshot } from '@originals/cel/v3';
import { StructuredError } from '@originals/cel';
import { hexToBytes } from '@originals/cel/encoding';

/** Transport seam for ord's complete /sat, /inscription and raw /r/metadata views. */
export interface SatSnapshotReader {
  rpc(method: string, params: unknown[]): Promise<unknown>;
  status(): Promise<unknown>;
  indexHash(height: number): Promise<unknown>;
  sat(satoshi: string): Promise<unknown>;
  inscription(id: string): Promise<unknown>;
  content(id: string): Promise<Uint8Array | null>;
  metadata(id: string): Promise<unknown>;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const chains: Record<string, BitcoinNetwork> = { main: 'mainnet', mainnet: 'mainnet', test: 'testnet', testnet: 'testnet', testnet3: 'testnet', testnet4: 'testnet', signet: 'signet', regtest: 'regtest' };
const networkOf = (value: unknown): BitcoinNetwork | undefined => typeof value === 'string' && Object.prototype.hasOwnProperty.call(chains, value) ? chains[value] : undefined;

/** No decoded metadata, delegated bytes, incomplete bodies or moving index can attest a CEL 3 head. */
export async function readSatSnapshot(reader: SatSnapshotReader, satoshi: string, expectedNetwork?: BitcoinNetwork): Promise<SatSnapshot> {
  parseAssetDid('did:btco:' + satoshi);
  const readTip = async () => {
    const info = object(await reader.rpc('getblockchaininfo', []));
    const network = networkOf(info.chain);
    if (!network || (expectedNetwork && network !== expectedNetwork)) throw new Error('Snapshot Bitcoin network mismatch');
    if (!integer(info.blocks) || !hash(info.bestblockhash)) throw new Error('Core chain tip unavailable');
    return { network, height: info.blocks, hash: info.bestblockhash };
  };
  const before = await readTip();
  const readIndex = async () => {
    const status = object(await reader.status());
    if (networkOf(status.chain) !== before.network || !integer(status.height) || status.sat_index !== true ||
        status.address_index !== true || status.inscription_index !== true || status.unrecoverably_reorged !== false)
      throw new Error('Healthy ord sat and address indexes required');
    const indexedHash = await reader.indexHash(status.height);
    if (!hash(indexedHash)) throw new Error('ord index hash unavailable');
    if (status.height !== before.height || indexedHash !== before.hash) throw new StructuredError('SAT_SNAPSHOT_CHAIN_CHANGED', 'ord index is not at the stable Core tip');
    return { height: status.height, hash: indexedHash };
  };
  const indexTip = await readIndex();
  const sat = object(await reader.sat(satoshi));
  if (!integer(sat.number) || String(sat.number) !== satoshi || !Array.isArray(sat.inscriptions) || sat.inscriptions.length > 10000 ||
      !(sat.address === null || typeof sat.address === 'string') || !(sat.satpoint === null || typeof sat.satpoint === 'string'))
    throw new Error('Complete sat enumeration and ownership required');
  const blocks = new Map<number, SatSnapshot['blocks'][number]>();
  const publications: SatSnapshot['publications'] = [];
  const seen = new Set<string>();
  let contentBytes = 0;
  for (const id of sat.inscriptions) {
    if (typeof id !== 'string' || !/^([0-9a-f]{64})i(0|[1-9]\d*)$/.test(id) || seen.has(id)) throw new Error('Invalid or duplicate inscription id');
    seen.add(id);
    const [txid, index] = id.split('i');
    if (!integer(Number(index))) throw new Error('Invalid inscription index');
    const info = object(await reader.inscription(id));
    if (info.id !== id || !integer(info.sat) || String(info.sat) !== satoshi || !integer(info.height) || info.height > before.height)
      throw new Error('Listed inscription observation unavailable');
    if (!(info.content_type === null || typeof info.content_type === 'string') || !(info.content_length === null || integer(info.content_length)))
      throw new Error('Explicit inscription content type and length required');
    if (info.delegate != null || info.content_encoding != null) throw new Error('Delegated or encoded inscription body is unsupported');
    let block = blocks.get(info.height);
    if (!block) {
      const blockHash = await reader.rpc('getblockhash', [info.height]);
      if (!hash(blockHash)) throw new Error('Active block hash unavailable');
      const observed = object(await reader.rpc('getblock', [blockHash, 1]));
      if (observed.hash !== blockHash || observed.height !== info.height || !integer(observed.confirmations) || observed.confirmations < 1 ||
          !Array.isArray(observed.tx) || !observed.tx.length || !observed.tx.every(hash) || new Set(observed.tx).size !== observed.tx.length)
        throw new Error('Active block observation unavailable');
      block = { height: info.height, hash: blockHash, txids: observed.tx };
      blocks.set(info.height, block);
    }
    const transactionIndex = block.txids.indexOf(txid);
    if (transactionIndex < 0) throw new Error('Listed reveal is absent from its active block');
    const content = await reader.content(id);
    // Null explicitly reports a bodyless inscription. Never accept delegated/effective bytes as its own body.
    if ((content === null && info.content_length !== null) || (content?.length ?? 0) !== (info.content_length ?? 0))
      throw new Error('Listed inscription content is unavailable or has a different byte length');
    const metadataHex = await reader.metadata(id);
    if (metadataHex !== null && (typeof metadataHex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(metadataHex)))
      throw new Error('Raw metadata bytes unavailable');
    const metadata = metadataHex === null ? null : hexToBytes(metadataHex as string);
    contentBytes += (content?.length ?? 0) + (metadata?.length ?? 0);
    if (contentBytes > 32 * 1024 * 1024) throw new Error('Sat observation exceeds 32 MiB');
    publications.push({ id, revealTxid: txid, network: before.network, sat: satoshi, confirmed: true,
      creation: { height: info.height, blockHash: block.hash, transactionIndex, inscriptionIndex: Number(index) },
      body: { status: 'complete', mediaType: info.content_type ?? 'application/octet-stream', bytes: content ?? new Uint8Array(), metadata } });
  }
  await readIndex();
  const after = await readTip();
  if (after.network !== before.network || after.height !== before.height || after.hash !== before.hash) throw new StructuredError('SAT_SNAPSHOT_CHAIN_CHANGED', 'Core chain changed during sat observation');
  return { network: before.network, sat: satoshi, tipBefore: { height: before.height, hash: before.hash },
    tipAfter: { height: after.height, hash: after.hash }, indexTip, indexHealthy: true, enumerationComplete: true,
    blocks: [...blocks.values()], publications, ownership: { owner: sat.address, satpoint: sat.satpoint } };
}
