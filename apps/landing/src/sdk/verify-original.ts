import { sameAssetIdentity } from "@originals/sdk/cel";
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
import "../shims/buffer-global";
import { Ed25519Verifier } from "@originals/sdk";
import { verifyHistory, validateDocument } from "@originals/sdk/cel";
import { resolveDIDFromLog } from "didwebvh-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CelLog } from "../pages/original-detail-data";

export interface OriginalCheck {
  id: "hash" | "log" | "cel";
  ok: boolean;
  detail: string;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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
      id: "hash",
      ok: recomputed === input.declaredHash,
      detail: `sha-256 recomputed from ${input.resourceBytes.length} bytes → ${recomputed.slice(0, 20)}…`,
    });
  } else {
    checks.push({
      id: "hash",
      ok: false,
      detail: "Resource bytes could not be fetched",
    });
  }

  // 2 · Identity: verify the did:webvh log's SCID + Ed25519 proof chain and
  //     confirm it derives THIS DID (no server, no trust in this page).
  let logOk = false;
  let logDetail = "DID log could not be fetched";
  if (input.logEntries?.length) {
    try {
      const resolved = (await resolveDIDFromLog(
        input.logEntries as never,
        {
          verifier: new Ed25519Verifier(),
        } as never,
      )) as unknown as { did?: string; doc?: Record<string, unknown> };
      const resolvedDid = resolved.did ?? (resolved.doc?.id as string) ?? "";
      logOk = !!resolved.doc && resolvedDid === input.did;
      logDetail = logOk
        ? `${input.logEntries.length} signed log ${input.logEntries.length === 1 ? "entry" : "entries"} verified → ${short(resolvedDid)}`
        : "DID log did not verify";
    } catch (err) {
      console.error(
        "[originals-sdk] original DID log verification failed",
        err,
      );
      logDetail = "DID log did not verify";
    }
  }
  checks.push({ id: "log", ok: logOk, detail: logDetail });

  // The two histories bind in both directions: CEL alias plus method-log
  // alsoKnownAs. Verifying either signature chain alone is insufficient.
  let celOk = false;
  let celDetail = "CEL 3 history could not be verified";
  if (input.celLog) {
    try {
      const document = validateDocument(input.celLog);
      const history = verifyHistory(document);
      const resolved = input.logEntries?.length
        ? await resolveDIDFromLog(
            input.logEntries as never,
            { verifier: new Ed25519Verifier() } as never,
          )
        : null;
      const method = resolved as unknown as {
        did?: string;
        doc?: { id?: string; alsoKnownAs?: string[] };
      } | null;
      celOk =
        logOk &&
        history.state.aliases.includes(input.did) &&
        !!method?.doc?.alsoKnownAs?.some((alias) => sameAssetIdentity(alias, history.state.assetId));
      celDetail = celOk
        ? `${document.log.length} signed controller events and the WebVH backlink verified → ${short(history.state.assetId)}`
        : "CEL history and method log do not bind to this Original";
    } catch {
      celDetail = "CEL 3 controller history did not verify";
    }
  }
  checks.push({ id: "cel", ok: celOk, detail: celDetail });

  console.log(
    "%c[originals-sdk] your-original verification",
    "color:#f7931a;font-weight:600;font-family:ui-monospace,monospace",
    { did: input.did, checks },
  );
  return checks;
}
