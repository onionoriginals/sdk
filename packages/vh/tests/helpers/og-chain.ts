// A synthetic Bitcoin chain for did:og tests: sats with inscriptions in chain order, read by
// one or more indexes at a tip, and evidence sets over them (P7.17, P9.18, P9.31). Inscriptions
// carry no signer histories (D22): the chain records which did:vh / did:webvh signers a test
// resolves, and `evidence()` supplies their logs as signer-history inputs.
import type { JsonObject } from '../../src/json/index.js';
import { encodeCbor } from '../../src/originals/cbor.js';
import { buildPublication, type EvidenceSet, type InscriptionRead, type OgEntry, type PublicationPart, type SatRead } from '../../src/og/index.js';
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
  /** did:vh / did:webvh signers whose logs the evidence set supplies, as resolved at verification (D22). */
  supplied = new Map<string, Supplied>();

  /** Supply these signers' logs in the evidence set (through version `to`, or all of it). */
  supply(...items: Supplied[]): this {
    for (const x of items) {
      const known = this.supplied.get(x.signer.did);
      const to = !known ? x.to : known.to === undefined || x.to === undefined ? undefined : Math.max(known.to, x.to);
      this.supplied.set(x.signer.did, { signer: x.signer, to });
    }
    return this;
  }

  /** Inscribe envelopes on `sat`, each in a new block unless `sameBlock`. Returns their ids. */
  inscribe(sat: string, envelopes: Uint8Array[], opts: { sameBlock?: boolean; txIndex?: number; confirmations?: number; height?: number } = {}): string[] {
    const list = this.sats.get(sat) ?? [];
    const ids: string[] = [];
    for (const envelope of envelopes) this.supply(...(SUPPLIES.get(envelope) ?? []));
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

  /** An inscription the index lists but whose envelope and metadata the verifier did not read (P5.13). */
  unread(sat: string, opts: Parameters<Chain['inscribe']>[2] = {}): string {
    const [id] = this.inscribe(sat, [new Uint8Array()], opts);
    this.sats.get(sat)!.at(-1)!.unread = true;
    return id;
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

  /**
   * The evidence set: every sat's inscriptions at the tip, read by one index; the logs of the signers
   * supplied (`histories: false` for none, or exactly these); plus any extra inputs.
   */
  evidence(original: string, opts: { sats?: string[]; reads?: SatRead[]; extra?: EvidenceSet['inputs']; network?: EvidenceSet['network']; originalsIndex?: EvidenceSet['originalsIndex']; tipHeight?: number; histories?: Array<{ did: string; log: string; source?: string; obtained?: string }> | false } = {}): EvidenceSet {
    const reads = opts.reads ?? (opts.sats ?? [...this.sats.keys()]).map((s) => this.read(s));
    const inputs: EvidenceSet['inputs'] = reads.flatMap((r) => r.inscriptions.map((i) => ({ kind: 'inscription' as const, source: `index:${i.id}`, bytes: i.envelope })));
    const histories = opts.histories === false ? [] : opts.histories ?? [...this.supplied.values()].map((x) => ({ did: x.signer.did, log: logThrough(x.signer, x.to) }));
    const notes = histories.map((h) => ({ did: h.did, source: h.source ?? `resolved:${h.did}`, obtained: h.obtained ?? '2026-11-20T00:00:00Z' }));
    const enc = new TextEncoder();
    const supplied = histories.map((h, k) => ({ kind: 'signer-history' as const, source: notes[k].source, bytes: enc.encode(h.log), did: h.did }));
    return {
      original, checkpoint: null, inputs: [...inputs, ...supplied, ...(opts.extra ?? [])], network: opts.network ?? 'regtest',
      tip: { height: opts.tipHeight ?? this.height + 10, hash: 'f'.repeat(64) }, depth: 1, sats: reads, originalsIndex: opts.originalsIndex ?? null,
      signerHistories: notes,
    };
  }
}

/** A signer whose log the evidence set supplies, through version `to` (1-based) or all of it (D22). */
export interface Supplied {
  signer: Signer;
  to?: number;
}

/** The signers a test resolves for a publication, by each part's envelope (never inscribed, D22). */
const SUPPLIES = new WeakMap<Uint8Array, Supplied[]>();

/** The signer's did.jsonl through version `to`, as resolution would return it. */
export function logThrough(s: Signer, to?: number): string {
  if (to === undefined) return s.log();
  return s.log().split('\n').filter((l) => l.length).slice(0, to).map((l) => `${l}\n`).join('');
}

/** Supply a signer's log (through version `to`) to the verifier: resolution, not inscription (D22). */
export function history(s: Signer, _from = 1, to?: number): Supplied {
  return { signer: s, to };
}

/** A publication of these entries, supplying these signers' logs in the evidence set. */
export function publication(input: { entries: OgEntry[]; body?: Uint8Array | null }, supplies: Supplied[] = []): PublicationPart[] {
  const parts = buildPublication({ entries: input.entries, body: input.body ?? null });
  for (const p of parts) SUPPLIES.set(p.envelope, supplies);
  return parts;
}

/** The anchoring publication of a world's log; its author's log is supplied, not inscribed (D22). */
export function anchoring(w: World, opts: { body?: Uint8Array | null; signers?: Supplied[]; entries?: OgEntry[] } = {}): PublicationPart[] {
  return publication({ entries: opts.entries ?? w.entries, body: opts.body ?? null }, opts.signers ?? [history(w.author)]);
}
