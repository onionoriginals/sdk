describe('Signer module utils injection', () => {
  test('injects hmacSha256Sync when missing', async () => {
    jest.resetModules();
    const secp = require('@noble/secp256k1');
    const prev = secp.utils.hmacSha256Sync;
    // Remove function to trigger injection on module load
    delete secp.utils.hmacSha256Sync;
    const mod = await import('../../src/crypto/Signer');
    expect(typeof (require('@noble/secp256k1').utils.hmacSha256Sync)).toBe('function');
    // restore
    require('@noble/secp256k1').utils.hmacSha256Sync = prev;
  });
});

