import { describe, test, expect } from 'bun:test';
import { hero, protocol, site, why } from './content';

/**
 * What the page is allowed to claim (protocol design review, 2026-08).
 *
 * Two overclaims had to come out, and both are the kind that creep back in
 * during a copy pass because they read better than the truth:
 *
 * 1. "Proof you made it." The protocol proves that a key signed this hash,
 *    that Bitcoin timestamped it, and that this key anchored this log first.
 *    It cannot prove authorship — anyone can inscribe someone else's file, and
 *    identity is the hash of the genesis event, so a thief's log verifies just
 *    as green as the creator's. Priority of publication is the real claim, and
 *    it is strong enough to sell.
 *
 * 2. "Without trusting you, us, or any platform." Every on-chain fact in the
 *    verify path — which inscriptions sit on a sat, their block heights, their
 *    content — comes from an Ordinals indexer. There is no header chain and no
 *    SPV anywhere in it, so a dishonest index can lie undetectably. The
 *    signature checks are genuinely trustless; the Bitcoin reads are not, and
 *    the page has to say which is which.
 *
 * These assert the shape of the claim, not the exact wording — rewrite the
 * copy freely, just not back into either of those.
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

describe('the page claims first publication, not authorship', () => {
  test('no copy claims the protocol proves who made the work', () => {
    // "who made it" / "you made it" are the specific phrasings that were live.
    const offenders = allCopy().filter((s) => /\b(you|who) made it\b/i.test(s));
    expect(offenders).toEqual([]);
  });

  test('the headline and title lead with being first', () => {
    expect(hero.headline.toLowerCase()).toContain('first');
    expect(site.title.toLowerCase()).toContain('first');
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

describe('the page does not imply did:cel is a standard', () => {
  test('the protocol section says which methods are registered and which is ours', () => {
    // "Built on W3C DIDs" covers did:webvh and did:btco. did:cel is
    // unregistered, has no Universal Resolver driver, and its verification
    // algorithm is ours — the first thing a W3C reader checks.
    expect(protocol.standardsNote).toMatch(/did:cel/);
    expect(protocol.standardsNote).toMatch(/not registered|unregistered/i);
  });
});
