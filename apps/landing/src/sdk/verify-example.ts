/** Verify the bundled CEL 3 example locally. Its static proofs do not claim live DNS or Bitcoin publication. */
import "../shims/buffer-global";
import { validateDocument, verifyHistory } from "@originals/sdk/cel";
import { verifyOriginal } from "./verify-original";
import manifest from "../../public/example/manifest.json";
import artworkSvg from "../../public/example/artwork.svg?raw";
import didLogRaw from "../../public/example/did-log.jsonl?raw";
import celLogJson from "../../public/example/cel-log.json";

export interface ExampleCheck {
  id: "hash" | "log" | "cel";
  ok: boolean;
  detail: string;
}
export interface VerifiedExample {
  title: string;
  medium: string;
  artworkDataUri: string;
  dids: { cel: string; webvh: string };
  profile: string;
  issuedAt?: string;
  checks: ExampleCheck[];
  allOk: boolean;
}
export async function verifyExample(): Promise<VerifiedExample> {
  const document = validateDocument(celLogJson);
  const history = verifyHistory(document, {
    expectedDid: manifest.dids["did:cel"],
  });
  const checks = await verifyOriginal({
    did: manifest.dids["did:webvh"],
    logEntries: didLogRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    celLog: document,
    resourceBytes: new TextEncoder().encode(artworkSvg),
    declaredHash:
      manifest.resources.find((r) => r.id === "artwork.svg")?.hash ?? null,
  });
  return {
    title: manifest.title,
    medium: manifest.style,
    artworkDataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artworkSvg)}`,
    dids: { cel: history.state.assetId, webvh: manifest.dids["did:webvh"] },
    profile: "originals/cel/3",
    issuedAt: history.state.createdAt,
    checks,
    allOk: checks.every((check) => check.ok),
  };
}
