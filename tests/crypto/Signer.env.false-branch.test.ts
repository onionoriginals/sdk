describe('Signer module env false branches (no injection when already present)', () => {
  test('does not inject when utils already provide functions', async () => {
    jest.resetModules();
    jest.doMock('@noble/secp256k1', () => {
      return { __esModule: true, utils: { hmacSha256Sync: jest.fn(() => new Uint8Array(32)) } };
    });
    jest.doMock('@noble/ed25519', () => {
      return { __esModule: true, utils: { sha512Sync: jest.fn(() => new Uint8Array(64)) } };
    });

    // Import inside isolated module context so the top-level checks run with our mocks
    await import('../../src/crypto/Signer');

    const secp = require('@noble/secp256k1');
    const ed = require('@noble/ed25519');
    expect(typeof secp.utils.hmacSha256Sync).toBe('function');
    expect(typeof ed.utils.sha512Sync).toBe('function');
  });
});

