// W3C DID Document types — canonical definitions live in @originals/cel.
export type { DIDDocument, VerificationMethod, ServiceEndpoint } from '@originals/cel';

import type { VerificationMethod } from '@originals/cel';

/**
 * A verification method as *input* to `createDIDOriginal`/`updateDIDOriginal`,
 * as opposed to one already published in a `DIDDocument` (where `controller`
 * is required — see `VerificationMethod`). `controller` is optional here so a
 * caller can omit it and let didwebvh-ts fill in the DID being created via its
 * own `vm.controller ?? did` fallback; passing `controller: ''` instead of
 * omitting the field defeats that fallback, since `??` does not replace an
 * empty string (#804).
 */
export type VerificationMethodInput = Omit<VerificationMethod, 'controller'> & {
  controller?: string;
};
