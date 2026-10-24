/**
 * The landing's shared host, client side (P6.7, P6.8): saves for a hosted
 * Original go to `POST /api/originals/submit/<site key>`
 * (server/originals-routes.ts), where `<site key>` is the alias did:webvh's
 * `#files` base without its scheme: `<domain>/<user-slug>/o-<name>`.
 *
 * Wire format (PROVISIONAL): a JSON body
 *   { original, entry, resources: { <digest>: <base64 bytes> }, identities: [{ did, log, witness? }] }
 * and the answers
 *   200 { status: "accepted" | "already-accepted", checkpoint, head }
 *   409 { status: "stale-parent", head }
 * Anything else (400, 401, 403, 404, 413, 422, 429, 5xx) is an error, never an answer.
 * 403 means the signed-in account is neither the namespace owner nor one whose
 * landing DID the head state names as author or editor; for a byte-identical
 * retry, that the account was not named as author or editor by the state at
 * the matching entry's parent. A retry from an account allowed there is
 * answered already-accepted, even after its grant was revoked (P6.7, C12-128).
 *
 * The host's accepted log is read back the way any reader reads it: through
 * the alias's public URLs (`OriginalsSDK.retrieveHosted`), and the SDK
 * verifies it before using it.
 */
import { base64 } from '@scure/base';
import type { EvidenceContents, HostAnswer, HostedFetch, OriginalsSDK, SharedHost, Submission } from '@originals/sdk/originals';
import { didWebvhFilesUrl } from '@originals/vh/webvh';

/** `<domain>/<user-slug>/o-<name>`: where the alias's hosted files live, and the submit route's key. */
export function siteKeyOf(aliasDid: string): string {
  return didWebvhFilesUrl(aliasDid).slice('https://'.length).replace(/\/$/, '');
}

export function encodeSubmission(submission: Submission): string {
  return JSON.stringify({
    original: submission.original,
    entry: submission.entry,
    resources: Object.fromEntries(Object.entries(submission.resources).map(([digest, bytes]) => [digest, base64.encode(bytes)])),
    // A did:btco identity has no log to submit: its history is read from Bitcoin (P5.13).
    identities: submission.identities.flatMap((i) => (i.log === undefined ? [] : [{ did: i.did, log: typeof i.log === 'string' ? i.log : i.log.map((e) => `${JSON.stringify(e)}\n`).join(''), ...(i.witness !== undefined ? { witness: i.witness } : {}) }])),
  });
}

/** Sends a submission to the landing's submit route. `DurableHostingStorageAdapter` is one. */
export interface SubmitTransport {
  submit(siteKey: string, body: string): Promise<{ status: number; body: unknown }>;
}

export class SubmitRefusedError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`the host refused the save: ${status} ${JSON.stringify(body)}`);
    this.name = 'SubmitRefusedError';
  }
}

/** Interpret the route's answer: accepted, already accepted, stale parent, or an error. */
export function readAnswer(status: number, body: unknown): HostAnswer {
  const b = body as Partial<HostAnswer> | null;
  if (status === 200 && (b?.status === 'accepted' || b?.status === 'already-accepted')) return b as HostAnswer;
  if (status === 409 && b?.status === 'stale-parent') return b as HostAnswer;
  throw new SubmitRefusedError(status, body);
}

export function landingSharedHost(opts: { sdk: OriginalsSDK; aliasDid: string; transport: SubmitTransport; read: HostedFetch }): SharedHost {
  const siteKey = siteKeyOf(opts.aliasDid);
  return {
    async submit(submission: Submission): Promise<HostAnswer> {
      const { status, body } = await opts.transport.submit(siteKey, encodeSubmission(submission));
      return readAnswer(status, body);
    },
    accepted(): Promise<EvidenceContents> {
      return opts.sdk.retrieveHosted(opts.aliasDid, opts.read);
    },
  };
}
