import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Transpile only this module in memory: exercise Node ESM without changing dist.
const source = readFileSync(
  new URL('../../../src/migration/storage/MigrationStorage.ts', import.meta.url),
  'utf8'
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
).toString('base64')}`;

function runIsolated(body: string, withoutBuffer = true): void {
  // Never remove Buffer from the Bun runner or its shared setup/dependencies.
  const result = spawnSync('node', ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { Buffer as NodeBuffer } from 'node:buffer';
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    try {
      if (${withoutBuffer}) delete globalThis.Buffer;
      const { storedDataToString, resolveMigrationStorage, MIGRATION_STORAGE_DOMAIN } =
        await import(${JSON.stringify(moduleUrl)});
      const text = '\\uFEFF{"message":"café 日本語 🌍"}';
      const bytes = new TextEncoder().encode(text);
      ${body}
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor);
      else delete globalThis.Buffer;
    }
  `], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

describe('MigrationStorage byte compatibility', () => {
  for (const enveloped of [false, true]) {
    test(`decodes ${enveloped ? 'enveloped' : 'raw'} UTF-8 bytes without Buffer`, () => {
      runIsolated(`
        assert.equal(typeof Buffer, 'undefined');
        const padded = new Uint8Array(bytes.length + 4).fill(0x78);
        padded.set(bytes, 2);
        const slice = padded.subarray(2, 2 + bytes.length);
        const wrap = data => ${enveloped ? '({ content: data })' : 'data'};
        assert.equal(storedDataToString(wrap(slice)), text);
        assert.equal(storedDataToString(wrap(new Uint8Array())), '');
        const malformed = new Uint8Array([0x61, 0xc3, 0x28, 0xff]);
        assert.equal(storedDataToString(wrap(malformed)), NodeBuffer.from(malformed).toString('utf8'));
      `);
    });
  }

  test('canonical writes keep strings, domain, keys and precedence without Buffer', () => {
    runIsolated(`
      const values = new Map();
      const adapter = {
        async putObject(domain, key, content, options) {
          assert.equal(domain, MIGRATION_STORAGE_DOMAIN);
          assert.equal(key, 'checkpoint/日本語');
          assert.equal(content, text);
          assert.deepEqual(options, { contentType: 'application/json' });
          values.set(key, new TextEncoder().encode(content));
          return key;
        },
        async getObject(domain, key) {
          assert.equal(domain, MIGRATION_STORAGE_DOMAIN);
          return values.get(key);
        },
        async put() { assert.fail('legacy write selected'); },
        async get() { assert.fail('legacy read selected'); }
      };
      const storage = resolveMigrationStorage({ storageAdapter: adapter });
      await storage.putText('checkpoint/日本語', text);
      assert.equal(await storage.getText('checkpoint/日本語'), text);
      values.set('checkpoint/日本語', { content: bytes });
      assert.equal(await storage.getText('checkpoint/日本語'), text);
      assert.equal(await storage.getText('missing'), null);
    `);
  });

  test('legacy put/get round trips UTF-8 Uint8Array without Buffer', () => {
    runIsolated(`
      const values = new Map();
      const storage = resolveMigrationStorage({ storageAdapter: {
        async put(key, content, options) {
          assert.equal(key, 'checkpoint/日本語');
          assert.ok(content instanceof Uint8Array);
          assert.equal(NodeBuffer.isBuffer(content), false);
          assert.deepEqual(content, bytes);
          assert.deepEqual(options, { contentType: 'application/json' });
          values.set(key, content);
        },
        async get(key) { return values.get(key); }
      } });
      await storage.putText('checkpoint/日本語', text);
      assert.equal(await storage.getText('checkpoint/日本語'), text);
      values.set('checkpoint/日本語', { content: bytes });
      assert.equal(await storage.getText('checkpoint/日本語'), text);
      assert.equal(await storage.getText('missing'), null);
    `);
  });

  test('preserves Buffer-based legacy Node adapters', () => {
    runIsolated(`
      let saved;
      const storage = resolveMigrationStorage({ storageAdapter: {
        async put(key, content) {
          assert.ok(Buffer.isBuffer(content));
          assert.equal(content.toString('utf8'), text);
          saved = content;
        },
        async get() { return saved; }
      } });
      await storage.putText('checkpoint/node', text);
      assert.equal(await storage.getText('checkpoint/node'), text);
      assert.equal(storedDataToString({ content: saved }), text);
      const padded = Buffer.concat([Buffer.from('xx'), saved, Buffer.from('yy')]);
      assert.equal(storedDataToString(padded.subarray(2, -2)), text);
    `, false);
  });

  test('preserves strings and absent results for both adapter shapes without Buffer', () => {
    runIsolated(`
      assert.equal(storedDataToString(text), text);
      assert.equal(storedDataToString({ content: text }), text);
      assert.throws(() => storedDataToString({ content: 42 }), /Unsupported storage adapter result shape/);
      for (const canonical of [true, false]) {
        for (const value of [null, undefined, '', text, { content: '' }, { content: text }]) {
          const adapter = canonical
            ? { async putObject() {}, async getObject() { return value; } }
            : { async put() {}, async get() { return value; } };
          const storage = resolveMigrationStorage({ storageAdapter: adapter });
          const expected = value == null ? null : typeof value === 'string' ? value : value.content;
          assert.equal(await storage.getText('checkpoint/1'), expected);
        }
      }
    `);
  });
});
