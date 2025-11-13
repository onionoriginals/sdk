/**
 * Client-side key utilities for converting Turnkey public keys to multibase format
 */

import { multikey } from '@originals/sdk';
import type { WalletAccount } from '@turnkey/core';

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Turnkey's public key format to multibase Multikey format
 * @param publicKeyHex - The public key in hex format from Turnkey
 * @param keyType - The type of key ('Secp256k1' for Bitcoin, 'Ed25519' for Stellar)
 * @returns The public key encoded in multibase format (z-base58btc with multicodec header)
 */
export function convertToMultibase(
  publicKeyHex: string,
  keyType: 'Secp256k1' | 'Ed25519'
): string {
  // Convert hex string to Uint8Array
  let publicKeyBytes = hexToBytes(publicKeyHex);
  
  // Some Ed25519 public keys include a version byte prefix
  // Ed25519 keys must be exactly 32 bytes, so remove the prefix if present
  if (keyType === 'Ed25519' && publicKeyBytes.length === 33) {
    publicKeyBytes = publicKeyBytes.slice(1);
  }
  
  // Use SDK's multikey.encodePublicKey() function
  return multikey.encodePublicKey(publicKeyBytes, keyType);
}

/**
 * Extract multibase-encoded public keys from Turnkey wallets
 * Accounts are expected to be in order: Secp256k1 (auth), Ed25519 (assertion), Ed25519 (update)
 */
export function extractKeysFromWallets(wallets: Array<{ accounts: WalletAccount[] }>): {
  authKey: string;
  assertionKey: string;
  updateKey: string;
} | null {
  // Flatten all accounts from all wallets
  const allAccounts = wallets.flatMap(wallet => wallet.accounts);
  
  // Find accounts by curve type
  const secp256k1Accounts = allAccounts.filter(acc => acc.curve === 'CURVE_SECP256K1');
  const ed25519Accounts = allAccounts.filter(acc => acc.curve === 'CURVE_ED25519');
  
  if (secp256k1Accounts.length === 0 || ed25519Accounts.length < 2) {
    return null;
  }
  
  // Use first Secp256k1 for auth key
  const authAccount = secp256k1Accounts[0];
  if (!authAccount.publicKey) {
    console.error('Auth account missing publicKey');
    return null;
  }
  
  // Use first Ed25519 for assertion key
  const assertionAccount = ed25519Accounts[0];
  if (!assertionAccount.publicKey) {
    console.error('Assertion account missing publicKey');
    return null;
  }
  
  // Use second Ed25519 for update key
  const updateAccount = ed25519Accounts[1];
  if (!updateAccount.publicKey) {
    console.error('Update account missing publicKey');
    return null;
  }
  
  try {
    return {
      authKey: convertToMultibase(authAccount.publicKey, 'Secp256k1'),
      assertionKey: convertToMultibase(assertionAccount.publicKey, 'Ed25519'),
      updateKey: convertToMultibase(updateAccount.publicKey, 'Ed25519'),
    };
  } catch (error) {
    console.error('Failed to convert keys to multibase:', error);
    return null;
  }
}

