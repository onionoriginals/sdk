/**
 * Security regression tests for the attack scenarios closed by the
 * critical/high issue sweep (PR #296). Per CLAUDE.md, security-sensitive code
 * requires coverage under tests/security/ — these exercise each fix from the
 * attacker's side. Deeper behavioral coverage lives in the unit suites.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { encode, decode } from '../../src/utils/cbor';
import { decodeBase64UrlMultibase, encodeBase64UrlMultibase } from '../../src/utils/encoding';
import { LocalStorageAdapter } from '../../src/storage/LocalStorageAdapter';
import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';
import { StatusListManager } from '../../src/vc/StatusListManager';
import { selectUtxos as selectUtxosSimple } from '../../src/bitcoin/utxo-selection';

describe('CBOR prototype pollution (issues #236/#278)', () => {
  test('a __proto__ map key cannot reassign the decoded object prototype', () => {
    const malicious = encode({ ['__proto__']: { polluted: true }, x: 1 });
    const decoded = decode<Record<string, unknown>>(malicious);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    // the key is preserved as an ordinary own property
    expect(Object.getOwnPropertyNames(decoded)).toContain('__proto__');
  });
});

describe('proofValue malleability (issue #250)', () => {
  test('distinct proofValue strings cannot decode to the same bytes', () => {
    const valid = encodeBase64UrlMultibase(new Uint8Array([1, 2, 3, 250]));
    for (const mutated of [valid + '!', valid + ' ', 'u' + 'ab\ncd', valid + '=']) {
      expect(() => decodeBase64UrlMultibase(mutated)).toThrow();
    }
  });
});

describe('LocalStorageAdapter path traversal (issue #251)', () => {
  test("a '..' domain cannot write outside baseDir", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-lsa-'));
    const baseDir = path.join(parent, 'storage');
    fs.mkdirSync(baseDir);
    const adapter = new LocalStorageAdapter({ baseDir });
    await expect(adapter.putObject('..', 'secret/pwned.txt', 'x'))
      .rejects.toThrow(/outside the storage directory/);
    expect(fs.existsSync(path.join(parent, 'secret'))).toBe(false);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('revocation bypass via fabricated status list (issue #238)', () => {
  test('an unsigned all-zeros status list cannot clear a revoked credential', async () => {
    const dm = new DIDManager({} as never);
    const slMgr = new StatusListManager();
    const entry = slMgr.allocateStatusEntry('https://issuer.example/status/sec', 3, 'revocation');
    const credential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:holder' },
      credentialStatus: entry,
    };
    // Attacker-supplied list: right id + purpose, all zeros, NO proof
    const fabricated = slMgr.createStatusListCredential({
      id: 'https://issuer.example/status/sec',
      issuer: 'did:example:issuer',
      statusPurpose: 'revocation',
    });
    const verifier = new Verifier(dm, { statusListResolver: async () => fabricated });
    const result = await verifier.checkCredentialStatus(credential as never);
    expect(result.verified).toBe(false);
  });
});

describe('inscription-bearing UTXOs as fee inputs (issue #249)', () => {
  test('exported selector refuses to spend an inscribed UTXO even when it is the only option', () => {
    expect(() => selectUtxosSimple(
      [{ txid: 'inscribed', vout: 0, value: 1_000_000, inscriptions: ['abci0'] } as never],
      { targetAmount: 10_000 }
    )).toThrow(/inscriptions\/resources or are locked/);
  });
});
