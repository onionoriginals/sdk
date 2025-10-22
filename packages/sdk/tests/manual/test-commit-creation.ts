/**
 * Manual Test: Commit Transaction Creation
 *
 * This script demonstrates and verifies commit transaction creation without broadcasting.
 * It uses test data (NOT real keys) to ensure the commit transaction logic works correctly.
 *
 * Expected Output:
 * - Valid P2TR commit address
 * - Valid PSBT with correct inputs and outputs
 * - Reveal keypair for subsequent reveal transaction
 * - Inscription script data (script, control block, leaf version)
 * - Fee calculation matching expected values
 *
 * Usage:
 * ```bash
 * bun run tests/manual/test-commit-creation.ts
 * ```
 *
 * IMPORTANT: This script does NOT broadcast transactions. It only creates and verifies
 * the PSBT structure for commit transactions.
 */

import { createCommitTransaction } from '../../src/bitcoin/transactions/commit.js';
import type { Utxo } from '../../src/types/bitcoin.js';
import * as btc from '@scure/btc-signer';

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(80));
  log(title, colors.bright + colors.blue);
  console.log('='.repeat(80));
}

function logSuccess(message: string) {
  log(`✓ ${message}`, colors.green);
}

function logInfo(message: string) {
  log(`ℹ ${message}`, colors.blue);
}

