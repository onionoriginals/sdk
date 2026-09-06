/**
 * CEL (Cryptographic Event Log) module — extracted to @originals/cel.
 *
 * This barrel re-exports the whole package so the historical
 * '@originals/sdk/cel' subpath keeps working unchanged.
 *
 * The CLI is intentionally NOT re-exported here. It statically imports fs and
 * path and pulls in all of OriginalsSDK, which would make this barrel — the
 * genesis-only entry point for browser consumers — unloadable outside Node.
 * It ships as the `originals-cel` bin (dist/cel/cli/index.js) instead.
 */
export * from '@originals/cel';
