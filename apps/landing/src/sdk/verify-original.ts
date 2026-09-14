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
import type { AssetResolution } from "@originals/sdk";
import { verifyHistory, validateDocument, sameAssetIdentity } from "@originals/sdk/cel";
import { resolveDIDFromLog } from "didwebvh-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CelLog } from "../pages/original-detail-data";

export interface OriginalCheck {
  id: "hash" | "log" | "cel" | "btco";
  ok: boolean;
  detail: string;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const short = (did: string) => (did.length > 42 ? `${did.slice(0, 36)}…` : did);

/**
 * Independently re-resolve the accepted on-sat history from a fresh
 * provider snapshot (never trusting a server-asserted summary) and confirm
 * it binds to the SAME asset id and controller the CEL/webvh checks already
 * verified — a resolvable-but-unrelated sat must not read as proof of this
 * Original. Exported on its own (not just inlined in `verifyOriginal`) so a
 * caller can run this potentially-slow, network-bound check independently
 * of the fast local hash/log/cel checks, instead of it blocking them.
 */
export function evaluateBtcoCheck(input: {
  sat: string;
  /** Whether the "cel" check above already verified — this can only strengthen that binding, never substitute for it. */
  celVerified: boolean;
  /** The CEL/webvh-verified asset id, or null if that verification did not produce one. */
  assetId: string | null;
  /** The CEL/webvh-verified controller, or null if that verification did not produce one. */
  controller: string | null;
  /** The caller's own fresh `sdk.lifecycle.resolveAssetFromSat(sat, ...)` result, or null if unavailable/failed. */
  resolution: AssetResolution | null;
}): OriginalCheck {
  let btcoOk = false;
  let btcoDetail = "Bitcoin publication could not be verified";
  const resolution = input.resolution;
  if (input.celVerified && input.assetId && input.controller && resolution) {
    if (resolution.status === "accepted") {
      const boundAssetId = sameAssetIdentity(resolution.asset.id, input.assetId);
      const boundController = resolution.resolution.state.controller === input.controller;
      btcoOk = boundAssetId && boundController;
      btcoDetail = btcoOk
        ? `${resolution.resolution.publications.length} accepted on-chain publication${resolution.resolution.publications.length === 1 ? "" : "s"} verified (${resolution.resolution.chainEvidence.assurance}) → sat ${input.sat}`
        : "Accepted Bitcoin history does not bind to this Original";
    } else {
      btcoDetail = `Bitcoin publication not accepted: ${resolution.reason}`;
    }
  } else if (!input.celVerified || !input.assetId || !input.controller) {
    btcoDetail = "Bitcoin publication requires the CEL/WebVH history above to verify first";
  }
  return { id: "btco", ok: btcoOk, detail: btcoDetail };
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
  /**
   * The satoshi this Original is inscribed on, if it has migrated to
   * Bitcoin — omitted (or null) for a webvh-only publication, in which case
   * no "btco" check is produced at all.
   */
  sat?: string | null;
  /**
   * The caller's own fresh `sdk.lifecycle.resolveAssetFromSat(sat, ...)`
   * result (or null if that call failed/threw) — this function never
   * performs its own network I/O, matching every other check here.
   */
  btcoResolution?: AssetResolution | null;
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
  // Hoisted for the btco check below: the accepted Bitcoin history must bind
  // to THIS asset id and controller, not merely resolve successfully.
  let history: ReturnType<typeof verifyHistory> | null = null;
  if (input.celLog) {
    try {
      const document = validateDocument(input.celLog);
      const verifiedHistory = verifyHistory(document);
      history = verifiedHistory;
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
        verifiedHistory.state.aliases.includes(input.did) &&
        !!method?.doc?.alsoKnownAs?.some((alias) => sameAssetIdentity(alias, verifiedHistory.state.assetId));
      celDetail = celOk
        ? `${document.log.length} signed controller events and the WebVH backlink verified → ${short(verifiedHistory.state.assetId)}`
        : "CEL history and method log do not bind to this Original";
    } catch {
      celDetail = "CEL 3 controller history did not verify";
    }
  }
  checks.push({ id: "cel", ok: celOk, detail: celDetail });

  // 4 · Bitcoin: only for an Original that has migrated on-sat (input.sat
  //     set). See evaluateBtcoCheck — exported separately so a caller (the
  //     public Explore page) can run this potentially-slow check on its own
  //     schedule instead of it blocking the checks above.
  if (input.sat) {
    checks.push(
      evaluateBtcoCheck({
        sat: input.sat,
        celVerified: celOk,
        assetId: history?.state.assetId ?? null,
        controller: history?.state.controller ?? null,
        resolution: input.btcoResolution ?? null,
      }),
    );
  }

  console.log(
    "%c[originals-sdk] your-original verification",
    "color:#f7931a;font-weight:600;font-family:ui-monospace,monospace",
    { did: input.did, checks },
  );
  return checks;
}
