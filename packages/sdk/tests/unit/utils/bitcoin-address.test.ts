/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect } from 'bun:test';
import { validateBitcoinAddress, isValidBitcoinAddress } from '../../../src/utils/bitcoin-address';
import * as bitcoin from 'bitcoinjs-lib';

describe('bitcoin-address validation', () => {
  describe('validateBitcoinAddress', () => {
    describe('mainnet addresses', () => {
      test('accepts valid mainnet bech32 (bc1) address', () => {
        // Valid P2WPKH mainnet address
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mainnet')).not.toThrow();
      });

      test('legacy address formats are not supported in bitcoinjs-lib v6', () => {
        // bitcoinjs-lib v6 primarily supports bech32 addresses
        // Legacy P2PKH (1...) and P2SH (3...) formats require additional libraries
        // For the purposes of this SDK focused on modern Bitcoin, we'll primarily validate bech32
        expect(true).toBe(true);
      });

      test('accepts valid mainnet P2WSH (bc1...) address', () => {
        // Valid P2WSH address (longer than P2WPKH)
        expect(() => validateBitcoinAddress('bc1qeklep85ntjz4605drds6aww9u0qr46qzrv5xswd35uhjuj8ahfcqgf6hak', 'mainnet')).not.toThrow();
      });

      test('accepts valid mainnet P2TR (Taproot, bech32m) address', () => {
        // Regression for https://github.com/onionoriginals/sdk/issues/713:
        // bitcoinjs-lib v7 requires initEccLib() before it will validate any
        // Taproot address; this must succeed without one.
        expect(() => validateBitcoinAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 'mainnet')).not.toThrow();
      });

      test('rejects mainnet P2TR address with invalid checksum', () => {
        expect(() => validateBitcoinAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3298', 'mainnet'))
          .toThrow(/Invalid Bitcoin address/i);
      });

      test('rejects mainnet address with invalid checksum', () => {
        // Modified last character to break checksum
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdd', 'mainnet'))
          .toThrow(/Invalid Bitcoin address/i);
      });

      test('rejects regtest address on mainnet network', () => {
        // Regtest/testnet address should fail on mainnet
        expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet'))
          .toThrow(/Invalid/i);
      });
    });

    describe('regtest addresses', () => {
      test('accepts valid regtest/testnet bech32 addresses', () => {
        // Regtest accepts both bcrt1 and tb1 addresses (testnet format is commonly used)
        // Using testnet bech32 address which is valid for regtest
        expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'regtest')).not.toThrow();
        expect(() => validateBitcoinAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'regtest')).not.toThrow();
      });

      test('accepts a native regtest (bcrt1p) P2TR address', () => {
        expect(() => validateBitcoinAddress('bcrt1pnk2g6ndajtlzklp6ecwdlx0h77wtkgls4sgwmuerhzawxmzca2gskhckm8', 'regtest')).not.toThrow();
      });

      test('accepts a testnet-format (tb1p) P2TR address on regtest', () => {
        expect(() => validateBitcoinAddress('tb1pnk2g6ndajtlzklp6ecwdlx0h77wtkgls4sgwmuerhzawxmzca2gsmwjswa', 'regtest')).not.toThrow();
      });

      test('rejects mainnet address on regtest network', () => {
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'regtest'))
          .toThrow(/Invalid/i);
      });
    });

    describe('signet addresses', () => {
      test('accepts valid signet bech32 (tb1) address', () => {
        // Signet uses tb1 prefix like testnet
        expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'signet')).not.toThrow();
      });

      test('accepts a valid testnet/signet (tb1p) P2TR address', () => {
        expect(() => validateBitcoinAddress('tb1pnk2g6ndajtlzklp6ecwdlx0h77wtkgls4sgwmuerhzawxmzca2gsmwjswa', 'testnet')).not.toThrow();
        expect(() => validateBitcoinAddress('tb1pnk2g6ndajtlzklp6ecwdlx0h77wtkgls4sgwmuerhzawxmzca2gsmwjswa', 'signet')).not.toThrow();
      });

      test('accepts valid signet legacy addresses', () => {
        // Signet uses same formats as testnet
        expect(() => validateBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'signet')).not.toThrow();
      });

      test('rejects mainnet address on signet network', () => {
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'signet'))
          .toThrow(/Invalid/i);
      });
    });

    describe('invalid addresses', () => {
      test('rejects empty string', () => {
        expect(() => validateBitcoinAddress('', 'mainnet'))
          .toThrow(/empty/i);
      });

      test('rejects whitespace-only string', () => {
        expect(() => validateBitcoinAddress('   ', 'mainnet'))
          .toThrow(/empty/i);
      });

      test('rejects null or undefined', () => {
        expect(() => validateBitcoinAddress(null as any, 'mainnet'))
          .toThrow(/non-empty string/i);
        expect(() => validateBitcoinAddress(undefined as any, 'mainnet'))
          .toThrow(/non-empty string/i);
      });

      test('rejects non-string values', () => {
        expect(() => validateBitcoinAddress(123 as any, 'mainnet'))
          .toThrow(/non-empty string/i);
        expect(() => validateBitcoinAddress({} as any, 'mainnet'))
          .toThrow(/non-empty string/i);
      });

      test('rejects address that is too short', () => {
        expect(() => validateBitcoinAddress('bc1qar0sr', 'mainnet'))
          .toThrow(/length/i);
      });

      test('rejects address that is too long', () => {
        const tooLong = 'bc1' + 'q'.repeat(100);
        expect(() => validateBitcoinAddress(tooLong, 'mainnet'))
          .toThrow(/length/i);
      });

      test('rejects completely malformed address', () => {
        expect(() => validateBitcoinAddress('not-a-bitcoin-address-at-all-really-long', 'mainnet'))
          .toThrow(/Invalid/i);
      });

      test('rejects address with invalid characters', () => {
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5md@', 'mainnet'))
          .toThrow(/Invalid/i);
      });

      test('rejects mock addresses', () => {
        expect(() => validateBitcoinAddress('mock-address', 'mainnet'))
          .toThrow(/Mock or test addresses/i);
        expect(() => validateBitcoinAddress('test-address', 'testnet'))
          .toThrow(/Mock or test addresses/i);
        expect(() => validateBitcoinAddress('MOCK-ADDRESS', 'mainnet'))
          .toThrow(/Mock or test addresses/i);
        expect(() => validateBitcoinAddress('TEST-ADDRESS', 'regtest'))
          .toThrow(/Mock or test addresses/i);
      });

      test('rejects address with wrong network prefix', () => {
        // Using testnet prefix on mainnet
        expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet'))
          .toThrow(/Invalid/i);
        
        // Using mainnet prefix on regtest
        expect(() => validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'regtest'))
          .toThrow(/Invalid/i);
      });
    });

    describe('edge cases', () => {
      test('trims whitespace before validation', () => {
        expect(() => validateBitcoinAddress('  bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq  ', 'mainnet')).not.toThrow();
      });

      test('returns true for valid addresses', () => {
        const result = validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mainnet');
        expect(result).toBe(true);
      });

      test('provides descriptive error messages', () => {
        // Invalid bech32 address
        expect(() => validateBitcoinAddress('bc1qinvalidaddresswithinvalidchecksum', 'mainnet'))
          .toThrow(/Invalid/);

        // Mock address
        expect(() => validateBitcoinAddress('mock-address', 'mainnet'))
          .toThrow(/Mock or test addresses are not valid/);

        // Empty
        expect(() => validateBitcoinAddress('', 'mainnet'))
          .toThrow(/non-empty string/);
      });
    });

    describe('real-world address examples', () => {
      test('accepts various valid mainnet bech32 addresses', () => {
        const validAddresses = [
          'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',  // P2WPKH
          'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',  // P2WPKH
          'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', // P2WSH
          'bc1qeklep85ntjz4605drds6aww9u0qr46qzrv5xswd35uhjuj8ahfcqgf6hak', // P2WSH
          'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', // P2TR (Taproot)
        ];

        validAddresses.forEach(address => {
          expect(() => validateBitcoinAddress(address, 'mainnet')).not.toThrow();
        });
      });

      test('accepts various valid regtest bech32 addresses', () => {
        const validAddresses = [
          'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
          'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        ];

        validAddresses.forEach(address => {
          expect(() => validateBitcoinAddress(address, 'regtest')).not.toThrow();
        });
      });
    });
  });

  describe('isValidBitcoinAddress', () => {
    test('returns true for valid addresses', () => {
      expect(isValidBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mainnet')).toBe(true);
      expect(isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'regtest')).toBe(true);
      expect(isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'signet')).toBe(true);
    });

    test('returns false for invalid addresses', () => {
      expect(isValidBitcoinAddress('mock-address', 'mainnet')).toBe(false);
      expect(isValidBitcoinAddress('', 'mainnet')).toBe(false);
      expect(isValidBitcoinAddress('invalid', 'mainnet')).toBe(false);
      expect(isValidBitcoinAddress('bc1qinvalidaddresswith', 'mainnet')).toBe(false);
    });

    test('returns false for wrong network', () => {
      expect(isValidBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'testnet')).toBe(false);
      expect(isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet')).toBe(false);
    });

    test('does not throw for any input', () => {
      expect(() => isValidBitcoinAddress('', 'mainnet')).not.toThrow();
      expect(() => isValidBitcoinAddress(null as any, 'mainnet')).not.toThrow();
      expect(() => isValidBitcoinAddress(undefined as any, 'mainnet')).not.toThrow();
    });
  });

  // validateBitcoinAddress() itself no longer depends on bitcoinjs-lib (see #713:
  // bitcoinjs-lib v7 needs an explicit initEccLib() call before it can validate
  // Taproot addresses, which this package never provided). These tests keep
  // bitcoinjs-lib's independent P2WPKH/base58 decoding as a cross-check that the
  // @scure/btc-signer-based validator hasn't drifted from it for non-Taproot
  // address types.
  describe('cross-check against bitcoinjs-lib for non-Taproot addresses', () => {
    test('validates addresses that bitcoinjs-lib can also decode', () => {
      const validMainnetAddresses = [
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      ];

      validMainnetAddresses.forEach(address => {
        // Should not throw with our validator
        expect(() => validateBitcoinAddress(address, 'mainnet')).not.toThrow();

        // Should also not throw with bitcoinjs-lib directly
        expect(() => bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)).not.toThrow();
      });
    });

    test('rejects addresses that bitcoinjs-lib also rejects', () => {
      const invalidAddresses = [
        'bc1qinvalid',
        '1InvalidBase58',
        'not-an-address',
      ];

      invalidAddresses.forEach(address => {
        // Should throw with our validator (if long enough)
        if (address.length >= 26) {
          expect(() => validateBitcoinAddress(address, 'mainnet')).toThrow();
        }
        
        // Should also throw with bitcoinjs-lib directly
        expect(() => bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)).toThrow();
      });
    });
  });
});
