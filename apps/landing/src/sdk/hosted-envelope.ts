import { base64 } from "@scure/base";
import { validateDocument, verifyHistory } from "@originals/sdk/cel";
import type { AssetEnvelope } from "@originals/sdk";
import type { CelLog } from "../pages/original-detail-data";
import { digestMultibaseSha256Hex } from "../pages/original-detail-data";
import { contentBytes, type ResourceContent } from "./resource-view";

export function resourceKind(mediaType?: string): string {
  return mediaType?.startsWith("image/")
    ? "image"
    : mediaType?.startsWith("text/")
      ? "text"
      : "data";
}
export interface HydrationProblem {
  code: "NO_CEL" | "INVALID_CEL" | "MISSING_CONTENT";
  message: string;
}
export interface HostedResourceRef {
  id: string;
  version: number;
  hash: string;
  segment: string;
  mediaType: string;
}

/** Every historical version comes from the shared verifier, never an inferred update shape. */
export function hostedResourceRefs(cel: CelLog | null): HostedResourceRef[] {
  if (!cel) return [];
  verifyHistory(validateDocument(cel));
  const versions = new Map<string, number>();
  return cel.log.flatMap(({ event }) => {
    const op = event.operation;
    if (op.type !== "create" && op.type !== "update") return [];
    return (op.data.resources ?? []).map((resource) => {
      const version = (versions.get(resource.id) ?? 0) + 1;
      versions.set(resource.id, version);
      return {
        id: resource.id,
        version,
        hash: digestMultibaseSha256Hex(resource.digestMultibase) ?? "",
        segment: resource.digestMultibase,
        mediaType: resource.mediaType,
      };
    });
  });
}

/** Offline interchange only; a hosted alias still requires the SDK's independent method-log check. */
export function hostedAssetEnvelope(
  cel: CelLog | null,
  contents: Record<string, ResourceContent>,
): { envelope: AssetEnvelope } | { problem: HydrationProblem } {
  if (!cel)
    return {
      problem: {
        code: "NO_CEL",
        message: "This Original hosts no CEL 3 history.",
      },
    };
  try {
    const document = validateDocument(cel);
    const history = verifyHistory(document);
    const resources: AssetEnvelope["resources"] = [];
    for (const ref of hostedResourceRefs(document)) {
      if (contents[ref.segment] === undefined)
        return {
          problem: {
            code: "MISSING_CONTENT",
            message: `Resource “${ref.id}” v${ref.version} could not be fetched.`,
          },
        };
      resources.push({
        id: ref.id,
        version: ref.version,
        digestMultibase: ref.segment,
        content: {
          encoding: "base64",
          data: base64.encode(contentBytes(contents[ref.segment])),
        },
      });
    }
    return {
      envelope: {
        format: "originals/asset",
        version: 4,
        assetId: history.state.assetId,
        eventLog: document,
        resources,
      },
    };
  } catch {
    return {
      problem: {
        code: "INVALID_CEL",
        message: "This Original’s CEL 3 history did not verify.",
      },
    };
  }
}
