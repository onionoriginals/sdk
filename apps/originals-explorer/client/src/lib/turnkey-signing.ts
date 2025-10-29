/**
 * Turnkey Signing Utilities
 * Handles signing operations for DID documents and credentials
 */

import { Turnkey } from '@turnkey/sdk-browser';
import type { TurnkeyWalletAccount } from './turnkey-client';

/**
 * Sign a raw message with Turnkey
 */
export async function signWithTurnkey(
  turnkeyClient: Turnkey,
  message: string,
  walletAccount: TurnkeyWalletAccount
): Promise<string> {
  try {
    // Hash the message (Turnkey expects a hash for signing)
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const response = await turnkeyClient.apiClient().signRawPayload({
      organizationId: turnkeyClient.config.defaultOrganizationId!,
      signWith: walletAccount.address,
      payload: hashHex,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP', // We already hashed it
    });

    if (!response.r || !response.s) {
      throw new Error('Invalid signature response from Turnkey');
    }

    // Combine r and s into a single signature
    // For ECDSA signatures, we typically need both r and s components
    const signature = response.r + response.s.slice(2); // Remove '0x' from s before concatenating

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
  turnkeyClient: Turnkey,
  didDocument: any,
  walletAccount: TurnkeyWalletAccount
): Promise<{ signature: string; proofValue: string }> {
  try {
    // Create the data to sign (canonical form of DID document)
    const canonicalDoc = JSON.stringify(didDocument, Object.keys(didDocument).sort());

    // Sign with Turnkey
    const signature = await signWithTurnkey(turnkeyClient, canonicalDoc, walletAccount);

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
  turnkeyClient: Turnkey,
  credential: any,
  proof: any,
  walletAccount: TurnkeyWalletAccount
): Promise<{ signature: string; proofValue: string }> {
  try {
    // Create the data to sign
    // This should match the canonical form expected by the verifier
    const dataToSign = JSON.stringify({
      credential,
      proof: {
        ...proof,
        proofValue: undefined, // Remove proofValue before signing
      },
    }, Object.keys({ credential, proof }).sort());

    // Sign with Turnkey
    const signature = await signWithTurnkey(turnkeyClient, dataToSign, walletAccount);

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
