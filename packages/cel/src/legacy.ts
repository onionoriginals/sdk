/**
 * Previous-format (pre-CEL-3) CEL surface — import from '@originals/cel/legacy'.
 *
 * Everything re-exported here predates the CEL 3 profile and is retained only
 * for the previous-format lifecycle and its regression tests (see
 * docs/history/previous-sdk/CLAUDE.md). None of it is the compatibility path
 * for CEL 3 / SDK 3.0, and it is deliberately absent from the package root so
 * a new consumer importing '@originals/cel' cannot reach a previous-format
 * writer and mistake it for the canonical one (issue #597). Use
 * '@originals/cel/v3' for new histories.
 *
 * - `PeerCelManager` / `WebVHCelManager` / `BtcoCelManager`, and `OriginalsCel`
 *   (which wraps all three and exposes the same `create` / `update` /
 *   `migrate` writer surface through one class), are the previous-format
 *   layer writers.
 * - `createEventLog` / `appendEvent` / `updateEventLog` / `deactivateEventLog`
 *   / `witnessEvent` / `verifyEventLog` and the custody-fold helpers are the
 *   lower-level algorithms those managers delegate to. They move here too:
 *   leaving them at the root would let a consumer reassemble the same
 *   previous-format writer out of "primitive" pieces after the managers move.
 * - `celSignerFromKeyPair` / `createKeyStoreCelSigner` / `currentControllerVm`
 *   / `hexSha256ToDigestMultibase` build proofs over the previous-format
 *   canonicalizer's preimage (below) and only make sense with it.
 * - `canonicalizeEvent` and its derivatives are kept byte-for-byte unchanged
 *   (see issue #599): previous-format signed history was produced against
 *   these exact preimages, and changing them would invalidate every
 *   already-signed event log rather than fix anything. New code must use
 *   `@originals/cel/v3`, whose `canonicalizeValue` is RFC 8785-conformant.
 */
export * from './layers/index.js';
export * from './OriginalsCel.js';
export * from './algorithms/index.js';
export {
  canonicalizeEvent,
  witnessSigningBytes,
  canonicalizeEntryForChain,
  committedFields,
  celProofSigningInput,
} from './canonicalize.js';
export {
  celSignerFromKeyPair,
  createKeyStoreCelSigner,
  currentControllerVm,
  hexSha256ToDigestMultibase,
} from './signerAdapter.js';
