/**
 * OrdMockProvider moved to @originals/cel/testing (the CEL verifier tests need
 * it too); this module survives as its import path inside the SDK.
 */
import type { OrdinalsProvider } from '../types.js';
import type { OrdMockProvider as MovedOrdMockProvider } from '@originals/cel/testing';

export { OrdMockProvider } from '@originals/cel/testing';
export type { OrdMockState } from '@originals/cel/testing';

// The moved class no longer declares `implements OrdinalsProvider` (the
// interface lives here); keep the conformance check at compile time.
type AssertAssignable<T extends U, U> = T;
type _OrdMockConforms = AssertAssignable<MovedOrdMockProvider, OrdinalsProvider>;
