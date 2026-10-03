import { beforeAll, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createContext, runInContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { StructuredError } from '@originals/cel';
import * as utxo from '../../../src/bitcoin/utxo.js';
import type { BuildPsbtParams, PSBTBuilder } from '../../../src/bitcoin/PSBTBuilder.js';

let compiledSource: string;

beforeAll(async () => {
  const source = await Bun.file(new URL('../../../src/bitcoin/PSBTBuilder.ts', import.meta.url)).text();
  compiledSource = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
  }).outputText;
});

function builderInContext(globals: Record<string, unknown>) {
  // Compile the real module into an isolated realm without changing host globals.
  const context = createContext({
    TextEncoder,
    ...globals,
    exports: {},
    require: (id: string) => {
      if (id === './utxo.js') return utxo;
      if (id === '@originals/cel') return { StructuredError };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  expect(runInContext('typeof global', context)).toBe('undefined');
  expect(runInContext('typeof Buffer', context)).toBe(typeof globals.Buffer);
  runInContext(compiledSource, context);
  return runInContext('new exports.PSBTBuilder()', context) as PSBTBuilder;
}

function params(address = 'to'): BuildPsbtParams {
  return {
    utxos: [{ txid: 'a', vout: 0, value: 10_000 }],
    outputs: [{ address, value: 1_000 }],
    changeAddress: 'change',
    feeRate: 1,
    network: 'regtest',
  };
}

describe('PSBTBuilder browser base64 (issue #706)', () => {
  for (const address of ['to', 'caf\u00e9 \u6771\u4eac \ud83e\uddc5']) {
    test(`encodes UTF-8 payload for ${address} without Node globals`, () => {
      // Native btoa rejects non-Latin-1 strings, just like a browser.
      const browser = builderInContext({ btoa: globalThis.btoa });
      const node = builderInContext({ Buffer });
      const result = browser.build(params(address));
      const expected = node.build(params(address));
      expect(result.psbtBase64).toBe(expected.psbtBase64);
      const json = Buffer.from(result.psbtBase64, 'base64').toString('utf8');
      expect(JSON.parse(json)).toEqual({
        version: 0,
        inputs: [{ txid: 'a', vout: 0 }],
        outputs: [...params(address).outputs, result.changeOutput],
        fee: result.fee,
      });
      expect(result.psbtBase64).toBe(Buffer.from(json, 'utf8').toString('base64'));
    });
  }

  test('throws a structured error when no base64 encoder is available', () => {
    const builder = builderInContext({});
    expect(() => builder.build(params())).toThrow(
      expect.objectContaining({ code: 'PSBT_ENCODING_FAILED' })
    );
  });

  test('throws a structured error when the browser encoder fails', () => {
    const builder = builderInContext({ btoa: () => { throw new Error('Encoder failed'); } });
    expect(() => builder.build(params())).toThrow(
      expect.objectContaining({ code: 'PSBT_ENCODING_FAILED' })
    );
  });

  test('throws a structured error when the Node encoder fails', () => {
    const builder = builderInContext({ Buffer: { from: () => { throw new Error('Encoder failed'); } } });
    expect(() => builder.build(params())).toThrow(
      expect.objectContaining({ code: 'PSBT_ENCODING_FAILED' })
    );
  });
});
