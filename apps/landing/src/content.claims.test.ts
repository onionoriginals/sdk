import { describe, test, expect } from 'bun:test';
import { hero, protocol, site, why } from './content';

/**
 * What the page is allowed to claim (protocol design review, 2026-08;
 * narrowed by hostile-audit finding M11 / issue #605, 2026-09-11).
 *
 * The August review treated "priority of publication" (being first) as a
 * claim distinct from authorship and strong enough to sell. The September
 * audit found that claim itself overstated the evidence: Bitcoin resolution
 * is sat-scoped (`crossSatCanonicality: 'unknown'`), so the protocol cannot
 * rule out a competing creation signed on a different sat, and publishing to
 * the web (did:webvh) and inscribing on Bitcoin (did:btco) are separate,
 * sequential lifecycle steps, never simultaneous. So the page may no longer
 * claim global "first", or that Bitcoin anchoring happens the moment you
 * publish. What it can honestly claim: a signed, byte-exact history that
 * anyone can re-verify, later anchored and ordered on Bitcoin.
 *
 * Three overclaims had to come out, and all three are the kind that creep
 * back in during a copy pass because they read better than the truth:
 *
 * 1. "Proof you made it." The protocol proves that a key signed this hash and
 *    that Bitcoin later accepted and ordered it. It cannot prove authorship —
 *    anyone can inscribe someone else's file, and identity is the hash of the
 *    genesis event, so a thief's log verifies just as green as the creator's.
 *
 * 2. "Without trusting you, us, or any platform." Every on-chain fact in the
 *    verify path — which inscriptions sit on a sat, their block heights, their
 *    content — comes from an Ordinals indexer. There is no header chain and no
 *    SPV anywhere in it, so a dishonest index can lie undetectably. The
 *    signature checks are genuinely trustless; the Bitcoin reads are not, and
 *    the page has to say which is which.
 *
 * 3. "Published it first" / "who was first" / Bitcoin anchoring "the moment
 *    you publish". A sat-scoped index cannot prove there is no competing
 *    creation elsewhere, and publish and inscribe are different steps at
 *    different times — so neither global priority nor instant anchoring is
 *    something verification actually shows.
 *
 * These assert the shape of the claim, not the exact wording — rewrite the
 * copy freely, just not back into any of those.
 */

/** Every string the page ships, flattened. */
function allCopy(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk({ hero, site, why });
  return out;
}

describe('the page claims a signed history, not authorship or global priority', () => {
  test('no copy claims the protocol proves who made the work', () => {
    // "who made it" / "you made it" are the specific phrasings that were live.
    const offenders = allCopy().filter((s) => /\b(you|who) made it\b/i.test(s));
    expect(offenders).toEqual([]);
  });

  test('no copy claims global first-publication (#605)', () => {
    // Bitcoin resolution is sat-scoped (`crossSatCanonicality: 'unknown'`):
    // the protocol cannot rule out a competing creation signed on another
    // sat, so "first" / "who was first" overstates what it actually proves.
    const offenders = allCopy().filter((s) => /\bpublished it first\b|\bwho was first\b|\bprove(?:s)? .*\bfirst\b/i.test(s));
    expect(offenders).toEqual([]);
  });

  test('no copy claims Bitcoin anchoring happens the moment you publish (#605)', () => {
    // Publishing to the web (did:webvh) and inscribing on Bitcoin (did:btco)
    // are separate, sequential lifecycle steps, never simultaneous.
    const offenders = allCopy().filter((s) => /the moment you publish/i.test(s));
    expect(offenders).toEqual([]);
  });
});

describe('the page states the indexer trust assumption', () => {
  test('nothing promises verification without trusting anyone', () => {
    const offenders = allCopy().filter((s) => /without trusting/i.test(s));
    expect(offenders).toEqual([]);
  });

  test('the provenance card names the index the Bitcoin reads depend on', () => {
    const card = why.cards.find((c) => /hand to anyone/i.test(c.title));
    expect(card).toBeDefined();
    // Named plainly, not softened into "decentralized infrastructure".
    expect(card!.body).toMatch(/ordinals index/i);
  });

  test('surviving our disappearance is conditioned on inscribing and keeping the log', () => {
    // Pre-anchor assets die with the host — the page may not imply otherwise.
    const card = why.cards.find((c) => /vanish/i.test(c.body));
    expect(card).toBeDefined();
    expect(card!.body).toMatch(/inscribe/i);
    expect(card!.body).toMatch(/copy of the log/i);
  });
});

describe('the page separates CEL provenance from DID methods', () => {
  test('the protocol section names ni identity and disclaims did:cel implementation', () => {
    expect(protocol.standardsNote).toMatch(/Cryptographic Event Logs/);
    expect(protocol.standardsNote).toMatch(/ni: hash identifiers/);
    expect(protocol.standardsNote).toMatch(/did:cel method is not defined or implemented by Originals/);
    expect(protocol.standardsNote).not.toMatch(/did:cel is ours/);
  });
});
