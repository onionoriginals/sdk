// A small did:og world for verifier tests: did:webvh (or did:vh) signers built with the VH
// engine, an asset log signed by them, and evidence sets over it.
import type { ProofSigner } from '../../src/crypto/index.js';
import type { JsonObject } from '../../src/json/index.js';
import { serializeLog as serializeVh } from '../../src/log/index.js';
import {
  prepareGenesis, prepareNext, resourceDigest, serializeLog, signEntry, verifyOriginal,
  type EvidenceInput, type EvidenceSet, type OgEntry, type Report,
} from '../../src/og/index.js';
import { seeded, VhAuthor, WebvhAuthor } from './originals.js';

export const enc = (s: string) => new TextEncoder().encode(s);
export const res = (text: string) => enc(text);
export const descOf = (b: Uint8Array, mediaType = 'text/plain') => ({ mediaType, size: b.length, digest: resourceDigest(b) });

export type Signer = { did: string; log: () => string; ref: (fragment?: string, versionId?: string) => { did: string; verificationMethod: string; versionId: string }; key: ProofSigner; kind: 'webvh' | 'vh'; handle: WebvhAuthor | VhAuthor };

let seed = 10;
/** A did:webvh signer with one assertionMethod key, `key-1`. */
export async function webvhSigner(domain = `s${seed}.example.com`, key: ProofSigner = seeded(seed++)): Promise<Signer> {
  const a = await WebvhAuthor.create([{ fragment: 'key-1', signer: key }], { domain });
  return {
    did: a.did, key, kind: 'webvh', handle: a,
    log: () => serializeVh(a.entries),
    ref: (fragment = 'key-1', versionId = a.versionId) => a.ref(fragment, versionId),
  };
}

/** A DIF did:vh signer with one assertionMethod key, `key-1`. */
export async function vhSigner(key: ProofSigner = seeded(seed++)): Promise<Signer> {
  const a = await VhAuthor.create([{ fragment: 'key-1', signer: key }]);
  return {
    did: a.did, key, kind: 'vh', handle: a,
    log: () => serializeVh(a.entries),
    ref: (fragment = 'key-1', versionId = a.versionId) => a.ref(fragment, versionId),
  };
}

let t = Date.parse('2026-11-01T00:00:00Z');
const time = () => new Date((t += 1000)).toISOString().replace('.000Z', 'Z');

export class World {
  entries: OgEntry[] = [];
  resources = new Map<string, Uint8Array>();
  constructor(public author: Signer) {}

  static async create(author?: Signer, asset: JsonObject = {}, bytes = res('version 1')): Promise<World> {
    const w = new World(author ?? (await webvhSigner()));
    w.resources.set(resourceDigest(bytes), bytes);
    const state = {
      id: 'did:og:{SCID}', operation: 'create', author: w.author.ref(),
      asset: { name: 'Harbor at dawn', status: 'active', network: 'regtest', resource: descOf(bytes), aliases: [], ...asset },
      transitions: [{ from: null, to: resourceDigest(bytes) }],
    };
    w.entries.push(await signEntry(prepareGenesis({ versionTime: time(), state }), w.author.ref().verificationMethod, w.author.key));
    return w;
  }

  get did(): string {
    return this.entries[0].state.id as string;
  }

  get head(): OgEntry {
    return this.entries[this.entries.length - 1];
  }

  /**
   * An entry after `parent` (default the head), signed by `by` (default the author) with its
   * current reference. `change` edits a copy of the parent's state.
   */
  async entry(change: (s: any) => void = () => {}, opts: { parent?: OgEntry; by?: Signer; editor?: boolean; ref?: ReturnType<Signer['ref']>; key?: ProofSigner; parameters?: JsonObject; push?: boolean } = {}): Promise<OgEntry> {
    const parent = opts.parent ?? this.head;
    const state = JSON.parse(JSON.stringify(parent.state));
    state.operation = 'update';
    state.transitions = [];
    delete state.editor;
    delete state.supersedes;
    const by = opts.by ?? this.author;
    const ref = opts.ref ?? by.ref();
    if (opts.editor) state.editor = ref;
    else if (by === this.author) state.author = ref;
    change(state);
    const e = await signEntry(prepareNext(parent, { versionTime: time(), parameters: opts.parameters ?? {}, state }), ref.verificationMethod, opts.key ?? by.key);
    if (opts.push !== false) this.entries.push(e);
    return e;
  }

  /** A new version of the resource in `s`. */
  version(s: any, bytes: Uint8Array, mediaType = s.asset.resource.mediaType) {
    this.resources.set(resourceDigest(bytes), bytes);
    const from = s.asset.resource.digest;
    s.asset.resource = descOf(bytes, mediaType);
    s.transitions = [{ from, to: s.asset.resource.digest }];
  }

  /** The default evidence set: the log, every signer's history and every version's bytes. */
  evidence(opts: { logs?: OgEntry[][]; signers?: Signer[]; histories?: Array<{ did: string; log: string; source?: string; obtained?: string }>; resources?: Uint8Array[] | false; checkpoint?: string; prior?: Report } = {}): EvidenceSet {
    const inputs: EvidenceInput[] = [];
    (opts.logs ?? [this.entries]).forEach((log, i) => inputs.push({ kind: 'log', source: `log-${i}.jsonl`, bytes: enc(serializeLog(log)) }));
    const signers = opts.signers ?? [this.author];
    const histories = opts.histories ?? signers.map((s) => ({ did: s.did, log: s.log() }));
    const notes = histories.map((h, i) => ({ did: h.did, source: h.source ?? `signer-${i}.jsonl`, obtained: h.obtained ?? '2026-11-20T00:00:00Z' }));
    histories.forEach((h, i) => inputs.push({ kind: 'signer-history', source: notes[i].source, bytes: enc(h.log), did: h.did }));
    if (opts.resources !== false) for (const b of opts.resources ?? [...this.resources.values()]) inputs.push({ kind: 'resource', source: `res-${resourceDigest(b)}`, bytes: b });
    return { original: this.did, checkpoint: opts.checkpoint ?? null, inputs, signerHistories: notes, network: null, tip: null, depth: null, prior: opts.prior ?? null };
  }

  verify(opts: Parameters<World['evidence']>[0] = {}): Promise<Report> {
    return verifyOriginal(this.evidence(opts));
  }
}

/** The label of one entry in a report. */
export const labelOf = (r: Report, e: OgEntry) => r.entries?.find((x) => x.versionId === e.versionId);
export const axes = (r: Report) => r.axes as Record<string, string>;
