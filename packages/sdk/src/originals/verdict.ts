/**
 * The one-line verdict the CLI prints, and what must be shown with it. A
 * result can be current while inscriptions after the anchor are unverifiable,
 * publications wait on them, or the head moved: those notices are never left
 * off a passing verdict (section 7, P9.15; originals-spec #51).
 */
import type { OriginalsReport } from "@originals/vh/originals";

/** The summary line: never a bare `verified` while a notice stands. */
export function verdictLine(report: Pick<OriginalsReport, "original" | "checkpoint" | "notices">, verified: boolean): string {
  const notes = report.notices.length > 0 ? ` (with notices: ${report.notices.join(", ")})` : "";
  return `${verified ? "verified" : "not verified"}${notes}: ${report.original ?? "unknown Original"} at ${report.checkpoint ?? "no checkpoint"}`;
}

/** One line per listed inscription: each unverifiable one with the signer version it names, each waiting one with what it waits on. */
export function noticeLines(report: Pick<OriginalsReport, "anchoring" | "notices">): string[] {
  const out: string[] = [];
  const a = report.anchoring;
  if (report.notices.includes("head-changed") && a?.headChange) {
    const h = a.headChange;
    const why = [
      h.resolved.length > 0 ? `resolved ${h.resolved.join(", ")}` : "",
      h.unverified.length > 0 ? `now unverifiable ${h.unverified.join(", ")}` : "",
      h.vanished.length > 0 ? `no longer on the sat ${h.vanished.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    out.push(`head changed from ${h.previous ?? "none"} to ${h.current} (${why})`);
  }
  for (const u of a?.unverifiable ?? []) out.push(`unverifiable inscription ${u.inscription}: names ${u.signer} at ${u.signerVersionId}, not verified here`);
  for (const i of a?.ignored ?? []) if (i.reason === "waiting-for-earlier-unverifiable") out.push(`inscription ${i.inscription} waits on ${i.waitingOn}`);
  return out;
}
