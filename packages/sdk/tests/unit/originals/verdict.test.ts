import { describe, expect, test } from "bun:test";
import type { OriginalsReport } from "@originals/vh/originals";
import { noticeLines, verdictLine } from "../../../src/originals/verdict.js";

/** The parts of a report the CLI's summary reads, for an anchored Original with notices. */
function report(notices: OriginalsReport["notices"]): Pick<OriginalsReport, "original" | "checkpoint" | "notices" | "anchoring"> {
  return {
    original: "did:vh:QmOriginal",
    checkpoint: "3-QmHead",
    notices,
    anchoring: {
      unverifiable: [{ sat: "did:btco:reg:5", inscription: "u1i0", versionId: "4-QmA", signer: "did:webvh:Qm:host", signerVersionId: "5-QmNew" }],
      ignored: [
        { sat: "did:btco:reg:5", inscription: "u1i0", versionId: "4-QmA", reason: "later-inscription-unverifiable" },
        { sat: "did:btco:reg:5", inscription: "w1i0", versionId: "4-QmB", reason: "waiting-for-earlier-unverifiable", waitingOn: "u1i0" },
      ],
      headChange: null,
    } as unknown as OriginalsReport["anchoring"],
  };
}

describe("C12-188: a passing verdict is shown with its notices (section 7, P9.15)", () => {
  test("never a bare verified while a notice stands, and each listed inscription is named", () => {
    expect(verdictLine(report([]), true)).toBe("verified: did:vh:QmOriginal at 3-QmHead");
    const r = report(["unverifiable-inscriptions", "publications-waiting"]);
    expect(verdictLine(r, true)).toBe("verified (with notices: unverifiable-inscriptions, publications-waiting): did:vh:QmOriginal at 3-QmHead");
    expect(noticeLines(r)).toEqual([
      "unverifiable inscription u1i0: names did:webvh:Qm:host at 5-QmNew, not verified here",
      "inscription w1i0 waits on u1i0",
    ]);
  });
});
