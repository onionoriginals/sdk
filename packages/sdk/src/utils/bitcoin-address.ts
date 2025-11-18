import * as bitcoin from 'bitcoinjs-lib';

/**
 * Bitcoin network types supported by the validation
 */
export type BitcoinNetwork = 'mainnet' | 'regtest' | 'signet';

/**
 * Maps our network names to bitcoinjs-lib network configurations
 */
const getNetwork = (network: BitcoinNetwork): bitcoin.Network => {
  switch (network) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'regtest':
      // Regtest uses testnet parameters but with bcrt prefix
      // However, since many regtest addresses in tests use testnet format,
      // we accept both testnet and regtest addresses for regtest network
      return bitcoin.networks.regtest;
    case 'signet':
      // Signet uses the same bech32 prefix as testnet (tb1)
      return bitcoin.networks.testnet;
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
};

/**
 * Validates a Bitcoin address format and checksum for the given network.
 * 
 * This function uses bitcoinjs-lib's address.toOutputScript() which performs:
 * - Format validation (bech32, base58check)
 * - Checksum verification
 * - Network prefix validation
 * 
 * @param address - The Bitcoin address to validate
 * @param network - The network to validate against ('mainnet', 'regtest', 'signet')
 * @returns true if the address is valid for the network
 * @throws Error with descriptive message if validation fails
 * 
 * @example
 * ```typescript
 * // Valid mainnet address
 * validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mainnet'); // true
 * 
 * // Invalid checksum
 * validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdd', 'mainnet'); // throws
 * 
 * // Wrong network
 * validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'testnet'); // throws
 * ```
 */
export function validateBitcoinAddress(address: string, network: BitcoinNetwork): boolean {
  // Input validation
  if (!address || typeof address !== 'string') {
    throw new Error('Address must be a non-empty string');
  }

  const trimmedAddress = address.trim();
  
  if (trimmedAddress.length === 0) {
    throw new Error('Address cannot be empty');
  }

  // Check for mock/test addresses that should not be allowed in production
  if (/^(mock-|test-)/i.test(trimmedAddress)) {
    throw new Error('Mock or test addresses are not valid Bitcoin addresses');
  }

  // Validate address length (Bitcoin addresses are typically 26-90 characters)
  if (trimmedAddress.length < 26 || trimmedAddress.length > 90) {
    throw new Error(`Invalid address length: ${trimmedAddress.length} characters (expected 26-90)`);
  }

  try {
    // Get the appropriate network configuration
    const networkConfig = getNetwork(network);
    
    // Use bitcoinjs-lib to validate the address format and checksum
    // This will throw if the address is invalid
    bitcoin.address.toOutputScript(trimmedAddress, networkConfig);
    
    return true;
  } catch (error) {
    // For regtest, also try testnet network as many tools use testnet addresses for regtest
    if (network === 'regtest') {
      try {
        bitcoin.address.toOutputScript(trimmedAddress, bitcoin.networks.testnet);
        return true;
      } catch {
        // Fall through to error handling below
      }
    }
    
    // Parse the error to provide more specific feedback
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check for common error patterns and provide helpful messages
    if (errorMessage.includes('Invalid checksum') || errorMessage.includes('checksum')) {
      throw new Error(`Invalid Bitcoin address checksum for address: ${trimmedAddress}`);
    }
    
    if (errorMessage.includes('Invalid prefix') || errorMessage.includes('prefix')) {
      throw new Error(`Invalid address prefix for ${network} network: ${trimmedAddress}`);
    }
    
    if (errorMessage.includes('too short') || errorMessage.includes('too long')) {
      throw new Error(`Invalid address length for ${network}: ${trimmedAddress}`);
    }
    
    // Generic invalid address error
    throw new Error(`Invalid Bitcoin address for ${network} network: ${trimmedAddress} (${errorMessage})`);
  }
}

/**
 * Validates a Bitcoin address and returns a boolean instead of throwing
 * 
 * @param address - The Bitcoin address to validate
 * @param network - The network to validate against
 * @returns true if valid, false otherwise
 */
export function isValidBitcoinAddress(address: string, network: BitcoinNetwork): boolean {
  try {
    validateBitcoinAddress(address, network);
    return true;
  } catch {
    return false;
  }
}
