/** Retrieval deadlines are implementation limits (section 6), not proof of verification. */
import { expect, spyOn, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { Retrieval } from "../../../src/originals/retrieval.js";

test("an optional request exhausting the operation allowance cannot swallow an early timer as a missing file", async () => {
  // Timer delivery and wall-clock sampling need not agree to the millisecond.
  // Freeze the sampled clock to reproduce the early-timer CI race deterministically.
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  const timers: Array<() => void> = [];
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    timers.push(callback);
    return 0;
  }) as typeof setTimeout);
  const retrieval = new Retrieval(() => new Promise(() => {}), { timeoutMs: 10, requestTimeoutMs: 100 });
  try {
    const request = retrieval.get("https://example.com/optional", { required: false, archive: false });
    // Deliver the request timer just before the whole-operation timer.
    timers[1]();
    await expect(request).rejects.toMatchObject({
      category: "limit-exceeded", code: "RETRIEVAL_BUDGET_EXCEEDED", details: { limit: "time", timeoutMs: 10 },
    });
    // Once the operation expires, another request must not be issued either.
    await expect(retrieval.get("https://example.com/next", { required: true, archive: false })).rejects.toMatchObject({ code: "RETRIEVAL_BUDGET_EXCEEDED" });
  } finally { retrieval.close(); schedule.mockRestore(); now.mockRestore(); }
});

test("a per-request timeout may omit an optional file without exhausting the operation", async () => {
  const retrieval = new Retrieval(() => new Promise(() => {}), { timeoutMs: 5_000, requestTimeoutMs: 5 });
  try {
    expect(await retrieval.get("https://example.com/optional", { required: false, archive: false })).toBeUndefined();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await retrieval.get("https://example.com/resource", { required: true, archive: false, fetch: async () => bytes })).toEqual(bytes);
    await expect(retrieval.get("https://example.com/required", { required: true, archive: false })).rejects.toBeInstanceOf(OriginalsError);
  } finally { retrieval.close(); }
});
