/**
 * Legacy CEL layer managers — import from '@originals/cel/legacy'.
 *
 * `PeerCelManager`, `WebVHCelManager`, and `BtcoCelManager` predate the CEL 3
 * profile and are retained only for the previous-format lifecycle and its
 * regression tests (see docs/history/previous-sdk/CLAUDE.md). They are not
 * the compatibility path for CEL 3 / SDK 3.0 and are deliberately absent
 * from the package root so a new consumer importing '@originals/cel' cannot
 * mistake them for the canonical writer. Use '@originals/cel/v3' for new
 * histories.
 */
export * from './layers/index.js';
