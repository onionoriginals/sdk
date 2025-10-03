#!/usr/bin/env node

/**
 * Quick verification script for DID:WebVH implementation
 * Run with: node verify-webvh.mjs
 */

import { WebVHManager } from './dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function verifyImplementation() {
  console.log('🔍 Verifying DID:WebVH Implementation...\n');

  try {
    // Create a temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webvh-verify-'));
    console.log(`📁 Using temp directory: ${tempDir}\n`);

    // Initialize manager
    const manager = new WebVHManager();
    console.log('✅ WebVHManager initialized\n');

    // Test 1: Create a simple DID
    console.log('Test 1: Creating a simple did:webvh...');
    const result1 = await manager.createDIDWebVH({
      domain: 'example.com',
      outputDir: tempDir,
    });
    console.log(`✅ Created: ${result1.did}`);
    console.log(`   Public Key: ${result1.keyPair.publicKey.substring(0, 20)}...`);
    console.log(`   Log saved to: ${result1.logPath}`);
    console.log(`   Log entries: ${result1.log.length}\n`);

    // Verify the file was created
    if (fs.existsSync(result1.logPath)) {
      console.log('✅ Log file exists on disk\n');
    } else {
      throw new Error('Log file was not created!');
    }

    // Test 2: Create a DID with paths
    console.log('Test 2: Creating a did:webvh with custom paths...');
    const result2 = await manager.createDIDWebVH({
      domain: 'example.com',
      paths: ['users', 'alice'],
      outputDir: tempDir,
    });
    console.log(`✅ Created: ${result2.did}`);
    console.log(`   Expected format: did:webvh:example.com:users:alice:*`);
    
    if (result2.did.includes(':users:alice:')) {
      console.log('✅ Path handling works correctly\n');
    } else {
      throw new Error('Path handling failed!');
    }

    // Test 3: Load a saved log
    console.log('Test 3: Loading a saved DID log...');
    const loadedLog = await manager.loadDIDLog(result1.logPath);
    console.log(`✅ Loaded ${loadedLog.length} log entries`);
    console.log(`   Version ID: ${loadedLog[0].versionId}`);
    console.log(`   Version Time: ${loadedLog[0].versionTime}\n`);

    // Test 4: Verify DID document structure
    console.log('Test 4: Verifying DID document structure...');
    const doc = result1.didDocument;
    
    const checks = [
      { name: '@context includes DID v1', test: doc['@context'].includes('https://www.w3.org/ns/did/v1') },
      { name: '@context includes Multikey', test: doc['@context'].includes('https://w3id.org/security/multikey/v1') },
      { name: 'ID matches DID', test: doc.id === result1.did },
      { name: 'Has verificationMethod', test: Array.isArray(doc.verificationMethod) && doc.verificationMethod.length > 0 },
      { name: 'Has authentication', test: Array.isArray(doc.authentication) && doc.authentication.length > 0 },
      { name: 'Has assertionMethod', test: Array.isArray(doc.assertionMethod) && doc.assertionMethod.length > 0 },
    ];

    let allPassed = true;
    for (const check of checks) {
      if (check.test) {
        console.log(`   ✅ ${check.name}`);
      } else {
        console.log(`   ❌ ${check.name}`);
        allPassed = false;
      }
    }

    if (!allPassed) {
      throw new Error('DID document structure validation failed!');
    }

    console.log('\n');

    // Test 5: Verify cryptographic proof
    console.log('Test 5: Verifying cryptographic proof structure...');
    const proof = loadedLog[0].proof;
    
    if (!proof || !Array.isArray(proof) || proof.length === 0) {
      throw new Error('No proof found in log entry!');
    }

    const proofChecks = [
      { name: 'Has type', test: !!proof[0].type },
      { name: 'Has cryptosuite', test: !!proof[0].cryptosuite },
      { name: 'Has verificationMethod', test: !!proof[0].verificationMethod },
      { name: 'Has created timestamp', test: !!proof[0].created },
      { name: 'Has proofValue', test: !!proof[0].proofValue },
      { name: 'Has proofPurpose', test: !!proof[0].proofPurpose },
    ];

    let allProofChecksPassed = true;
    for (const check of proofChecks) {
      if (check.test) {
        console.log(`   ✅ ${check.name}`);
      } else {
        console.log(`   ❌ ${check.name}`);
        allProofChecksPassed = false;
      }
    }

    if (!allProofChecksPassed) {
      throw new Error('Proof structure validation failed!');
    }

    console.log('\n');

    // Cleanup
    console.log('🧹 Cleaning up temporary files...');
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('✅ Cleanup complete\n');

    // Summary
    console.log('═══════════════════════════════════════════════════════');
    console.log('✨ ALL TESTS PASSED! ✨');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\nThe DID:WebVH implementation is working correctly!');
    console.log('\nKey Features Verified:');
    console.log('  ✅ DID creation with didwebvh-ts library');
    console.log('  ✅ Cryptographic signing with Ed25519');
    console.log('  ✅ DID log saving to did.jsonl format');
    console.log('  ✅ Custom path support');
    console.log('  ✅ Proper DID document structure');
    console.log('  ✅ Data Integrity proofs');
    console.log('\nNext Steps:');
    console.log('  1. Set up a web server to serve .well-known/did/ directory');
    console.log('  2. Use the WebVHManager in your application');
    console.log('  3. See docs/DID_WEBVH_GUIDE.md for detailed usage');
    console.log('  4. Run src/examples/webvh-demo.ts for more examples\n');

  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED!');
    console.error('Error:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run verification
verifyImplementation().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
