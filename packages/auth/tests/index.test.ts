import { describe, test, expect } from 'bun:test';

describe('@originals/auth', () => {
  test('package exports are defined', async () => {
    // Test that the main exports are accessible
    const auth = await import('../src/index');
    expect(auth).toBeDefined();
  });

  test('server exports are defined', async () => {
    const server = await import('../src/server/index');
    expect(server).toBeDefined();
  });

  test('client exports are defined', async () => {
    const client = await import('../src/client/index');
    expect(client).toBeDefined();
  });

  test('types are defined', async () => {
    const types = await import('../src/types');
    expect(types).toBeDefined();
  });
});





