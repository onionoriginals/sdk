import { describe, test, expect } from 'bun:test';
import { skolemizeExpandedJsonLd } from '../../../../src/vc/utils/selective-disclosure';

/**
 * Regression tests for issue #316: the skolemization counter must be threaded
 * through the whole recursion as ONE shared mutable object. The buggy port
 * copied `count` at each level and wrote it back only one level up, so counter
 * increments made beneath a node with an explicit @id (which never calls
 * generateId) were lost and a later sibling branch reused the same skolem URN —
 * collapsing two distinct blank nodes into one after deskolemization.
 */

/** Collect every generated (anonymous) skolem @id in a skolemized document. */
function collectGeneratedIds(node: any, randomString: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectGeneratedIds(item, randomString, out);
  } else if (node && typeof node === 'object') {
    const id = node['@id'];
    if (typeof id === 'string' && id.includes(`_${randomString}_`)) out.push(id);
    for (const [key, value] of Object.entries(node)) {
      if (key !== '@id') collectGeneratedIds(value, randomString, out);
    }
  }
  return out;
}

describe('skolemizeExpandedJsonLd anonymous-node counter (issue #316)', () => {
  test('counter increments beneath an @id-bearing node propagate to sibling branches', () => {
    // Branch `a` holds a node with an explicit @id whose descendant is
    // anonymous; branch `b` holds another anonymous node. With the per-level
    // counter copy, both anonymous nodes received `_R_0`.
    const result = skolemizeExpandedJsonLd(
      [{
        '@id': 'urn:uuid:root',
        a: [{ '@id': 'urn:root2', child: [{ v: 'x' }] }],
        b: [{ v: 'y' }]
      }],
      { randomString: 'R', count: 0 }
    );

    const ids = collectGeneratedIds(result, 'R');
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('id-less root with anonymous nodes across nested branches gets unique ids', () => {
    // Mirrors an id-less credential: the root itself is anonymous, an
    // @id-bearing subject holds anonymous descendants, and a sibling branch is
    // anonymous too. Every generated skolem id must be distinct.
    const result = skolemizeExpandedJsonLd(
      [{
        subject: [{
          '@id': 'did:example:subject',
          employment: [{ employer: [{ name: [{ '@value': 'Acme' }] }] }]
        }],
        evidence: [{ note: [{ '@value': 'anonymous branch' }] }]
      }],
      { randomString: 'R', count: 0 }
    );

    // root + employment + employer + evidence = 4 anonymous nodes
    const ids = collectGeneratedIds(result, 'R');
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  test('explicit blank-node ids are preserved and do not consume the counter', () => {
    const result = skolemizeExpandedJsonLd(
      [{ '@id': '_:b99', child: [{ v: 'x' }] }],
      { urnScheme: 'custom-scheme', randomString: 'R', count: 0 }
    );
    expect(result[0]['@id']).toBe('urn:custom-scheme:b99');
    const ids = collectGeneratedIds(result, 'R');
    expect(ids).toEqual(['urn:custom-scheme:_R_0']);
  });
});
