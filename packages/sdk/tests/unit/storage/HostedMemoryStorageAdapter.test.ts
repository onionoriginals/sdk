import { describe, test, expect } from 'bun:test';
import { HostedMemoryStorageAdapter } from '../../../src/storage/HostedMemoryStorageAdapter';

describe('HostedMemoryStorageAdapter', () => {
  test('putObject returns the canonical https://domain/path URL hosted publication requires (#780)', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    const url = await adapter.putObject('example.com', 'published/anonymous/x/did.jsonl', 'content');
    expect(url).toBe('https://example.com/published/anonymous/x/did.jsonl');
  });

  test('putObject strips leading slashes from the path before building the URL', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    const url = await adapter.putObject('example.com', '///test.txt', 'content');
    expect(url).toBe('https://example.com/test.txt');
  });

  test('getObject retrieves stored content byte-for-byte', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    const data = new Uint8Array([5, 6, 7, 8]);
    await adapter.putObject('example.com', '/data.bin', data);

    const result = await adapter.getObject('example.com', '/data.bin');
    expect(result).not.toBeNull();
    expect(result?.content).toEqual(data);
  });

  test('getObject returns null for a non-existent object', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    const result = await adapter.getObject('example.com', '/nonexistent.txt');
    expect(result).toBeNull();
  });

  test('exists reflects stored objects', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    await adapter.putObject('example.com', '/test.txt', 'content');
    expect(await adapter.exists('example.com', '/test.txt')).toBe(true);
    expect(await adapter.exists('example.com', '/other.txt')).toBe(false);
  });

  test('multiple domains are isolated', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    await adapter.putObject('domain1.com', '/test.txt', 'content1');
    await adapter.putObject('domain2.com', '/test.txt', 'content2');

    const result1 = await adapter.getObject('domain1.com', '/test.txt');
    const result2 = await adapter.getObject('domain2.com', '/test.txt');
    expect(new TextDecoder().decode(result1?.content)).toBe('content1');
    expect(new TextDecoder().decode(result2?.content)).toBe('content2');
  });

  test('a mutated caller-side Uint8Array does not corrupt stored bytes (copy on write)', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    const data = new Uint8Array([1, 2, 3]);
    await adapter.putObject('example.com', '/data.bin', data);
    data[0] = 99;
    const result = await adapter.getObject('example.com', '/data.bin');
    expect(Array.from(result!.content)).toEqual([1, 2, 3]);
  });

  test('listObjects enumerates stored paths under a domain matching a prefix', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    await adapter.putObject('example.com', 'a/one.txt', '1');
    await adapter.putObject('example.com', 'a/two.txt', '2');
    await adapter.putObject('example.com', 'b/three.txt', '3');
    await adapter.putObject('other.com', 'a/four.txt', '4');

    const results = await adapter.listObjects('example.com', 'a/');
    expect(results.sort()).toEqual(['a/one.txt', 'a/two.txt']);
  });

  test('storage is private per instance, unlike MemoryStorageAdapter global store', async () => {
    const first = new HostedMemoryStorageAdapter();
    const second = new HostedMemoryStorageAdapter();
    await first.putObject('example.com', '/test.txt', 'content');
    expect(await second.exists('example.com', '/test.txt')).toBe(false);
  });

  test('clear removes every stored object from this instance', async () => {
    const adapter = new HostedMemoryStorageAdapter();
    await adapter.putObject('example.com', '/test.txt', 'content');
    adapter.clear();
    expect(await adapter.exists('example.com', '/test.txt')).toBe(false);
  });
});
