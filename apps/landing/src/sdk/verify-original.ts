/**
 * Live, in-browser verification of one of the user's published Originals.
 *
 * Mirrors verify-example.ts, but runs against the artifacts the Original
 * actually hosts at this origin (fetched by the detail page): the resource
 * bytes are re-hashed, the did:webvh log's SCID + Ed25519 proof chain is
 * re-verified via didwebvh-ts, and the CEL event log's signed chain is
 * re-verified via the SDK up to the web publication — binding it to this DID
 * through the migrate event. Nothing is taken on faith from the server; the
 * checks are the proof, and each one reports exactly what it proved.
 */
import '../shims/buffer-global';
import { Ed25519Verifier, verifyEventLog } from '@originals/sdk';
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

/**
 * True when every verification error is "this event's Bitcoin anchor needs an
 * on-chain lookup" AND belongs to an event AFTER `upTo` (the web publication).
 * Once an asset is inscribed, its btco events carry a `bitcoin-ordinals-2024`
 * witness proof that verifyEventLog fails closed on without an ordinalsProvider
 * — and the browser has none (this origin proxies fee/broadcast, not inscription
 * lookups). Those errors say "not checkable here", not "the chain is broken", so
 * they must not condemn the genesis → did:webvh chain the page actually claims.
 * Errors on earlier events, or of any other kind, fail the check as before.
 */
function onlyUncheckableAnchorErrors(errors: string[], upTo: number): boolean {
  if (errors.length === 0) return false;
  return errors.every((err) => {
    const idx = Number(/^Event (\d+)/.exec(err)?.[1]);
    return (
      Number.isInteger(idx) &&
      idx > upTo &&
      /ordinalsProvider|ordinals provider/.test(err)
    );
  });
}

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

  // 3 · Provenance: re-verify the CEL's whole signed event chain against the
  //     did:cel its genesis event derives (expectedDid — so a doctored log
  //     fails closed) and confirm its migrate event targets this did:webvh,
  //     chaining genesis → published identity.
  //
  //     An INSCRIBED asset's log continues past that migrate with Bitcoin-
  //     anchored events whose witness proofs need an on-chain lookup the
  //     browser can't make. Verifying only up to the web publication — the
  //     exact claim this page makes — keeps those assets honest-green with a
  //     detail that says how much was checked, instead of reporting the whole
  //     chain broken (which is what it did before, on every inscribed asset).
  const events = input.celLog?.events ?? [];
  const migrateIdx = events.findIndex((e) => e.type === 'migrate' && e.data?.layer === 'webvh');
  const migrate = migrateIdx >= 0 ? events[migrateIdx] : undefined;
  const celDid = migrate?.data?.sourceDid;
  let celOk = false;
  let celDetail = 'CEL log could not be fetched';
  if (input.celLog && celDid) {
    celDetail = 'CEL event chain did not verify';
    try {
      if (migrate?.data?.targetDid !== input.did) {
        celDetail = 'CEL log does not bind to this DID';
      } else {
        const full = await verifyEventLog(input.celLog as never, { expectedDid: celDid } as never);
        if (full.verified) {
          celOk = true;
          celDetail = `${events.length} signed events verified → ${short(celDid)}`;
        } else if (onlyUncheckableAnchorErrors(full.errors ?? [], migrateIdx)) {
          const head = { ...input.celLog, events: events.slice(0, migrateIdx + 1) };
          const prefix = await verifyEventLog(head as never, { expectedDid: celDid } as never);
          celOk = prefix.verified;
          celDetail = celOk
            ? `${migrateIdx + 1} of ${events.length} signed events verified → ${short(celDid)} · the Bitcoin anchor needs an on-chain lookup this page can't make`
            : 'CEL event chain did not verify';
        }
      }
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
