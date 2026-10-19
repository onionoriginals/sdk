/**
 * Verify the bundled "First Light" example in this tab: a real Originals
 * Protocol evidence package (scripts/make-example.ts), checked with the SDK's
 * own reader, with no key and no network. It is a local Original; it does not
 * claim to be published on the web or recorded on Bitcoin.
 */
import { MemoryStore, OriginalsSDK, readEvidence } from "@originals/sdk/originals";
import { FIRST_LIGHT, FIRST_LIGHT_ZIP_BASE64 } from "./example-evidence";

export interface ExampleCheck {
  id: "hash" | "history" | "author";
  ok: boolean;
  detail: string;
}

export interface VerifiedExample {
  title: string;
  medium: string;
  artworkDataUri: string;
  dids: { original: string; author: string };
  profile: string;
  issuedAt?: string;
  checks: ExampleCheck[];
  allOk: boolean;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function verifyExample(now: number = Date.now()): Promise<VerifiedExample> {
  const zip = decodeBase64(FIRST_LIGHT_ZIP_BASE64);
  const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => now });
  const { report } = await reader.load(zip);
  const artwork = report.resources.versions.find((v) => v.resource === "artwork.svg");
  const contents = readEvidence(zip);
  const svg = artwork ? new TextDecoder().decode(contents.bytes[artwork.digest] ?? new Uint8Array()) : "";
  const metadata = report.resources.versions.find((v) => v.resource === "metadata.json");
  const style = metadata ? (JSON.parse(new TextDecoder().decode(contents.bytes[metadata.digest])) as { style?: string }).style : undefined;
  const checks: ExampleCheck[] = [
    {
      id: "hash",
      ok: report.resources.status === "available",
      detail: report.resources.versions.map((v) => `${v.resource} v${v.version}: ${v.bytes}`).join("; "),
    },
    {
      id: "history",
      ok: report.history.status === "valid" && report.original === FIRST_LIGHT.original,
      detail: report.history.failure?.message ?? `${report.history.entries} entr${report.history.entries === 1 ? "y" : "ies"} verified up to ${report.checkpoint}`,
    },
    {
      id: "author",
      ok: report.authorBinding.status === "valid" && report.identityEvidence.status === "complete",
      detail: `Signed by an author key of ${report.identityEvidence.author ?? "an unknown DID"}`,
    },
  ];
  return {
    title: report.state?.name ?? "First Light",
    medium: style ?? "",
    artworkDataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    dids: { original: report.original ?? FIRST_LIGHT.original, author: report.identityEvidence.author ?? FIRST_LIGHT.author },
    profile: report.profile,
    issuedAt: undefined,
    checks,
    allOk: checks.every((c) => c.ok),
  };
}
