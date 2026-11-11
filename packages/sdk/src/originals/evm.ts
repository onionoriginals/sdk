/**
 * `@originals/sdk/originals/evm`: EVM anchoring adapters (originals-spec PR 59,
 * P9.19-P9.29, P14.18-P14.22). EXPERIMENTAL: the spec pins no anchor contract
 * (P14.21), so every call takes an `EvmAnchorPin` the caller supplies, and
 * nothing built on it supports an interoperability claim. Browser-safe.
 *
 * - `readEvmToken`: the evidence `@originals/vh` verifies (`EvmTokenEvidence`).
 * - `mintEvmToken`, `prepareEvmPublication`, `submitEvmPublication`,
 *   `evmPublicationStatus`: writing through an injected wallet.
 * - `evmGenesisNotice`, `evmMoveNotice`, `evmPublicationNotice`: what the
 *   author is told first (P9.27, P9.29, P9.18).
 */
export * from "./evm-reader.js";
export * from "./evm-writer.js";
export * from "./evm-notice.js";
export { EvmRpc, EvmRevert, type EvmFetch, type BlockRef, type EvmBlock, type EvmReceipt, type EvmRpcOptions } from "./evm-rpc.js";
export { encodeCall, decodeArgs, encodeArgs, selector, eventTopic, type AbiType, type AbiValue } from "./evm-abi.js";
