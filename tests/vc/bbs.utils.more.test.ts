import { BBSCryptosuiteUtils } from '../../src';

describe('BBSCryptosuiteUtils error branches', () => {
  test('parseBaseProofValue throws on non-u prefix', () => {
    expect(() => (BBSCryptosuiteUtils as any).parseBaseProofValue('xabc')).toThrow('multibase');
  });

  test('parseDerivedProofValue throws on non-u prefix', () => {
    expect(() => (BBSCryptosuiteUtils as any).parseDerivedProofValue('xabc')).toThrow('multibase');
  });
});

