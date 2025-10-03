/**
 * Example: Creating a DID:WebVH identifier with the Originals SDK
 * 
 * This example demonstrates how to:
 * 1. Create a new did:webvh DID with cryptographic signing
 * 2. Save the DID log to the appropriate did.jsonl path
 * 3. Load and verify the DID log
 */

import { WebVHManager } from '../did/WebVHManager';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  console.log('🚀 DID:WebVH Creation Example\n');

  // Initialize the WebVH manager
  const manager = new WebVHManager();

  // Define output directory for the DID log
  const outputDir = path.join(process.cwd(), '.well-known');

  try {
    // Example 1: Create a simple did:webvh DID
    console.log('📝 Example 1: Creating a simple did:webvh DID...');
    const result1 = await manager.createDIDWebVH({
      domain: 'example.com',
      outputDir,
    });

    console.log('✅ DID Created:', result1.did);
    console.log('📄 DID Document:', JSON.stringify(result1.didDocument, null, 2));
    console.log('🔑 Public Key:', result1.keyPair.publicKey);
    console.log('📁 Log saved to:', result1.logPath);
    console.log('📊 Log entries:', result1.log.length);
    console.log();

    // Example 2: Create a did:webvh with custom paths
    console.log('📝 Example 2: Creating a did:webvh with custom paths...');
    const result2 = await manager.createDIDWebVH({
      domain: 'example.com',
      paths: ['users', 'alice'],
      outputDir,
    });

    console.log('✅ DID Created:', result2.did);
    console.log('📁 Log saved to:', result2.logPath);
    console.log();

    // Example 3: Create a portable did:webvh
    console.log('📝 Example 3: Creating a portable did:webvh...');
    const result3 = await manager.createDIDWebVH({
      domain: 'example.com',
      portable: true,
      outputDir,
    });

    console.log('✅ DID Created:', result3.did);
    console.log('🔄 Portable:', result3.log[0].parameters.portable);
    console.log();

    // Example 4: Load a saved DID log
    if (result1.logPath) {
      console.log('📝 Example 4: Loading a saved DID log...');
      const loadedLog = await manager.loadDIDLog(result1.logPath);
      console.log('✅ Log loaded successfully');
      console.log('📊 Entries in log:', loadedLog.length);
      console.log('🔍 First entry version:', loadedLog[0].versionId);
      console.log();
    }

    // Display log structure
    console.log('📋 DID Log Structure:');
    console.log(JSON.stringify(result1.log[0], null, 2));
    console.log();

    console.log('✨ All examples completed successfully!');
    console.log('\n📚 Key Points:');
    console.log('  - DID:WebVH DIDs are cryptographically signed and verifiable');
    console.log('  - The DID log is saved to did.jsonl for resolution');
    console.log('  - Each log entry includes version info, state, and cryptographic proofs');
    console.log('  - DIDs can be created with custom paths and portable flags');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    // Cleanup: remove test files (optional)
    // You may want to keep these for inspection
    console.log('\n🧹 Cleanup: DID logs saved in .well-known/did/');
  }
}

// Run the example
if (require.main === module) {
  main().catch(console.error);
}

export { main };
