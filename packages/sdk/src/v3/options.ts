import type { CelSigner } from "@originals/cel/v3";
import { fields, record, requireAsset } from "./envelope.js";
import type { MutationOptions } from "./types.js";

/** Capture controller identity and callback before a queued operation yields. Custody itself remains external. */
export function captureSigner(signer: CelSigner): CelSigner {
  requireAsset(
    signer !== null &&
      typeof signer === "object" &&
      typeof signer.sign === "function",
    "ASSET_SIGNER",
    "Expected a CEL 3 signer",
  );
  return Object.freeze({
    algorithm: signer.algorithm,
    controller: signer.controller,
    sign: signer.sign.bind(signer),
  });
}

export function mutationOptions(input: MutationOptions): MutationOptions {
  const value = record(input);
  fields(value, [], ["signer", "onAppendFailure"]);
  requireAsset(
    value.onAppendFailure === undefined ||
      value.onAppendFailure === "throw" ||
      value.onAppendFailure === "skip",
    "ASSET_OPTIONS",
    "onAppendFailure must be throw or skip",
  );
  return {
    ...(input.signer ? { signer: captureSigner(input.signer) } : {}),
    ...(input.onAppendFailure !== undefined
      ? { onAppendFailure: input.onAppendFailure }
      : {}),
  };
}
