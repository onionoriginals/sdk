/**
 * Issue #597 — the previous-format writer surface (PeerCelManager /
 * WebVHCelManager / BtcoCelManager, OriginalsCel which wraps all three, the
 * event-log algorithms those managers delegate to, and the previous-format
 * signer/canonicalizer helpers) must not be reachable from the package root,
 * or a new consumer could reach a previous-format writer and mistake it for
 * the canonical CEL 3 one. A regression that only checked the three manager
 * class names missed exactly this: `OriginalsCel` wraps them and stayed
 * exported, and the underlying algorithms/signer helpers could reconstruct
 * the same writer surface out of "primitive" pieces even without the named
 * managers. This test covers every name in that surface, not just the three
 * class names, and asserts the whole surface is reachable from
 * '@originals/cel/legacy' instead.
 */
import { describe, test, expect } from 'bun:test';
import * as celRoot from '../../src/index';
import * as celLegacy from '../../src/legacy';

const PREVIOUS_FORMAT_WRITER_SURFACE = [
  // The three layer managers and the class that wraps all of them.
  'PeerCelManager',
  'WebVHCelManager',
  'BtcoCelManager',
  'OriginalsCel',
  // The event-log algorithms the managers (and OriginalsCel) delegate to.
  'createEventLog',
  'appendEvent',
  'updateEventLog',
  'deactivateEventLog',
  'verifyEventLog',
  'witnessEvent',
  'classifyLogEntries',
  'claimedSignerDid',
  'beginCustodyFold',
  'custodyFoldStep',
  'finishCustodyFold',
  'verifyDidKeyEd25519Proof',
  'selectNewestAnchorInscription',
  // The previous-format signer, built on the previous-format canonicalizer.
  'celSignerFromKeyPair',
  'createKeyStoreCelSigner',
  'currentControllerVm',
  'hexSha256ToDigestMultibase',
  // The previous-format canonicalizer itself (issue #599): not RFC 8785,
  // silently drops an own `__proto__` member.
  'canonicalizeEvent',
  'witnessSigningBytes',
  'canonicalizeEntryForChain',
  'committedFields',
  'celProofSigningInput',
] as const;

describe('issue #597: previous-format writer surface is legacy-only', () => {
  for (const name of PREVIOUS_FORMAT_WRITER_SURFACE) {
    test(`'${name}' is not exported from the @originals/cel root`, () => {
      expect((celRoot as Record<string, unknown>)[name]).toBeUndefined();
    });

    test(`'${name}' is exported from @originals/cel/legacy`, () => {
      expect((celLegacy as Record<string, unknown>)[name]).toBeDefined();
    });
  }

  test('the CEL 3 surface is unaffected: canonicalizeValue stays at the root', () => {
    // celV3 is re-exported as a namespace from the root; spot-check it is
    // still present and untouched by the legacy-surface move.
    expect((celRoot as { celV3?: { canonicalizeValue?: unknown } }).celV3?.canonicalizeValue).toBeDefined();
  });
});
