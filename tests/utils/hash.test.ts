import { sha256Bytes } from '../../src/utils/hash';

describe('sha256Bytes', () => {
  test('hashes string and bytes', async () => {
    const a = await sha256Bytes('abc');
    const b = await sha256Bytes(new TextEncoder().encode('abc'));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a).toBeInstanceOf(Uint8Array);
  });
});

