/**
 * The Originals Protocol `originals:1.0` did:vh extension: asset state rules,
 * author binding, the derived DID document, builders and fresh verification.
 * Names marked PROVISIONAL follow plan 011 section 2 until the spec decides.
 *
 * EVM anchoring (originals-spec PR 59) is not part of this entry: it is built
 * and tested but unreleased until the spec pins an audited anchor contract
 * (P14.21). Here an Original with an `anchor` member verifies as unsupported,
 * never invalid (section 14), and the builders refuse to write one. The gated
 * versions below take precedence over the star exports of the same names.
 */
export * from "./state.js";
export * from "./author.js";
export * from "./profile.js";
export * from "./build.js";
export * from "./verify.js";
export * from "./alias.js";
export * from "./bitcoin.js";
export * from "./btco.js";
export * from "./cbor.js";
export * from "./carried.js";
export {
  verifyOriginal,
  verifyOriginalByAlias,
  prepareCreateOriginal,
  createOriginal,
  prepareUpdateOriginal,
  updateOriginal,
  readCarriedFile,
  originalsRules,
  originalsSpecialisation,
  checkEditorChange,
  checkEntryState,
} from "./public-gate.js";
