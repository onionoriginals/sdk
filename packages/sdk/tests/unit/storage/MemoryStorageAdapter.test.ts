import { describe, test, expect } from 'bun:test';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

describe('MemoryStorageAdapter', () => {
  test('putObject stores string content', async () => {
    const adapter = new MemoryStorageAdapter();
    const uri = await adapter.putObject('example.com', '/test.txt', 'hello world');
    expect(uri).toBe('mem://example.com/test.txt');
  });

  test('putObject stores Uint8Array content', async () => {
    const adapter = new MemoryStorageAdapter();
    const data = new Uint8Array([1, 2, 3, 4]);
    const uri = await adapter.putObject('example.com', '/test.bin', data);
    expect(uri).toBe('mem://example.com/test.bin');
  });

  test('getObject retrieves stored content', async () => {
    const adapter = new MemoryStorageAdapter();
    const data = new Uint8Array([5, 6, 7, 8]);
    await adapter.putObject('example.com', '/data.bin', data);
    
    const result = await adapter.getObject('example.com', '/data.bin');
    expect(result).not.toBeNull();
    expect(result?.content).toEqual(data);
  });

  test('getObject returns null for non-existent object', async () => {
    const adapter = new MemoryStorageAdapter();
    const result = await adapter.getObject('example.com', '/nonexistent.txt');
    expect(result).toBeNull();
  });

  test('exists returns true for stored object', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('example.com', '/test.txt', 'content');
    
    const exists = await adapter.exists('example.com', '/test.txt');
    expect(exists).toBe(true);
  });

  test('exists returns false for non-existent object', async () => {
    const adapter = new MemoryStorageAdapter();
    const exists = await adapter.exists('example.com', '/nonexistent.txt');
    expect(exists).toBe(false);
  });

  test('putObject strips leading slashes from path', async () => {
    const adapter = new MemoryStorageAdapter();
    const uri = await adapter.putObject('example.com', '///test.txt', 'content');
    expect(uri).toBe('mem://example.com/test.txt');
    
    const result = await adapter.getObject('example.com', '/test.txt');
    expect(result).not.toBeNull();
  });

  test('getObject works with paths that have leading slashes', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('example.com', 'test.txt', 'content');
    
    const result = await adapter.getObject('example.com', '/test.txt');
    expect(result).not.toBeNull();
  });

  test('multiple domains are isolated', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('domain1.com', '/test.txt', 'content1');
    await adapter.putObject('domain2.com', '/test.txt', 'content2');
    
    const result1 = await adapter.getObject('domain1.com', '/test.txt');
    const result2 = await adapter.getObject('domain2.com', '/test.txt');
    
    expect(new TextDecoder().decode(result1?.content)).toBe('content1');
    expect(new TextDecoder().decode(result2?.content)).toBe('content2');
  });

  test('putObject overwrites existing content', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('example.com', '/test.txt', 'original');
    await adapter.putObject('example.com', '/test.txt', 'updated');
    
    const result = await adapter.getObject('example.com', '/test.txt');
    expect(new TextDecoder().decode(result?.content)).toBe('updated');
  });

  test('exists handles paths with leading slashes', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('example.com', 'test.txt', 'content');
    
    const exists = await adapter.exists('example.com', '/test.txt');
    expect(exists).toBe(true);
  });
});
