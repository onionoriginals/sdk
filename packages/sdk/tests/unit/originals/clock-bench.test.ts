/**
 * The InscriptionClock benchmark's scenarios on a smaller chain (#973): the
 * request counts a cold start, warm reads and restarts cost, asserted exactly
 * so a change that replays genesis or reads one header per request fails.
 * Wall time is not asserted; `scripts/bench-inscription-clock.ts` records it
 * at mainnet scale.
 */
import { describe, expect, test } from "bun:test";
import { runBenchmark } from "../../../scripts/bench-inscription-clock.js";

describe("InscriptionClock cost (#973, P9.15)", () => {
  test("cold start is batched; warm reads and restarts cost in proportion to new or reorganised blocks", async () => {
    const { rows, chain } = await runBenchmark({ blocks: 20_000, batch: 500, single: true });
    const cost = Object.fromEntries(rows.map((r) => [r.scenario, { requests: r.requests, headers: r.headers }]));
    expect(cost).toEqual({
      "cold start, batched": { requests: 40, headers: 20_000 },
      "save state": { requests: 0, headers: 0 },
      "warm read x10,000, known blocks": { requests: 0, headers: 0 },
      // The boundary check (#971) and one batch.
      "warm read, 1 new block": { requests: 2, headers: 2 },
      // The genesis check against the saved network.
      "restart, read a known block": { requests: 1, headers: 1 },
      "restart, then 6 new blocks": { requests: 2, headers: 7 },
      // Genesis, the boundary, three gallop probes, two bisection probes, one batch of the 9 new blocks.
      "restart across a 6-block reorg (+3)": { requests: 8, headers: 16 },
      "independent rebuild": { requests: 41, headers: 20_010 },
      "cold start, one request per header": { requests: 20_010, headers: 20_010 },
      "cold start, default budget": { requests: 10_000, headers: 10_000 },
    });
    expect(chain.decreasing()).toBeGreaterThan(1000);
  });
});
