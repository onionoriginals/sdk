// test.ts
import { KeyType, Multikey } from '../../src/lib/crypto/keypairs/Multikey';

async function testDiWings() {
  try {
    const key = await Multikey.generate(KeyType.Ed25519);
    console.log('Generated key:', key);

    console.log('di-wings package imported and used successfully!');
  } catch (error) {
    console.error('Error testing di-wings:', error);
  }
}

testDiWings();