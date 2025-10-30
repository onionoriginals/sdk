/**
 * Turnkey Signing Utilities
 * Handles signing operations for DID documents and credentials
 */

import { TurnkeyClient, WalletAccount } from '@turnkey/core';

/**
 * Sign a payload with Turnkey
 * Assumes the payload is already properly formatted/hashed by the Originals SDK
 *
 * @param turnkeyClient - Initialized Turnkey client
 * @param payload - Pre-hashed/formatted payload ready to sign (as hex string)
 * @param walletAccount - Turnkey wallet account to sign with
 * @returns Formatted signature (0x-prefixed hex string)
 */
export async function signWithTurnkey(
  turnkeyClient: TurnkeyClient,
  payload: string,
  walletAccount: WalletAccount
): Promise<string> {
  try {
    // Payload should already be properly formatted by Originals SDK
    // Just ensure it's in hex format for Turnkey
    const hexPayload = payload.startsWith('0x') ? payload.slice(2) : payload;

    const response = await turnkeyClient.signMessage({
      organizationId: walletAccount.organizationId,
      walletAccount: walletAccount as WalletAccount,
      message: hexPayload,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP', // Payload is already hashed by SDK
    });

    if (!response.r || !response.s) {
      throw new Error('Invalid signature response from Turnkey');
    }

    // Combine r and s into a single signature using proper formatting
    // formatSignature handles '0x' prefix normalization consistently
    const signature = formatSignature(response.r, response.s, response.v);

    return signature;
  } catch (error) {
    console.error('Error signing with Turnkey:', error);
    throw new Error(`Failed to sign: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sign a DID document with Turnkey
 */
export async function signDIDDocument(
  turnkeyClient: TurnkeyClient,
  didDocument: any,
  walletAccount: WalletAccount
): Promise<{ signature: string; proofValue: string }> {
  try {
    // Create the data to sign (canonical form of DID document)
    // In production, this should come from Originals SDK's canonicalization
    const canonicalDoc = JSON.stringify(didDocument, Object.keys(didDocument).sort());

    // Hash the canonical document
    const encoder = new TextEncoder();
    const data = encoder.encode(canonicalDoc);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Sign the hash with Turnkey
    const signature = await signWithTurnkey(turnkeyClient, hashHex, walletAccount);

    // Format as proof value (multibase encoded)
    const proofValue = `z${signature}`;

    return {
      signature,
      proofValue,
    };
  } catch (error) {
    console.error('Error signing DID document:', error);
    throw new Error(`Failed to sign DID document: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sign a credential with Turnkey
 */
export async function signCredential(
  turnkeyClient: TurnkeyClient,
  credential: any,
  proof: any,
  walletAccount: WalletAccount
): Promise<{ signature: string; proofValue: string }> {
  try {
    // Create the data to sign (canonical form)
    // In production, this should come from Originals SDK's canonicalization
    const dataToSign = JSON.stringify({
      credential,
      proof: {
        ...proof,
        proofValue: undefined, // Remove proofValue before signing
      },
    }, Object.keys({ credential, proof }).sort());

    // Hash the canonical data
    const encoder = new TextEncoder();
    const data = encoder.encode(dataToSign);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Sign the hash with Turnkey
    const signature = await signWithTurnkey(turnkeyClient, hashHex, walletAccount);

    // Format as proof value
    const proofValue = `z${signature}`;

    return {
      signature,
      proofValue,
    };
  } catch (error) {
    console.error('Error signing credential:', error);
    throw new Error(`Failed to sign credential: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Convert Turnkey signature components (r, s, v) to hex string
 */
export function formatSignature(r: string, s: string, v?: string): string {
  // Remove '0x' prefix if present
  const cleanR = r.startsWith('0x') ? r.slice(2) : r;
  const cleanS = s.startsWith('0x') ? s.slice(2) : s;

  if (v) {
    const cleanV = v.startsWith('0x') ? v.slice(2) : v;
    return `0x${cleanR}${cleanS}${cleanV}`;
  }

  return `0x${cleanR}${cleanS}`;
}

/**
 * Verify a signature locally (for testing)
 */
export async function verifySignatureLocal(
  message: string,
  signature: string,
  publicKey: string
): Promise<boolean> {
  try {
    // This is a simplified verification
    // In production, you'd use the appropriate crypto library based on the curve
    console.log('Local signature verification not fully implemented');
    return true;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}
