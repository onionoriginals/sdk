// A synthetic Bitcoin chain for did:og tests: sats with inscriptions in chain order, read by
// one or more indexes at a tip, and evidence sets over them (P7.17, P9.18, P9.31).
import { parseJsonLines, type JsonObject } from '../../src/json/index.js';
import { encodeCbor } from '../../src/originals/cbor.js';
import { buildPublication, type EvidenceSet, type InscriptionRead, type OgEntry, type PublicationPart, type SatRead, type SignerHistoryItem } from '../../src/og/index.js';
import type { Signer, World } from './og-world.js';

let txSeq = 0;
const hex64 = () => (txSeq++).toString(16).padStart(64, 'a');

/** A raw ord envelope with chosen fields (for did:btco documents and malformed inscriptions). */
export function rawEnvelope(fields: Array<[number, Uint8Array]>, body?: Uint8Array | null): Uint8Array {
  const push = (d: Uint8Array) => (d.length <= 75 ? [d.length, ...d] : d.length <= 255 ? [0x4c, d.length, ...d] : [0x4d, d.length & 0xff, d.length >> 8, ...d]);
  const s = [0x00, 0x63, ...push(new TextEncoder().encode('ord'))];
  for (const [tag, v] of fields) for (let i = 0; i < Math.max(1, v.length); i += 520) s.push(...push(Uint8Array.of(tag)), ...push(v.subarray(i, i + 520)));
  if (body) { s.push(0x00); for (let i = 0; i < body.length; i += 520) s.push(...push(body.subarray(i, i + 520))); } else if (body !== undefined && body !== null) s.push(0x00);
  s.push(0x68);
  return new Uint8Array(s);
}

export class Chain {
  height = 200;
  /** Per sat: its inscriptions in order. */
  sats = new Map<string, InscriptionRead[]>();
  holders = new Map<string, string>();

  /** Inscribe envelopes on `sat`, each in a new block unless `sameBlock`. Returns their ids. */
  inscribe(sat: string, envelopes: Uint8Array[], opts: { sameBlock?: boolean; txIndex?: number; confirmations?: number; height?: number } = {}): string[] {
    const list = this.sats.get(sat) ?? [];
    const ids: string[] = [];
    let txIndex = opts.txIndex ?? 1;
    for (const envelope of envelopes) {
      if (!opts.sameBlock && opts.height === undefined) this.height++;
      const id = `${hex64()}i0`;
      list.push({ id, sat: sat.split(':').pop()!, height: opts.height ?? this.height, txIndex: txIndex++, inscriptionIndex: 0, confirmations: opts.confirmations ?? 6, envelope });
      ids.push(id);
    }
    this.sats.set(sat, list);
    if (!this.holders.has(sat)) this.holders.set(sat, `bcrt1p${sat.replaceAll(':', '')}holder`);
    return ids;
  }

  publish(sat: string, parts: PublicationPart[], opts: Parameters<Chain['inscribe']>[2] = {}): string[] {
    return this.inscribe(sat, parts.map((p) => p.envelope), opts);
  }

  /** Inscribe a did:btco DID document version on its own sat (P5.13). */
  btcoVersion(did: string, doc: JsonObject, opts: Parameters<Chain['inscribe']>[2] = {}): string {
    return this.inscribe(did, [rawEnvelope([[5, encodeCbor(doc)]], new TextEncoder().encode('{}'))], opts)[0];
  }

  read(sat: string, index = 'ord-a', complete = true): SatRead {
    return { sat, index, complete, inscriptions: [...(this.sats.get(sat) ?? [])], holder: this.holders.get(sat) ?? null };
  }

  /** The P9.18 evidence set: every sat's inscriptions at the tip, read by one index; plus any extra inputs. */
  evidence(original: string, opts: { sats?: string[]; reads?: SatRead[]; extra?: EvidenceSet['inputs']; network?: EvidenceSet['network']; prior?: EvidenceSet['prior']; originalsIndex?: EvidenceSet['originalsIndex'] } = {}): EvidenceSet {
    const reads = opts.reads ?? (opts.sats ?? [...this.sats.keys()]).map((s) => this.read(s));
    const inputs: EvidenceSet['inputs'] = reads.flatMap((r) => r.inscriptions.map((i) => ({ kind: 'inscription' as const, source: `index:${i.id}`, bytes: i.envelope })));
    return {
      original, checkpoint: null, inputs: [...inputs, ...(opts.extra ?? [])], network: opts.network ?? 'regtest',
      tip: { height: this.height + 10, hash: 'f'.repeat(64) }, depth: 1, sats: reads, prior: opts.prior ?? null, originalsIndex: opts.originalsIndex ?? null,
    };
  }
}

/** A signer's log as inscribed history items (P9.33), from version `from` (1-based). */
export function history(s: Signer, from = 1, to?: number): SignerHistoryItem {
  const entries = parseJsonLines(s.log()) as JsonObject[];
  return { did: s.did, log: entries.slice(from - 1, to) };
}

/** The anchoring publication of a world's log, with its author's history inscribed. */
export function anchoring(w: World, opts: { body?: Uint8Array | null; signers?: SignerHistoryItem[]; entries?: OgEntry[] } = {}): PublicationPart[] {
  return buildPublication({ entries: opts.entries ?? w.entries, signers: opts.signers ?? [history(w.author)], body: opts.body ?? null });
}
