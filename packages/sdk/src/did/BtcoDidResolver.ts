/**
 * did:btco resolution per the did:btco method v0.2.0 (plan 011 PR 9c; owner
 * decision Q15, decision C).
 *
 * A version of `did:btco[:reg|:sig|:test]:<sat>` is a confirmed inscription on
 * the sat whose Ordinals metadata is the DID document in strict CBOR, with
 * the DID as its `id`; versions follow chain order, and a `deactivated: true`
 * document is terminal. The resolver reads the sat as one complete snapshot
 * (the SDK's sat reader: raw metadata bytes, bounded, checked against Bitcoin
 * Core) and applies the same version rules as the Originals verifier
 * (`@originals/vh`), so the two never disagree about a did:btco. An
 * inscription it cannot read fails resolution: it could be a newer version.
 *
 * This replaces the earlier content-based convention (the document as
 * inscription content, a 🔥 marker for deactivation), which the method does
 * not define. Nothing is fetched from inscription content URLs.
 */
import { OriginalsError } from '@originals/vh';
import { verifyAuthorHistory, type SatEvidence } from '@originals/vh/originals';
import type { DIDDocument } from '../types/did.js';
import type { BitcoinNetwork, SatSnapshot } from '../bitcoin/sat-snapshot-types.js';

export interface BtcoDidResolutionResult {
  didDocument: DIDDocument | null;
  resolutionMetadata: {
    contentType?: string;
    /** invalidDid · notFound · invalidDidDocument · unresolvable · networkMismatch */
    error?: string;
    message?: string;
    satNumber?: string;
    network?: string;
    /** The DID's versions, oldest first, by inscription id. */
    versions?: string[];
  };
  didDocumentMetadata: {
    created?: string;
    updated?: string;
    deactivated?: boolean;
    /** The inscription holding the current version. */
    inscriptionId?: string;
    network?: string;
    /** The sat's current holder. Resolution metadata only: never a document field (P9.12). */
    ownership?: { address: string; outpoint: string };
  };
}

export interface BtcoDidResolutionOptions {
  /** One complete, stable read of a sat (an OrdinalsProvider's `getSatSnapshot`). */
  satSnapshot: (satoshi: string) => Promise<SatSnapshot>;
}

const NETWORKS: Record<string, BitcoinNetwork> = { '': 'mainnet', reg: 'regtest', sig: 'signet', test: 'testnet' };

export function parseBtcoDid(did: string): { satNumber: string; network: BitcoinNetwork } | null {
  const m = /^did:btco:(?:(reg|sig|test):)?(0|[1-9]\d{0,15})$/.exec(did);
  if (!m || BigInt(m[2]) > 2_099_999_997_689_999n) return null;
  return { satNumber: m[2], network: NETWORKS[m[1] ?? ''] };
}

function iso(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

export class BtcoDidResolver {
  constructor(private readonly options: BtcoDidResolutionOptions) {}

  async resolve(did: string): Promise<BtcoDidResolutionResult> {
    const parsed = parseBtcoDid(did);
    if (!parsed) return failed('invalidDid', `Invalid did:btco: ${did}`);
    const { satNumber, network } = parsed;
    let snapshot: SatSnapshot;
    try {
      snapshot = await this.options.satSnapshot(satNumber);
    } catch (error) {
      return failed('unresolvable', `The sat ${satNumber} could not be read: ${error instanceof Error ? error.message : String(error)}`, { satNumber, network });
    }
    if (snapshot.network !== network) return failed('networkMismatch', `${did} is a ${network} DID; the provider reads ${snapshot.network}`, { satNumber, network });
    if (snapshot.sat !== satNumber || !snapshot.enumerationComplete || !snapshot.indexHealthy) {
      return failed('unresolvable', `The sat ${satNumber} was not read in full`, { satNumber, network });
    }
    // One stable read: a tip that moved during it may have changed what it saw.
    if (snapshot.tipBefore.height !== snapshot.tipAfter.height || snapshot.tipBefore.hash !== snapshot.tipAfter.hash) {
      return failed('unresolvable', `The chain moved while the sat ${satNumber} was read`, { satNumber, network });
    }
    const blockTime = new Map(snapshot.blocks.map((b) => [b.height, b.time]));
    const evidence: SatEvidence = {
      sat: did,
      tip: { height: snapshot.tipAfter.height, hash: snapshot.tipAfter.hash },
      inscriptions: [],
      owner: null,
      indexes: 1,
    };
    for (const p of snapshot.publications) {
      if (p.body.status !== 'complete' || !p.creation) {
        return failed('unresolvable', `Inscription ${p.id} on the sat could not be read; it could be a newer version`, { satNumber, network });
      }
      evidence.inscriptions.push({
        id: p.id,
        height: p.creation.height,
        transactionIndex: p.creation.transactionIndex,
        inscriptionIndex: p.creation.inscriptionIndex,
        confirmations: p.confirmed ? snapshot.tipAfter.height - p.creation.height + 1 : 0,
        inscriptionTime: (blockTime.get(p.creation.height) ?? 0) * 1000,
        mediaType: p.body.mediaType,
        content: p.body.bytes,
        metadata: p.body.metadata,
      });
    }
    let history;
    try {
      history = await verifyAuthorHistory({ did, bitcoin: evidence });
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      return failed('invalidDidDocument', error.message, { satNumber, network });
    }
    if (history.failure) {
      const code = history.failure.error.code === 'AUTHOR_DID_NOT_FOUND' ? 'notFound' : 'invalidDidDocument';
      return failed(code, history.failure.error.message, { satNumber, network });
    }
    const first = history.versions[0];
    const latest = history.versions[history.versions.length - 1];
    const heightOf = (versionId: string) => evidence.inscriptions.find((i) => i.id === versionId)?.height;
    const satpoint = snapshot.ownership.satpoint;
    const ownership = snapshot.ownership.owner && satpoint
      ? { address: snapshot.ownership.owner, outpoint: satpoint.split(':').slice(0, 2).join(':') }
      : undefined;
    const created = iso(blockTime.get(heightOf(first.versionId) ?? -1));
    const updated = iso(blockTime.get(heightOf(latest.versionId) ?? -1));
    return {
      didDocument: latest.deactivated ? null : (latest.document as unknown as DIDDocument),
      resolutionMetadata: { contentType: 'application/did+json', satNumber, network, versions: history.versions.map((v) => v.versionId) },
      didDocumentMetadata: {
        ...(created ? { created } : {}),
        ...(updated ? { updated } : {}),
        ...(latest.deactivated ? { deactivated: true } : {}),
        inscriptionId: latest.versionId,
        network,
        ...(ownership ? { ownership } : {}),
      },
    };
  }
}

function failed(error: string, message: string, extra: { satNumber?: string; network?: string } = {}): BtcoDidResolutionResult {
  return { didDocument: null, resolutionMetadata: { error, message, ...extra }, didDocumentMetadata: {} };
}
