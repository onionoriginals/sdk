/**
 * U5 / R7, R8, R9 — every demo string must be true for the tier that renders
 * it.
 *
 * This file replaces `demo-coming-soon-content.test.ts`, which asserted that
 * step 3's description contains "coming" and that a `demo.comingSoon` string
 * exists. Both assertions pinned copy that had become false: the signed-in
 * path inscribes on Bitcoin mainnet today, so "coming soon … once testnet4
 * ordinals support ships" was wrong about the status AND the network, printed
 * unconditionally above a live money button.
 */
import { describe, test, expect } from 'bun:test';
import {
  completionCopy,
  demoSubhead,
  inscribeStepView,
  publishDurabilityNote,
  resolvedCopy,
} from './Demo';
import { demoTier } from '../sdk/network-flag';
import { demo } from '../content';

/** Every string in the copy tree, keyed by its dotted path. */
function copyPaths(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => copyPaths(v, `${prefix}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => copyPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

/**
 * Copy that only a NON-mainnet tier can reach, and is allowed to name the
 * thing that tier actually is. Everything else in `demo` is reachable by a
 * signed-in visitor on the mainnet deploy.
 *  - `simulated`, `subheadSimulated`, `done.simulated` — the anonymous tier.
 *  - `testnet4` — rendered only when the build flag is testnet4 (`real &&
 *    network !== 'mainnet'`); a mainnet build never reaches it.
 */
const NON_MAINNET_PREFIXES = ['simulated', 'subheadSimulated', 'done.simulated', 'testnet4'];

const mainnetReachable = copyPaths(demo).filter(
  ([path]) => !NON_MAINNET_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`))
);

describe('mainnet-reachable copy', () => {
  test('the copy tree is actually being walked', () => {
    expect(mainnetReachable.length).toBeGreaterThan(30);
  });

  test('nothing a mainnet visitor can read claims the Bitcoin steps are mocked', () => {
    for (const [path, value] of mainnetReachable) {
      expect(`${path}: ${value}`).not.toMatch(/mock/i);
    }
  });

  test('nothing a mainnet visitor can read claims the step is coming soon', () => {
    for (const [path, value] of mainnetReachable) {
      expect(`${path}: ${value}`).not.toMatch(/coming soon/i);
    }
  });

  test('nothing a mainnet visitor can read puts the inscription on testnet4', () => {
    for (const [path, value] of mainnetReachable) {
      expect(`${path}: ${value}`).not.toMatch(/testnet|tBTC|faucet/i);
    }
  });

  test('no demo copy reintroduces did:peer', () => {
    for (const [path, value] of copyPaths(demo)) {
      expect(`${path}: ${value}`).not.toContain('did:peer');
    }
  });

  test('the dead copy this unit removed is gone', () => {
    // Nothing rendered `comingSoon` or `inscribeGate.mockNote` once step 3
    // became tier-aware (U2); the testnet-only funding/signing labels were
    // never rendered at all.
    expect('comingSoon' in demo).toBe(false);
    expect('inscribeGate' in demo).toBe(false);
    expect('mockNote' in demo.testnet4).toBe(false);
    expect('fundingLabel' in demo.testnet4).toBe(false);
    expect('signingLabel' in demo.testnet4).toBe(false);
  });
});

describe('step 3 states its own tier', () => {
  test('the signed-in mainnet step is a real Bitcoin action paid from the user’s deposit', () => {
    const view = inscribeStepView(demoTier('mainnet', true).real, 'mainnet');
    expect(view.simulated).toBe(false);
    expect(view.description).toMatch(/bitcoin/i);
    expect(view.description).not.toMatch(/mock|coming soon|testnet/i);
    // R8: it must name whose money and whose key, since this is the live one.
    expect(view.description).toMatch(/your own|your key|your browser/i);
  });

  test('the anonymous step names itself a simulation', () => {
    const view = inscribeStepView(demoTier('mainnet', false).real, 'mainnet');
    expect(view.simulated).toBe(true);
    expect(view.description).toMatch(/simulat|mock/i);
    expect(view.label).toBe(demo.simulated.action);
  });

  test('a testnet4 build says testnet4, and the mainnet strings never do', () => {
    const view = inscribeStepView(demoTier('testnet4', true).real, 'testnet4');
    expect(view.simulated).toBe(false);
    expect(view.description).toMatch(/testnet4/i);
    expect(demo.steps[2].description).not.toMatch(/testnet/i);
  });
});

