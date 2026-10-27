/**
 * Publishing a signed-in author's Original to the web (plan 011, PR 8; owner
 * decision Q13). Behind `FEATURES.hostedPublication`, which is off.
 *
 * 1. The alias: a did:webvh log of its own at
 *    `did:webvh:<SCID>:<domain>:<user-slug>:o-<name>`, whose document lists the
 *    Original in `alsoKnownAs` (PROVISIONAL, plan S4). Its update key is the
 *    author's identity key in Turnkey, so the author controls it (P3.7); it is
 *    portable, so it can move domains within its SCID (P9.3).
 * 2. The publish entry: an ordinary update listing the alias (P3.6). There are
 *    no witnesses (owner decision Q14).
 * 3. The hosted files: the alias log and the evidence package unpacked under
 *    `originals/` (hostedFiles), uploaded to the author's own namespace. The
 *    asset log goes before the resources, because the host labels each
 *    resource from its descriptor in the uploaded log (@originals/host hosted-layout.ts). The files
 *    for a checkpoint are deterministic, so a retry repeats the same snapshot
 *    (P9.2).
 */
import { createDIDOriginal } from "@originals/sdk";
import { hostedFiles, type CommitResult, type OriginalsSDK, type OriginalsSigner } from "@originals/sdk/originals";
import type { AliasEvidence, AuthorRef } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import type { WebVHSigner } from "../auth/webvh";

export interface HostedUpload {
  put(objectKey: string, data: Uint8Array | string, options?: { contentType?: string }): Promise<string>;
}

/** The alias's last path segment: `o-` and the first 16 characters of the Original's SCID. */
export function aliasName(original: string): string {
  return `o-${original.slice("did:vh:".length, "did:vh:".length + 16)}`;
}

/** Create the alias did:webvh log for `original`, signed and controlled by `signer`. */
export async function buildOriginalAlias(signer: WebVHSigner, opts: { domain: string; slug: string; original: string }): Promise<AliasEvidence> {
  const result = await createDIDOriginal({
    type: "did",
    domain: opts.domain,
    signer,
    verifier: signer,
    updateKeys: [signer.getVerificationMethodId()],
    // didwebvh-ts needs a verification method: the identity key, for
    // authentication only. It is never an Originals key (P5.11).
    verificationMethods: [{ id: "#key-0", type: "Multikey", publicKeyMultibase: signer.getPublicKeyMultibase() }],
    authentication: ["#key-0"],
    paths: [opts.slug, aliasName(opts.original)],
    portable: true,
    alsoKnownAs: [opts.original],
  });
  const entries = result.log as unknown[];
  return { did: result.did, log: entries.map((e) => `${JSON.stringify(e)}\n`).join("") };
}

/**
 * Upload order: the alias log, then the asset log, then everything else.
 * Within a rank paths sort, so a signer's did-witness.json goes before its
 * did.jsonl, which the host verifies with it (@originals/host hosted-layout.ts).
 */
function uploadOrder(path: string): number {
  if (!path.startsWith("originals/")) return 0;
  if (path === "originals/asset/did.jsonl") return 1;
  return path.startsWith("originals/resources/") ? 3 : 2;
}

export interface PublishInput {
  sdk: OriginalsSDK;
  did: string;
  parent: string;
  author: AuthorRef;
  signer: OriginalsSigner;
  /** Signs the alias log: the author's identity key, never the Originals key (P5.11). */
  aliasSigner: WebVHSigner;
  domain: string;
  slug: string;
  hosting: HostedUpload;
  /** An alias already published for this Original, when retrying (P9.2). */
  alias?: AliasEvidence;
  /**
   * Called with a newly built alias before anything is signed or uploaded, so
   * the caller can keep it for a retry: once the publish entry lists it, no
   * other alias can take its place.
   */
  onAlias?: (alias: AliasEvidence) => void | Promise<void>;
}

export interface Published {
  alias: AliasEvidence;
  commit: CommitResult | null;
  /** The base URL the files are served under: the alias's `#files` service. */
  baseUrl: string;
}

export async function publishOriginal(input: PublishInput): Promise<Published> {
  const listed = (await input.sdk.get(input.did)).state.aliases.filter((a) => a.startsWith("did:webvh:"));
  if (!input.alias && listed.length > 0) {
    throw new Error(`${input.did} already lists ${listed[0]}; publish again with that alias's log.`);
  }
  const alias = input.alias ?? (await buildOriginalAlias(input.aliasSigner, { domain: input.domain, slug: input.slug, original: input.did }));
  if (!input.alias) await input.onAlias?.(alias);
  if (listed.length > 0 && !listed.includes(alias.did)) throw new Error(`${input.did} already lists ${listed[0]}, not ${alias.did}.`);
  const commit = listed.length > 0 ? null : await input.sdk.publish(input.did, { parent: input.parent, author: input.author, signer: input.signer, alias });
  const baseUrl = didWebvhFilesUrl(alias.did);
  const baseKey = baseUrl.slice("https://".length);
  const files = [...(await hostedFiles(input.sdk, input.did, alias))].sort(([a], [b]) => uploadOrder(a) - uploadOrder(b) || a.localeCompare(b));
  for (const [path, bytes] of files) await input.hosting.put(`${baseKey}${path}`, bytes);
  return { alias, commit, baseUrl };
}
