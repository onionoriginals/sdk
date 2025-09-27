describe('Signer module utils injection', () => {
  test('injects hmacSha256Sync when missing', async () => {
    jest.resetModules();
    const secp = require('@noble/secp256k1');
    const prev = secp.utils.hmacSha256Sync;
    // Remove function to trigger injection on module load
    delete secp.utils.hmacSha256Sync;
    const mod = await import('../../src/crypto/Signer');
    expect(typeof (require('@noble/secp256k1').utils.hmacSha256Sync)).toBe('function');
    // call the injected function to cover its body
    const key = new Uint8Array([1,2,3]);
    const out = require('@noble/secp256k1').utils.hmacSha256Sync(key, new Uint8Array([4,5]), new Uint8Array([6]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
    // restore
    require('@noble/secp256k1').utils.hmacSha256Sync = prev;
  });

  test('injects ed25519 sha512Sync when missing', async () => {
    jest.resetModules();
    const e = require('@noble/ed25519');
    const prev = e.utils.sha512Sync;
    delete e.utils.sha512Sync;
    await import('../../src/crypto/Signer');
    expect(typeof (require('@noble/ed25519').utils.sha512Sync)).toBe('function');
    // call the injected function to cover its body
    const out = require('@noble/ed25519').utils.sha512Sync(new Uint8Array([1,2,3]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(64);
    // restore
    require('@noble/ed25519').utils.sha512Sync = prev;
  });
});