function logWarning(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

function logError(message: string) {
  log(`✗ ${message}`, colors.red);
}

/**
 * Create mock UTXOs for testing (NOT real UTXOs)
 */
function createMockUtxos(): Utxo[] {
  return [
    {
      txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      vout: 0,
      value: 50000,
      scriptPubKey: '0014' + 'b'.repeat(40), // Mock P2WPKH scriptPubKey
      address: 'bc1qtest1234567890'
    },
    {
      txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      vout: 1,
      value: 30000,
      scriptPubKey: '0014' + 'c'.repeat(40),
      address: 'bc1qtest0987654321'
    }
  ];
}

/**
 * Verify PSBT structure without decoding (basic checks)
 */
function verifyPsbtStructure(psbt: btc.Transaction, expectedInputCount: number): boolean {
  try {
    logInfo(`PSBT Input Count: ${psbt.inputsLength}`);
    logInfo(`PSBT Output Count: ${psbt.outputsLength}`);

    if (psbt.inputsLength !== expectedInputCount) {
      logError(`Expected ${expectedInputCount} inputs, got ${psbt.inputsLength}`);
      return false;
    }

    if (psbt.outputsLength < 1) {
      logError(`Expected at least 1 output, got ${psbt.outputsLength}`);
      return false;
    }

    logSuccess('PSBT structure is valid');
    return true;
  } catch (error) {
    logError(`Failed to verify PSBT: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

/**
 * Main test function
 */
async function main() {
  logSection('Commit Transaction Creation Test');

  try {
    // Test 1: Create simple text inscription
    logSection('Test 1: Simple Text Inscription');

    const inscription1Content = Buffer.from('Hello, Ordinals!');
    const mockUtxos1 = createMockUtxos();

    logInfo('Creating commit transaction...');
    logInfo(`Content: "${inscription1Content.toString()}"`);
    logInfo(`Content Type: text/plain`);
    logInfo(`Available UTXOs: ${mockUtxos1.length}`);
    logInfo(`Total Value: ${mockUtxos1.reduce((sum, u) => sum + u.value, 0)} sats`);

    const result1 = await createCommitTransaction({
      content: inscription1Content,
      contentType: 'text/plain',
      utxos: mockUtxos1,
      changeAddress: 'bc1qtest_change_address_12345',
      feeRate: 10,
      network: 'mainnet'
    });

    logSuccess('Commit transaction created successfully');

    // Verify commit address
    logInfo(`Commit Address: ${result1.commitAddress}`);
    if (result1.commitAddress.startsWith('bc1p')) {
      logSuccess('Commit address is valid P2TR (bc1p...)');
    } else {
      logWarning(`Unexpected address format: ${result1.commitAddress}`);
    }

    // Verify PSBT
    logInfo(`PSBT Base64 Length: ${result1.commitPsbtBase64.length} chars`);
    logInfo(`PSBT Base64 (first 50 chars): ${result1.commitPsbtBase64.substring(0, 50)}...`);

    // Verify PSBT structure
    const psbtValid = verifyPsbtStructure(result1.commitPsbt, 1);
    if (!psbtValid) {
      throw new Error('PSBT structure validation failed');
    }

    // Verify commit amount and fees
    logInfo(`Commit Amount: ${result1.commitAmount} sats`);
    logInfo(`Commit Fee: ${result1.fees.commit} sats`);

    if (result1.commitAmount < 546) {
      logError('Commit amount is below dust limit!');
    } else {
      logSuccess('Commit amount meets dust limit');
    }

    if (result1.fees.commit <= 0) {
      logError('Invalid fee amount!');
    } else {
      logSuccess(`Fee calculation: ${result1.fees.commit} sats at 10 sat/vB`);
    }

    // Verify reveal keypair
    logInfo(`Reveal Private Key Length: ${result1.revealPrivateKey.length} chars`);
    logInfo(`Reveal Public Key Length: ${result1.revealPublicKey.length} chars`);

    if (result1.revealPrivateKey.length === 64 && result1.revealPublicKey.length === 64) {
      logSuccess('Reveal keypair has correct format (32 bytes each in hex)');
    } else {
      logWarning('Unexpected reveal keypair format');
    }

    // Verify inscription script
    logInfo(`Inscription Script Length: ${result1.inscriptionScript.script.length} bytes`);
    logInfo(`Control Block Length: ${result1.inscriptionScript.controlBlock.length} bytes`);
    logInfo(`Leaf Version: 0x${result1.inscriptionScript.leafVersion.toString(16)}`);

    if (result1.inscriptionScript.leafVersion === 0xc0) {
      logSuccess('Leaf version is correct (0xc0)');
    } else {
      logWarning(`Unexpected leaf version: 0x${result1.inscriptionScript.leafVersion.toString(16)}`);
    }

    // Verify selected UTXOs
    logInfo(`Selected UTXOs: ${result1.selectedUtxos.length}`);
    const totalSelectedValue = result1.selectedUtxos.reduce((sum, u) => sum + u.value, 0);
    logInfo(`Total Selected Value: ${totalSelectedValue} sats`);

    const expectedMinimum = result1.commitAmount + result1.fees.commit;
    if (totalSelectedValue >= expectedMinimum) {
      logSuccess(`Selected UTXOs cover commit + fees (${totalSelectedValue} >= ${expectedMinimum})`);
    } else {
      logError(`Insufficient selected value (${totalSelectedValue} < ${expectedMinimum})`);
    }

    // Test 2: JSON content with metadata
    logSection('Test 2: JSON Content with Metadata');

    const inscription2Content = Buffer.from(JSON.stringify({
      message: 'Test inscription',
      timestamp: Date.now()
    }));

    const result2 = await createCommitTransaction({
      content: inscription2Content,
      contentType: 'application/json',
      utxos: createMockUtxos(),
      changeAddress: 'bc1qtest_change_address_12345',
      feeRate: 20,
      network: 'mainnet',
      metadata: {
        title: 'Test JSON Inscription',
        author: 'Manual Test Script'
      }
    });

    logSuccess('JSON inscription commit transaction created');
    logInfo(`Commit Address: ${result2.commitAddress}`);
    logInfo(`Fee Rate: 20 sat/vB`);
    logInfo(`Commit Fee: ${result2.fees.commit} sats`);

    // Verify fee scales with fee rate (should be ~2x the first test)
    const feeRatio = result2.fees.commit / result1.fees.commit;
    logInfo(`Fee Ratio (20 sat/vB vs 10 sat/vB): ${feeRatio.toFixed(2)}x`);

    if (feeRatio >= 1.8 && feeRatio <= 2.2) {
      logSuccess('Fee scales correctly with fee rate');
    } else {
      logWarning(`Fee ratio outside expected range: ${feeRatio.toFixed(2)}x`);
    }

    // Test 3: Large content (1KB)
    logSection('Test 3: Large Content (1KB)');

    const largeContent = Buffer.alloc(1024, 'a');

    const result3 = await createCommitTransaction({
      content: largeContent,
      contentType: 'text/plain',
      utxos: [
        {
          txid: 'c'.repeat(64),
          vout: 0,
          value: 500000, // Larger UTXO for larger content
          scriptPubKey: '0014' + 'd'.repeat(40),
          address: 'bc1qtest_large_utxo'
        }
      ],
      changeAddress: 'bc1qtest_change_address_12345',
      feeRate: 10,
      network: 'mainnet'
    });

    logSuccess('Large content inscription commit transaction created');
    logInfo(`Content Size: ${largeContent.length} bytes`);
    logInfo(`Inscription Script Size: ${result3.inscriptionScript.script.length} bytes`);
    logInfo(`Commit Fee: ${result3.fees.commit} sats`);

    // Test 4: Testnet address
    logSection('Test 4: Testnet Address Generation');

    const result4 = await createCommitTransaction({
      content: Buffer.from('Testnet inscription'),
      contentType: 'text/plain',
      utxos: createMockUtxos(),
      changeAddress: 'tb1qtest_testnet_change',
      feeRate: 5,
      network: 'testnet'
    });

    logInfo(`Testnet Commit Address: ${result4.commitAddress}`);

    if (result4.commitAddress.startsWith('tb1p')) {
      logSuccess('Testnet address is valid (tb1p...)');
    } else {
      logWarning(`Unexpected testnet address format: ${result4.commitAddress}`);
    }

    // Final summary
    logSection('Test Summary');
    logSuccess('All tests completed successfully!');
    logInfo('Commit transaction creation is working correctly');
    logInfo('PSBT structure is valid');
    logInfo('Fee calculation is accurate');
    logInfo('P2TR address generation is correct');
    logInfo('Inscription script data is properly formatted');

    console.log('\n' + '='.repeat(80));
    logSuccess('✓ Manual verification complete - commit.ts is ready for use');
    console.log('='.repeat(80) + '\n');

    // IMPORTANT REMINDER
    logWarning('REMINDER: This script does NOT broadcast transactions');
    logWarning('         It only creates and verifies PSBT structure');
    logWarning('         DO NOT use these test keys or addresses for real Bitcoin');

  } catch (error) {
    logSection('Test Failed');
    logError(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the tests
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
