/**
 * The landing's shared host, client side (P6.7, P6.8): saves for a hosted
 * Original go to `POST /api/originals/submit/<site key>`
 * (@originals/host originals-routes.ts), where `<site key>` is the alias did:webvh's
 * `#files` base without its scheme: `<domain>/<user-slug>/o-<name>`.
 *
 * Wire format (PROVISIONAL): a JSON body
 *   { original, entry, resources: { <digest>: <base64 bytes> }, identities: [{ did, log, witness? }], parents?: [{ did, log }] }
 * where `parents`, for a child Original only, carries each parent's log
 * through the highest pin, nearest first (P5.25, P7.1)
 * and the answers
 *   200 { status: "accepted" | "already-accepted", checkpoint, head }
 *   409 { status: "stale-parent", head }
 * Anything else (400, 401, 403, 404, 413, 422, 429, 5xx) is an error, never an answer.
 * 403 `{ error: "forbidden_host" }` means the site key's host is not one this
 * instance serves (`VITE_WEBVH_HOST` or the legacy domain; #976 B, G1, P3.6):
 * the save names a did:webvh this host doesn't publish. Any other 403 is the
 * authorization refusal: the signed-in account is neither the namespace owner nor one whose
 * landing DID the head state names as author or editor; for a byte-identical
 * retry, that the account was not named as author or editor by the state at
 * the matching entry's parent. A retry from an account allowed there is
 * answered already-accepted, even after its grant was revoked (P6.7, C12-128).
 *
 * The host's accepted log is read back the way any reader reads it: through
 * the alias's public URLs (`OriginalsSDK.retrieveHosted`), and the SDK
 * verifies it before using it.
 */
import { encodeSubmission as sdkEncodeSubmission } from '@originals/sdk/originals';
import type { EvidenceContents, HostAnswer, HostedFetch, OriginalsSDK, SharedHost, Submission } from '@originals/sdk/originals';
import { didWebvhFilesUrl } from '@originals/vh/webvh';

/** `<domain>/<user-slug>/o-<name>`: where the alias's hosted files live, and the submit route's key. */
export function siteKeyOf(aliasDid: string): string {
  return didWebvhFilesUrl(aliasDid).slice('https://'.length).replace(/\/$/, '');
}

/**
 * The SDK's own encoder (`@originals/sdk/originals`), so the landing sends
 * exactly what the host parses, a child Original's `parents` included (P5.25).
 */
export const encodeSubmission: (submission: Submission) => string = sdkEncodeSubmission;

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
