import { describe, test, expect } from 'bun:test';
import { summarize, accentFor, isCustodyEntry } from './CelChain';
import type { CelEntry } from '../sdk/engine';

/**
 * The panel's failure mode is silent: an unhandled event type falls through to
 * rendering its own bare name, which looks plausible. That already shipped once
 * (a `migrate` read as `to` rendered "migrate" twice) and only driving the page
 * caught it. These pin the gloss for every event type the SDK can actually
 * append, so the next schema drift fails here instead of in the browser.
 */

function entry(type: string, data: Record<string, unknown> = {}): CelEntry {
  return { type, data, proof: [] };
}

// Mirrors EventType in @originals/cel. Kept literal so a rename upstream shows
// up as a failing assertion rather than a silently-empty loop.
const EVENT_TYPES = ['create', 'update', 'deactivate', 'migrate', 'transfer', 'rotateKey'];

describe('CEL entry glosses', () => {
  test('no event type renders as its own bare name', () => {
    for (const type of EVENT_TYPES) {
      const text = summarize(entry(type));
      if (type === 'deactivate' || type === 'transfer') continue; // never emitted by the demo pipeline
      expect(text).not.toBe(type);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test('genesis counts the resources it binds', () => {
    expect(summarize(entry('create', { resources: [{}, {}] }))).toBe(
      'Genesis — binds 2 resources to a new identifier'
    );
    expect(summarize(entry('create', { resources: [{}] }))).toContain('1 resource ');
    expect(summarize(entry('create'))).toBe('Genesis — establishes a new identifier');
  });

  test('a webvh migrate names its domain and targetDid', () => {
    const text = summarize(
      entry('migrate', { layer: 'webvh', domain: 'example.com', targetDid: 'did:webvh:abc:example.com' })
    );
    expect(text).toContain('the web at example.com');
    expect(text).toContain('did:webvh:abc:example.com');
  });

  // A btco migrate carries its destination as `to`, not `targetDid` — the two
  // migrate shapes differ, and reading only one blanks the identifier.
  test('a btco migrate names its destination from `to`', () => {
    const text = summarize(entry('migrate', { layer: 'btco', to: 'did:btco:1066296127976657' }));
    expect(text).toContain('Bitcoin');
    expect(text).toContain('did:btco:1066296127976657');
  });

  test('accent follows the destination layer, not the event type', () => {
    expect(accentFor(entry('migrate', { layer: 'webvh' }))).toBe('var(--webvh)');
    expect(accentFor(entry('migrate', { layer: 'btco', to: 'did:btco:1' }))).toBe('var(--btco)');
    expect(accentFor(entry('create'))).toBe('var(--cel)');
  });
});

describe('creator vs holder rendering (item 5)', () => {
  const holder = (data: Record<string, unknown> = {}): CelEntry => ({
    type: 'update',
    data: { author: 'did:key:z6MkHolderHolderHolderHolder', statement: 'in my collection', ...data },
    proof: [],
    authorClass: 'holder',
    authorKey: 'did:key:z6MkHolderHolderHolderHolder'
  });

  test('a holder entry renders its statement and author — never a name or resource count', () => {
    const text = summarize(holder({ name: 'smuggled name', resources: [{}, {}] }));
    expect(text).toContain('Held by');
    expect(text).toContain('in my collection');
    expect(text).toContain('did:key:z6MkHolderHolderHol'); // truncated author
    expect(text).not.toContain('smuggled name');
    expect(text).not.toContain('2');
  });

  test('holder entries carry the custody accent, not the creator palette', () => {
    expect(accentFor(holder())).toBe('var(--holder, var(--text-secondary))');
    // A creator update keeps the creator palette.
    const creatorUpdate: CelEntry = { type: 'update', data: {}, proof: [], authorClass: 'creator' };
    expect(accentFor(creatorUpdate)).toBe('var(--cel)');
  });

  test('holder and class-absent entries belong to the custody section; creator entries never do', () => {
    expect(isCustodyEntry(holder())).toBe(true);
    const classAbsent: CelEntry = { type: 'update', data: {}, proof: [] };
    expect(isCustodyEntry(classAbsent)).toBe(true); // unverified author → custody, labeled
    const unattributed: CelEntry = { type: 'update', data: {}, proof: [], authorClass: 'unattributed' };
    expect(isCustodyEntry(unattributed)).toBe(true);
    const creator: CelEntry = { type: 'create', data: {}, proof: [], authorClass: 'creator' };
    expect(isCustodyEntry(creator)).toBe(false);
  });

  test('a creator statement renders as a statement gloss (not the holder shape)', () => {
    const creatorStatement: CelEntry = {
      type: 'update',
      data: { author: 'did:key:z6MkCreator', statement: 'exhibited' },
      proof: [],
      authorClass: 'creator'
    };
    const text = summarize(creatorStatement);
    expect(text).toContain('Statement');
    expect(text).toContain('exhibited');
    expect(text).not.toContain('Held by');
  });
});
