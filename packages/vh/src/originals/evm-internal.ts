/**
 * INTERNAL: `@originals/vh/internal/evm`, reachable only under the private
 * `originals-internal` export condition. EVM anchoring (originals-spec PR 59,
 * P3.9, P9.19-P9.29, P14.18-P14.22) is built and tested but unreleased until
 * the spec pins an audited anchor contract (P14.21; owner decision, 14
 * November 2026). This entry is the published `./originals` surface plus the
 * EVM modules, with the ungated verifier, builders, carried-log reader and
 * state rules, which honour an `EvmAnchorPin`. Exposing EVM anchoring later
 * (plan 011 phase 12b/12d, once 12c pins the contract) is a matter of
 * exporting this from a published entry point.
 */
export * from "./index.js";
export * from "./evm.js";
export * from "./evm-anchor.js";
export * from "./did-evm.js";
export type { EvmRuleContext } from "./profile.js";
export { verifyOriginal, verifyOriginalByAlias } from "./verify.js";
export { prepareCreateOriginal, createOriginal, prepareUpdateOriginal, updateOriginal } from "./build.js";
export { readCarriedFile } from "./carried.js";
export { originalsRules, originalsSpecialisation } from "./profile.js";
export { checkEditorChange, checkEntryState } from "./state.js";
