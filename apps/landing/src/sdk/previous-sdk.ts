/**
 * Private application boundary for the preceding inscription representation.
 * This preserves the existing landing/regtest journey while #563–565 and #570
 * connect CEL 3 publication and recovery. It is not exported by @originals/sdk,
 * never selected by inspecting an input, and must leave the release journey
 * before the new-format end-to-end gate can pass.
 */
export { OriginalsSDK } from '../../../../packages/sdk/dist/core/OriginalsSDK.js';
export { OriginalsAsset } from '../../../../packages/sdk/dist/lifecycle/OriginalsAsset.js';
export { ASSET_ENVELOPE_FORMAT, ASSET_ENVELOPE_VERSION } from '../../../../packages/sdk/dist/lifecycle/assetEnvelope.js';
export type { AssetEnvelope } from '../../../../packages/sdk/dist/lifecycle/assetEnvelope.js';
export { createCelDidDocument, deriveDidCel, resolveDidCel, verifyEventLog, classifyLogEntries, claimedSignerDid, resourcePathSegment, cbor } from '../../../../packages/cel/dist/index.js';
export type { EntryAuthorClass } from '../../../../packages/cel/dist/index.js';
// Used together by the historical example and byte-preservation regression tests.
export { KeyManager, signerFromKeyPair } from '@originals/sdk';
