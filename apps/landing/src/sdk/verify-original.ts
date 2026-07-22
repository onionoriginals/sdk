/**
 * Live, in-browser verification of one of the user's published Originals.
 *
 * Mirrors verify-example.ts, but runs against the artifacts the Original
 * actually hosts at this origin (fetched by the detail page): the resource
 * bytes are re-hashed, the did:webvh log's SCID + Ed25519 proof chain is
 * re-verified via didwebvh-ts, and the CEL event log's whole signed chain is
 * re-verified via the SDK — binding it to this DID through the migrate event.
 * Nothing is taken on faith from the server; the checks are the proof.
 */
import '../shims/buffer-global';
import { Ed25519Verifier, resolveDidCel } from '@originals/sdk';
import { resolveDIDFromLog } from 'didwebvh-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import type { CelLog } from '../pages/original-detail-data';

export interface OriginalCheck {
  id: 'hash' | 'log' | 'cel';
  ok: boolean;
  detail: string;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const short = (did: string) => (did.length > 42 ? `${did.slice(0, 36)}…` : did);

export async function verifyOriginal(input: {
  /** The Original's did:webvh identifier. */
  did: string;
  /** Parsed did.jsonl entries, or null when the log couldn't be fetched. */
  logEntries: unknown[] | null;
  /** Parsed cel.json, or null when it couldn't be fetched. */
  celLog: CelLog | null;
  /** The primary resource's fetched bytes, or null. */
  resourceBytes: Uint8Array | null;
  /** The sha-256 hex the provenance declares for those bytes. */
  declaredHash: string | null;
}): Promise<OriginalCheck[]> {
  const checks: OriginalCheck[] = [];

  // 1 · Content integrity: recompute the resource's sha-256 from its bytes.
  if (input.resourceBytes && input.declaredHash) {
    const recomputed = toHex(sha256(input.resourceBytes));
    checks.push({
      id: 'hash',
      ok: recomputed === input.declaredHash,
      detail: `sha-256 recomputed from ${input.resourceBytes.length} bytes → ${recomputed.slice(0, 20)}…`
    });
  } else {
    checks.push({ id: 'hash', ok: false, detail: 'Resource bytes could not be fetched' });
  }

  // 2 · Identity: verify the did:webvh log's SCID + Ed25519 proof chain and
  //     confirm it derives THIS DID (no server, no trust in this page).
  let logOk = false;
  let logDetail = 'DID log could not be fetched';
  if (input.logEntries?.length) {
    try {
      const resolved = (await resolveDIDFromLog(input.logEntries as never, {
        verifier: new Ed25519Verifier()
      } as never)) as unknown as { did?: string; doc?: Record<string, unknown> };
      const resolvedDid = resolved.did ?? (resolved.doc?.id as string) ?? '';
      logOk = !!resolved.doc && resolvedDid === input.did;
      logDetail = logOk
        ? `${input.logEntries.length} signed log ${input.logEntries.length === 1 ? 'entry' : 'entries'} verified → ${short(resolvedDid)}`
        : 'DID log did not verify';
    } catch (err) {
      console.error('[originals-sdk] original DID log verification failed', err);
      logDetail = 'DID log did not verify';
    }
  }
  checks.push({ id: 'log', ok: logOk, detail: logDetail });

  // 3 · Provenance: re-derive the did:cel genesis identity from the CEL log —
  //     resolveDidCel verifies the WHOLE signed event chain and binds the DID
  //     to it (null otherwise) — and confirm its migrate event targets this
  //     did:webvh, chaining genesis → published identity.
  let celOk = false;
  let celDetail = 'CEL log could not be fetched';
  const migrate = input.celLog?.events?.find(
    (e) => e.type === 'migrate' && e.data?.layer === 'webvh'
  );
  const celDid = migrate?.data?.sourceDid;
  if (input.celLog && celDid) {
    try {
      const celDoc = await resolveDidCel(celDid, input.celLog as never);
      celOk = !!celDoc && migrate?.data?.targetDid === input.did;
      celDetail = celOk
        ? `${input.celLog.events.length} signed events verified → ${short(celDid)}`
        : 'CEL event chain did not verify';
    } catch (err) {
      console.error('[originals-sdk] original CEL verification failed', err);
      celDetail = 'CEL event chain did not verify';
    }
  }
  checks.push({ id: 'cel', ok: celOk, detail: celDetail });

  console.log(
    '%c[originals-sdk] your-original verification',
    'color:#f7931a;font-weight:600;font-family:ui-monospace,monospace',
    { did: input.did, checks }
  );
  return checks;
}
