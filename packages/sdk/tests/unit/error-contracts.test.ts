import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StructuredError } from '@originals/cel';
import { LocalStorageAdapter } from '../../src/storage/LocalStorageAdapter.js';
import { SignetProvider } from '../../src/bitcoin/providers/SignetProvider.js';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient.js';
import { MigrationManager } from '../../src/migration/MigrationManager.js';
import { MigrationErrorType } from '../../src/migration/types.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function rejection(operation: Promise<unknown>, code: string, message: string | RegExp) {
  const error = await operation.then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(StructuredError);
  expect((error as StructuredError).code).toBe(code);
  if (typeof message === 'string') expect((error as Error).message).toBe(message);
  else expect((error as Error).message).toMatch(message);
  return error as StructuredError;
}

describe('reported error contracts #833–836', () => {
  for (const method of ['putObject', 'getObject', 'exists'] as const) {
    test(`#833 ${method} rejects traversal without touching the outside file`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'error-contracts-'));
      try {
        const outside = join(root, 'sentinel');
        await writeFile(outside, 'untouched');
        const adapter = new LocalStorageAdapter({ baseDir: join(root, 'storage') });
        const call = (domain: string, path: string) => method === 'putObject'
          ? adapter.putObject(domain, path, 'overwritten') : adapter[method](domain, path);
        await rejection(call('example.com', '../../sentinel'), 'STORAGE_PATH_TRAVERSAL',
          'Invalid object path: resolves outside the storage directory: ../../sentinel');
        await rejection(call('..', 'sentinel'), 'STORAGE_PATH_TRAVERSAL', /Invalid domain/);
        expect(await readFile(outside, 'utf8')).toBe('untouched');
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  for (const configured of [false, true]) {
    for (const method of ['createInscription', 'transferInscription'] as const) {
      test(`#834 ${method}, RPC configured=${configured}, rejects without network activity`, async () => {
        let calls = 0;
        globalThis.fetch = (async () => { calls++; throw new Error('unexpected fetch'); }) as typeof fetch;
        const provider = new SignetProvider({ ordUrl: 'http://ord.test', bitcoinRpcUrl: configured ? 'http://rpc.test' : undefined });
        const operation = method === 'createInscription'
          ? provider.createInscription({ data: new Uint8Array([1]), contentType: 'text/plain' })
          : provider.transferInscription('abc123i0', 'tb1qexample');
        await rejection(operation, configured ? 'ORD_PROVIDER_UNSUPPORTED' : 'ORD_RPC_NOT_CONFIGURED',
          configured ? /Programmatic inscription .* is not yet supported/ : /requires a funded signet wallet/);
        expect(calls).toBe(0);
      });
    }
  }
  for (const candidate of ['http://[', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/']) {
    test(`#835 rejects content_url ${candidate} before fetching it`, async () => {
      const fetched: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        fetched.push(String(url));
        return Response.json({ content_url: candidate });
      }) as typeof fetch;
      const error = await rejection(new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1'),
        'ORD_SSRF_BLOCKED', /malformed content_url|possible SSRF/);
      if (candidate === 'http://[') {
        expect(error.details).toEqual({ causeMessage: expect.any(String), causeName: 'TypeError' });
        expect(JSON.parse(JSON.stringify(error.details))).toEqual(error.details);
      }
      expect(fetched).toEqual(['http://ord.test/inscription/i1']);
    });
  }
  for (const stage of ['index', 'content'] as const) {
    test(`#835 ${stage} connection refusal has a stable code and serializable cause`, async () => {
      const cause = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
      const fetched: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        fetched.push(String(url));
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (String(url).includes('/inscription/')) {
          expect(init?.headers).toEqual({ Accept: 'application/json' });
          if (stage === 'content') return Response.json({ content_url: '/content/i1' });
        }
        throw cause;
      }) as typeof fetch;
      const error = await rejection(new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1'),
        'ORD_FETCH_FAILED', cause.message);
      expect(error.details).toEqual({ causeMessage: cause.message, causeName: cause.name });
      expect(JSON.parse(JSON.stringify(error.details))).toEqual(error.details);
      expect(fetched).toEqual(stage === 'index' ? ['http://ord.test/inscription/i1']
        : ['http://ord.test/inscription/i1', 'http://ord.test/content/i1']);
    });
  }
  test('#835 content HTTP failure preserves its message with a stable code', async () => {
    let bodyRead = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/inscription/')) return Response.json({});
      const response = new Response('unavailable', { status: 503 });
      response.arrayBuffer = async () => { bodyRead = true; return new ArrayBuffer(0); };
      return response;
    }) as typeof fetch;
    await rejection(new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1'),
      'ORD_FETCH_FAILED', 'Failed to fetch inscription content: 503');
    expect(bodyRead).toBe(false);
  });
  test('#835 index HTTP 404 still returns null without fetching content', async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    expect(await new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1')).toBeNull();
    expect(fetched).toEqual(['http://ord.test/inscription/i1']);
  });
  test('#835 invalid index JSON remains a parsing error', async () => {
    globalThis.fetch = (async () => new Response('{invalid')) as typeof fetch;
    await expect(new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1')).rejects.toBeInstanceOf(SyntaxError);
  });
  for (const stage of ['index', 'content'] as const) {
    test(`#835 ${stage} body read rejection remains unchanged`, async () => {
      const cause = new Error('body read failed');
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (stage === 'content' && String(url).includes('/inscription/')) return Response.json({});
        const response = new Response('');
        response.arrayBuffer = async () => { throw cause; };
        return response;
      }) as typeof fetch;
      await expect(new OrdinalsClient('http://ord.test', 'signet').resolveInscription('i1')).rejects.toBe(cause);
    });
  }
  for (const kind of ['content', 'json', 'metadata'] as const) {
    for (const declared of [true, false]) {
      test(`#835 ${kind} size limit, declared=${declared}`, async () => {
        let bodyRead = false;
        globalThis.fetch = (async (url: string | URL | Request) => {
          if (kind === 'content' && String(url).includes('/inscription/')) return Response.json({});
          const response = new Response('x'.repeat(17), { headers: declared ? { 'content-length': '17' } : {} });
          const original = response.arrayBuffer.bind(response);
          response.arrayBuffer = () => { bodyRead = true; return original(); };
          return response;
        }) as typeof fetch;
        const client = new OrdinalsClient('http://ord.test', 'signet', { maxContentBytes: 16, maxJsonBytes: 16 });
        const operation = kind === 'content' ? client.resolveInscription('i1')
          : kind === 'json' ? client.getSatInfo('1') : client.getMetadata('i1');
        // Preserve metadata's existing null result for materialized oversized data.
        if (kind === 'metadata' && !declared) expect(await operation).toBeNull();
        else await rejection(operation, kind === 'content' ? 'ORD_CONTENT_TOO_LARGE' : 'ORD_JSON_TOO_LARGE', /exceeds 16 bytes/);
        expect(bodyRead).toBe(!declared);
      });
    }
  }
  test('#836 migration factory returns StructuredError and preserves metadata', () => {
    // Factory-only test avoids singleton state and unsupported legacy migration setup.
    const factory = (MigrationManager.prototype as unknown as {
      createMigrationError(type: MigrationErrorType, code: string, message: string, migrationId?: string, details?: Record<string, unknown>):
        StructuredError & { type: MigrationErrorType; migrationId?: string };
    }).createMigrationError;
    const details = { errors: [{ code: 'INVALID_INPUT' }] };
    const error = factory.call(MigrationManager.prototype, MigrationErrorType.VALIDATION_ERROR, 'VALIDATION_FAILED', 'test message', 'mig-1', details);
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('test message');
    expect(error.type).toBe(MigrationErrorType.VALIDATION_ERROR);
    expect(error.migrationId).toBe('mig-1');
    expect(error.details).toBe(details);
    const bare = factory.call(MigrationManager.prototype, MigrationErrorType.VALIDATION_ERROR, 'VALIDATION_FAILED', 'test');
    expect(bare).toBeInstanceOf(StructuredError);
    expect(bare.details).toBeUndefined();
    expect(bare.migrationId).toBeUndefined();
  });
});
