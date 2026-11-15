/**
 * INTERNAL: EVM anchoring for `OriginalsSDK` (originals-spec PR 59, P9.19-P9.29,
 * P14.18-P14.22). Built and tested but not part of the published API until
 * the spec pins an audited anchor contract (P14.21; owner decision, 14
 * November 2026): no package entry point exports this module, and it imports
 * `@originals/vh/internal/evm`, which resolves only under the private
 * `originals-internal` export condition. Plan 011 phase 12b/12d expose it
 * once 12c pins the contract.
 *
 * `OriginalsSDK` imports only the types from here. Its `evm` option is
 * honoured only with these functions in it, which `createEvmOriginalsSDK`
 * supplies; without them an Original with an `anchor` member is unsupported,
 * never invalid (section 14), and `create` refuses one.
 */
import {
  checkAnchor,
  derivedTokenAlias,
  parseEvmAlias,
  prepareCreateOriginal,
  prepareUpdateOriginal,
  readCarriedFile,
  resumableCheckpoint,
  isEvmCheckpoint,
  verifyOriginal,
} from "@originals/vh/internal/evm";
import { readEvmToken } from "./evm-reader.js";
import { evmPublicationStatus, mintEvmToken, prepareEvmPublication, submitEvmPublication } from "./evm-writer.js";
import { evmGenesisNotice, evmMoveNotice } from "./evm-notice.js";
import { OriginalsSDK, type OriginalsEvmOptions, type OriginalsSDKOptions } from "./sdk.js";

/** What the SDK calls when EVM anchoring is enabled: the ungated vh functions and the EVM adapters. */
export const EVM_RUNTIME = Object.freeze({
  verifyOriginal,
  prepareCreateOriginal,
  prepareUpdateOriginal,
  readCarriedFile,
  checkAnchor,
  derivedTokenAlias,
  parseEvmAlias,
  resumableCheckpoint,
  isEvmCheckpoint,
  readEvmToken,
  mintEvmToken,
  prepareEvmPublication,
  submitEvmPublication,
  evmPublicationStatus,
  evmGenesisNotice,
  evmMoveNotice,
});

export type EvmRuntime = typeof EVM_RUNTIME;

/** An `OriginalsSDK` with EVM anchoring enabled under the caller's anchor contract pin (EXPERIMENTAL). */
export function createEvmOriginalsSDK(options: OriginalsSDKOptions & { evm: Omit<OriginalsEvmOptions, "runtime"> }): OriginalsSDK {
  return OriginalsSDK.create({ ...options, evm: { ...options.evm, runtime: EVM_RUNTIME } });
}
