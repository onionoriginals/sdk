// Builders for did:og test logs: the vector's author and resources, signed entries, and a
// branch walk that applies the state rules in order.
import type { JsonObject } from '../../src/json/index.js';
import {
  advance, checkTransition, genesisContext, ogHash, prepareGenesis, prepareNext, resourceDigest, signEntry,
  type BranchContext, type OgEntry,
} from '../../src/og/index.js';
import type { ProofSigner } from '../../src/crypto/index.js';
import { vbytes, vjson, vectorKey, utf8 } from './og-vectors.js';

export const authorKey = vectorKey('author assertionMethod key-1');
export const authorLogEntry = vjson<JsonObject>('local/author/did.jsonl');
export const AUTHOR = (authorLogEntry.state as JsonObject).id as string;
export const authorRef = { did: AUTHOR, verificationMethod: `${AUTHOR}#key-1`, versionId: authorLogEntry.versionId as string };
export const v1 = vbytes('local/resources/v1.md');
export const v2 = vbytes('local/resources/v2.md');
export const desc = (b: Uint8Array, mediaType = 'text/markdown') => ({ mediaType, size: b.length, digest: resourceDigest(b) });

/** A syntactically valid did:webvh for a label. */
export const fakeWebvh = (label: string, host = 'example.com') => `did:webvh:${ogHash({ label })}:${host}`;

export function genesisState(extra: JsonObject = {}, asset: JsonObject = {}): JsonObject {
  return {
    id: 'did:og:{SCID}', operation: 'create', author: authorRef,
    asset: { name: 'Field notes', status: 'active', network: 'regtest', resource: desc(v1), aliases: [], ...asset },
    transitions: [{ from: null, to: resourceDigest(v1) }],
    ...extra,
  };
}

let clock = Date.parse('2026-01-02T00:00:00Z');
export const tick = () => new Date((clock += 1000)).toISOString().replace('.000Z', 'Z');

export async function genesis(state = genesisState(), time = '2026-01-02T00:00:00Z', key: ProofSigner = authorKey, vm = authorRef.verificationMethod): Promise<OgEntry> {
  return signEntry(prepareGenesis({ versionTime: time, state }), vm, key);
}

/** The next entry; `change` edits a copy of the parent's state (operation update, no transitions by default). */
export async function next(
  prev: OgEntry,
  change: (state: any) => void = () => {},
  opts: { parameters?: JsonObject; time?: string; key?: ProofSigner; vm?: string } = {},
): Promise<OgEntry> {
  const state = JSON.parse(JSON.stringify(prev.state));
  state.operation = 'update';
  state.transitions = [];
  delete state.editor;
  delete state.supersedes;
  change(state);
  const vm = opts.vm ?? (state.editor ? state.editor.verificationMethod : authorRef.verificationMethod);
  return signEntry(prepareNext(prev, { versionTime: opts.time ?? tick(), parameters: opts.parameters ?? {}, state }), vm, opts.key ?? authorKey);
}

/** A new resource version in `state`: descriptor and transition. */
export function newVersion(state: any, bytes: Uint8Array, mediaType = state.asset.resource.mediaType) {
  const from = state.asset.resource.digest;
  state.asset.resource = desc(bytes, mediaType);
  state.transitions = [{ from, to: state.asset.resource.digest }];
}

/** Apply the state rules along a branch; the first failure as {index, rule, code}. */
export function walk(entries: OgEntry[]): { index: number; rule?: string; code: string } | undefined {
  let ctx: BranchContext = genesisContext(entries[0]);
  for (let i = 0; i < entries.length; i++) {
    try {
      checkTransition(ctx, entries[i], i);
    } catch (error) {
      const e = error as { code: string; details?: { rule?: string } };
      return { index: i, rule: e.details?.rule, code: e.code };
    }
    ctx = advance(ctx, entries[i]);
  }
  return undefined;
}

export const bytes = utf8;