describe('the section subhead', () => {
  test('the signed-in tier’s subhead does not hand the Bitcoin steps to a mock', () => {
    expect(demoSubhead(true)).not.toMatch(/mock|coming soon|testnet/i);
    expect(demoSubhead(true)).toMatch(/bitcoin/i);
  });

  test('the anonymous tier’s subhead says the last step is simulated', () => {
    expect(demoSubhead(false, 'mainnet')).toMatch(/simulat|mock/i);
    expect(demoSubhead(false, 'off')).toMatch(/simulat|mock/i);
  });

  test('only a build with a real path invites the visitor to sign in for one', () => {
    expect(demoSubhead(false, 'mainnet')).toMatch(/sign in/i);
    // On a mock build, signing in changes nothing — `demoTier` keeps every
    // visitor simulated — so the invitation would be its own false promise.
    expect(demoSubhead(false, 'off')).not.toMatch(/sign in/i);
    expect(demoTier('off', true).real).toBe(false);
  });
});

describe('completion state', () => {
  test('a real run may name the satoshi, the transaction and the explorer', () => {
    const done = completionCopy(false);
    expect(done.lead.length).toBeGreaterThan(0);
    expect(done.explorerLabel).toBeTruthy();
    expect(done.explorerLabel!).toMatch(/mempool\.space/);
  });

  test('a simulated run asserts no real satoshi, no real transaction, no explorer', () => {
    const done = completionCopy(true);
    // The strings sit either side of the mock provider's numbers, so they are
    // what decides whether a visitor reads them as real.
    for (const value of [done.lead, done.beforeSatoshi, done.beforeTx, done.after]) {
      expect(value).not.toMatch(/mempool|explorer|on-chain|anchored/i);
    }
    expect(done.explorerLabel).toBeNull();
    // It must say outright that nothing was broadcast.
    expect(`${done.lead} ${done.after}`).toMatch(/simulat|mock/i);
    expect(done.after).toMatch(/nothing was broadcast|no sats moved|does not exist|neither exists/i);
  });

  test('the two tiers do not share a completion string', () => {
    const real = completionCopy(false);
    const sim = completionCopy(true);
    expect(sim.lead).not.toBe(real.lead);
    expect(sim.beforeSatoshi).not.toBe(real.beforeSatoshi);
    expect(sim.beforeTx).not.toBe(real.beforeTx);
    expect(sim.after).not.toBe(real.after);
  });
});

describe('the published log’s durability (R7)', () => {
  test('an anonymous visitor gets the temporary-log caveat; a signed-in one does not', () => {
    expect(publishDurabilityNote(false)).toBe(demo.hosting.temporaryNote);
    expect(publishDurabilityNote(true)).toBeNull();
  });

  test('the caveat names both halves: temporary, and shared with every other visitor', () => {
    const note = demo.hosting.temporaryNote;
    expect(note).toMatch(/temporar|dropped|expire|a few hours|couple of hours/i);
    expect(note).toMatch(/sign in|signed in/i);
  });

  test('it is rendered in the publish step, not only after the log exists', async () => {
    // No DOM test infrastructure here, so this asserts placement in the
    // source: the note has to sit inside the steps list (which renders from
    // first paint) rather than only inside the post-publish `demo-resolved`
    // block, where U8 first put it. "Before they publish" is the requirement.
    const source = await Bun.file(new URL('./Demo.tsx', import.meta.url)).text();
    const stepsAt = source.indexOf('demo.steps.map');
    const resolvedAt = source.indexOf('demo-resolved-head');
    expect(stepsAt).toBeGreaterThan(0);
    expect(resolvedAt).toBeGreaterThan(stepsAt);
    // Rendered inside the steps list, which is on screen from first paint.
    const noteAt = source.indexOf('{durabilityNote}', stepsAt);
    expect(noteAt).toBeGreaterThan(stepsAt);
    expect(noteAt).toBeLessThan(resolvedAt);
    // …and the note is no longer only in the post-publish block.
    expect(source.slice(resolvedAt)).not.toContain('hosting.temporaryNote');
  });

  test('the anonymous resolved heading does not promise a permanent home', () => {
    expect(resolvedCopy(false).heading).not.toBe(resolvedCopy(true).heading);
    expect(resolvedCopy(false).heading).toMatch(/for now|temporar/i);
    expect(resolvedCopy(true).heading).toMatch(/live at this origin/i);
  });
});

/**
 * U15's work, re-asserted here so a later copy pass cannot quietly undo it:
 * the deposit screen describes mechanics, never the legal character of the
 * arrangement, and it is printed above the address a stranger sends mainnet
 * BTC to.
 */
describe('deposit copy stays mechanical (U15)', () => {
  test('no deposit string asserts a custody status', () => {
    for (const [path, value] of copyPaths(demo.deposit)) {
      expect(`${path}: ${value}`).not.toMatch(/custod/i);
    }
  });

  test('the non-refundable line still says what actually happens to the fee', () => {
    expect(demo.deposit.nonRefundable).toMatch(/cannot be reversed|irreversible/i);
    expect(demo.deposit.nonRefundable).not.toMatch(/custod/i);
  });
});
