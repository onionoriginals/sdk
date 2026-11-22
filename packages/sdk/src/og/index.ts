/**
 * @originals/sdk/og: the SDK's did:og writer and anchoring workflow on top of
 * @originals/vh/og (originals-spec PR 69, method value og:1.0-draft.1).
 */
export * from "./author-did.js";
export * from "./original.js";
export * from "./chain.js";
export * from "./inscribe.js";
export * from "./evidence.js";
// The key file and the anchoring command's steps (keys.ts, anchor.ts) are Node-only and are used by the
// `originals-og` command (cli.ts); they are not exported here, so this entry stays browser-safe.
