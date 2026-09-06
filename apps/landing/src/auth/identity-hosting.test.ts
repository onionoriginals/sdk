/**
 * Source-level guards for two wiring mistakes that type-check cleanly, have no
 * DOM harness to catch them, and lose the user's identity when made. Both were
 * live in the first cut of the Turnkey-custody change.
 */
import { describe, test, expect } from 'bun:test';

const read = async (p: string) => await Bun.file(new URL(p, import.meta.url)).text();

describe('the identity log goes to durable storage', () => {
  /**
   * `/api/host` is the DEMO host: in-memory, ~2h TTL, LRU eviction, and
   * unauthenticated. A did:webvh log cannot be regenerated — a rebuild gets a
   * new SCID — so putting it there means the identity silently expires and can
   * never come back on another device, which is the whole point of custody.
   */
  test('useAuth hosts the DID on the authenticated durable store', async () => {
    const source = await read('./useAuth.tsx');
    expect(source).toMatch(/DurableHostingStorageAdapter/);
    expect(source).not.toMatch(/HttpHostingStorageAdapter/);
  });

  test('the durable adapter really targets the authenticated route', async () => {
    const source = await read('../sdk/durable-hosting-adapter.ts');
    expect(source).toMatch(/\/api\/originals\/host\//);
    expect(source).toMatch(/credentials: 'same-origin'/);
  });
});

describe('the panel cannot show one account the previous account’s DID', () => {
  /**
   * IdentityPanel outlives a sign-out/sign-in, so the effect keyed on the
   * sub-org must clear FIRST. Setting state only on a successful load leaves
   * the old DID rendered — and copyable — under the new account's name.
   */
  test('the identity effect clears state before it loads', async () => {
    const source = await read('../components/IdentityPanel.tsx');
    const effect = source.slice(source.indexOf('useEffect(() => {'), source.indexOf('loadIdentity()'));
    expect(effect).toMatch(/setDid\(null\)/);
    expect(effect.indexOf('setDid(null)')).toBeGreaterThan(-1);
    // And the success branch must not re-introduce a truthiness guard: a load
    // returning null for the new account has to clear, not preserve.
    expect(source).not.toMatch(/if \(!cancelled && existing\)/);
  });
});
