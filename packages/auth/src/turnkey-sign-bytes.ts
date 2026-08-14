/**
 * The one place Turnkey actually signs (plan 045).
 *
 * Both the server and client signers had their own copy of this — hex-encode,
 * `HASH_FUNCTION_NO_OP`, concatenate r‖s, check 64 bytes — kept in sync by
 * comment. They now share it, and because it is byte-level it satisfies
 * `OriginalsSigner.signBytes` / `ExternalSigner.signBytes` directly, so a
 * Turnkey key can author CEL events and sign credentials rather than only
 * did:webvh logs.
 */

import type { Turnkey } from '@turnkey/sdk-server';

export interface TurnkeySignBytesOptions {
  turnkeyClient: Turnkey;
  /** Turnkey sub-organization id. */
  organizationId: string;
  /** The account to sign with (address or private key id). */
  signWith: string;
}

/**
 * Signs exactly `data` with a Turnkey-held Ed25519 key.
 *
 * The payload is sent pre-hashed with `HASH_FUNCTION_NO_OP`: the caller (the
 * SDK) owns canonicalization and hashing, so Turnkey must sign the bytes
 * verbatim and hash nothing itself.
 *
 * @returns the raw 64-byte Ed25519 signature
 */
export async function turnkeySignBytes(
  { turnkeyClient, organizationId, signWith }: TurnkeySignBytesOptions,
  data: Uint8Array
): Promise<Uint8Array> {
  const result = await turnkeyClient.apiClient().signRawPayload({
    organizationId,
    signWith,
    payload: `0x${Buffer.from(data).toString('hex')}`,
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    hashFunction: 'HASH_FUNCTION_NO_OP',
  });

  // Turnkey nests the signature under activity.result.signRawPayloadResult;
  // reading result.r/result.s directly is always undefined.
  const signRawResult = result.activity?.result?.signRawPayloadResult;
  const r = signRawResult?.r;
  const s = signRawResult?.s;
  if (!r || !s) {
    throw new Error(
      'Invalid signature response from Turnkey: expected activity.result.signRawPayloadResult.{r,s}'
    );
  }

  // Strip `0x` from each component SEPARATELY: concatenating first and
  // stripping one leading prefix leaves an embedded '0x' in the middle when
  // both are prefixed, corrupting the hex decode.
  const cleanR = r.startsWith('0x') ? r.slice(2) : r;
  const cleanS = s.startsWith('0x') ? s.slice(2) : s;
  const signature = Uint8Array.from(Buffer.from(cleanR + cleanS, 'hex'));

  // Ed25519 signatures are exactly 64 bytes (32-byte r + 32-byte s). Never
  // truncate: a wrong length is not a valid signature with a spare byte, and
  // slicing it yields something that is accepted here but fails verification
  // far away.
  if (signature.length !== 64) {
    throw new Error(`Invalid Ed25519 signature length: ${signature.length} (expected 64 bytes)`);
  }
  return signature;
}
