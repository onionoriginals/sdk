// Independent reference tooling for the written profile; NOT production code.
// No Originals imports, network requests, wallets or broadcast operations.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const celRequire = createRequire(new URL('../../../packages/cel/package.json', import.meta.url));
export const { canonicalize } = rootRequire('./node_modules/.bun/json-canonicalize@2.0.0/node_modules/json-canonicalize');
const { default: Ajv } = rootRequire('./node_modules/.bun/ajv@8.20.0/node_modules/ajv/dist/2020');
export const { p256, p384 } = await import(celRequire.resolve('@noble/curves/nist.js'));
export const { ed25519 } = await import(celRequire.resolve('@noble/curves/ed25519.js'));
export const { base58 } = await import(celRequire.resolve('@scure/base'));
const { encode, decode, Tokenizer, rfc8949EncodeOptions } = await import('../../../packages/cel/node_modules/cborg/cborg.js');
export const bytes = value => Buffer.from(canonicalize(value), 'utf8');
export const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest();
export const digest = value => 'u' + Buffer.concat([Buffer.from([0x12, 0x20]), hash(value)]).toString('base64url');
export const mb58 = value => 'z' + base58.encode(value);
export const copy = value => JSON.parse(JSON.stringify(value));

const suites = {
  ed25519: { curve: ed25519, hash: 'sha256', suite: 'eddsa-jcs-2022', codec: [0xed, 0x01], length: 32, signature: 64, spki: '302a300506032b6570032100' },
  p256: { curve: p256, hash: 'sha256', suite: 'ecdsa-jcs-2019', codec: [0x80, 0x24], length: 33, signature: 64, spki: '3039301306072a8648ce3d020106082a8648ce3d030107032200' },
  p384: { curve: p384, hash: 'sha384', suite: 'ecdsa-jcs-2019', codec: [0x81, 0x24], length: 49, signature: 96, spki: '3046301006072a8648ce3d020106052b81040022033200' },
};
export function keyFixture(name, secret) {
  const spec = suites[name];
  const publicKey = spec.curve.getPublicKey(secret);
  const fingerprint = mb58(Buffer.concat([Buffer.from(spec.codec), publicKey]));
  return { ...spec, name, secret, publicKey, fingerprint, controller: 'did:key:' + fingerprint };
}
export function decodeController(controller) {
  assert.match(controller, /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
  const fingerprint = controller.slice(8);
  const encoded = base58.decode(fingerprint.slice(1));
  assert.equal(mb58(encoded), fingerprint);
  const spec = Object.values(suites).find(s => encoded.length === s.length + 2 && s.codec.every((b, i) => b === encoded[i]));
  assert.ok(spec, 'unsupported controller codec');
  const publicKey = encoded.slice(2);
  // Node/OpenSSL parses the actual public-key encoding, not just its prefix.
  const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from(spec.spki, 'hex'), publicKey]) });
  return { ...spec, key, fingerprint, publicKey };
}
export function signingEvidence(event, options, algorithm) {
  const eventBytes = bytes(event), proofBytes = bytes(options);
  const message = Buffer.concat([hash(proofBytes, algorithm), hash(eventBytes, algorithm)]);
  return {
    canonicalEvent: eventBytes.toString('utf8'), eventUtf8Hex: eventBytes.toString('hex'),
    eventDigest: digest(eventBytes), canonicalProofConfiguration: proofBytes.toString('utf8'),
    proofHashHex: hash(proofBytes, algorithm).toString('hex'), documentHashHex: hash(eventBytes, algorithm).toString('hex'),
    signingMessageHex: message.toString('hex'),
  };
}
export function makeEntry(event, key, changes = {}) {
  const options = { type: 'DataIntegrityProof', cryptosuite: key.suite, created: '2026-09-05T00:00:00.000Z', verificationMethod: key.controller + '#' + key.fingerprint, proofPurpose: 'assertionMethod', ...changes };
  if (options.created === undefined) delete options.created;
  const evidence = signingEvidence(event, options, key.hash);
  const signature = key.curve.sign(Buffer.from(evidence.signingMessageHex, 'hex'), key.secret, key.name === 'ed25519' ? undefined : { prehash: true, lowS: false });
  return { event, proof: [{ ...options, proofValue: mb58(signature) }] };
}
export function verifyProof(event, proof) {
  const controller = proof.verificationMethod.split('#')[0];
  const key = decodeController(controller);
  assert.equal(proof.verificationMethod, controller + '#' + key.fingerprint);
  assert.equal(proof.cryptosuite, key.suite);
  const { proofValue, ...options } = proof;
  const signature = base58.decode(proofValue.slice(1));
  assert.equal(mb58(signature), proofValue);
  assert.equal(signature.length, key.signature);
  const evidence = signingEvidence(event, options, key.hash);
  // Fixture generation uses Noble; the verification oracle uses Node/OpenSSL.
  const accepted = verify(key.suite === 'eddsa-jcs-2022' ? null : key.hash,
    Buffer.from(evidence.signingMessageHex, 'hex'),
    { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
  assert.equal(accepted, true, 'signature invalid');
  return { ...evidence, signatureHex: Buffer.from(signature).toString('hex'), signer: controller };
}

export function validTime(value) {
  const m = /^([0-9]{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?Z$/.exec(value);
  if (!m || +m[1] === 0) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.getUTCFullYear() === +m[1] && date.getUTCMonth() + 1 === +m[2] && date.getUTCDate() === +m[3];
}
export function validUrl(value) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\x00-\x20\x7f\\]/.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) return false;
  try { const url = new URL(value); return !/^https?:$/i.test(url.protocol) || (/^https?:\/\//i.test(value) && url.hostname.length > 0); } catch { return false; }
}
const ajv = new Ajv({ allErrors: true, strict: false, ownProperties: true });
ajv.addFormat('originals-time', validTime);
ajv.addFormat('absolute-url', validUrl);
ajv.addFormat('media-type', /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/);
export const schema = JSON.parse(readFileSync(new URL('../../../specs/originals-cel-v3.schema.json', import.meta.url), 'utf8'));
export const schemaValidate = ajv.compile(schema);
export function checkDigest(value) {
  assert.match(value, /^u[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(value.slice(1), 'base64url');
  assert.equal(decoded.length, 34);
  assert.equal(decoded[0], 0x12); assert.equal(decoded[1], 0x20);
  assert.equal('u' + decoded.toString('base64url'), value);
}
export function checkValues(value, depth = 0, budget = { nodes: 0 }) {
  assert.ok(++budget.nodes <= 100000, 'value limit');
  if (typeof value === 'string') { assert.ok(value.isWellFormed(), 'invalid Unicode'); assert.ok(Buffer.byteLength(value) <= 262144, 'string limit'); }
  else if (typeof value === 'number') assert.ok(Number.isFinite(value), 'nonfinite');
  else if (value && typeof value === 'object') {
    assert.ok(depth + 1 <= 64, 'depth limit');
    for (const [key, child] of Object.entries(value)) {
      assert.ok(key.isWellFormed() && Buffer.byteLength(key) <= 262144, 'invalid member name');
      checkValues(child, depth + 1, budget);
    }
  } else assert.ok(value === null || typeof value === 'boolean', 'non-JSON value');
}
export function checkDocument(document, expectedDid, priorDigest) {
  checkValues(document);
  assert.ok(bytes(document).length <= 10000000, 'document limit');
  assert.ok(schemaValidate(document), JSON.stringify(schemaValidate.errors));
  const results = [];
  let previous = priorDigest;
  for (const [i, entry] of document.log.entries()) {
    const { type, data } = entry.event.operation;
    if (type === 'create') {
      assert.equal(i, 0); assert.equal(previous, undefined);
      decodeController(data.controller);
      const nonce = Buffer.from(data.nonce, 'base64url');
      assert.equal(nonce.length, 16); assert.equal(nonce.toString('base64url'), data.nonce);
    } else {
      checkDigest(entry.event.previousEvent);
      if (previous !== undefined) assert.equal(entry.event.previousEvent, previous, 'chain mismatch');
    }
    if (data.newController) decodeController(data.newController);
    const ids = new Set();
    for (const resource of data.resources ?? []) {
      assert.equal(ids.has(resource.id), false, 'duplicate resource id'); ids.add(resource.id);
      checkDigest(resource.digestMultibase);
      if (resource.previousDigestMultibase) checkDigest(resource.previousDigestMultibase);
    }
    const proofs = Array.isArray(entry.proof) ? entry.proof : [entry.proof];
    const proofResults = proofs.map(p => verifyProof(entry.event, p));
    if (type === 'create') for (const p of proofResults) assert.equal(p.signer, data.controller, 'genesis controller mismatch');
    previous = digest(bytes(entry.event));
    results.push({ eventDigest: previous, proofs: proofResults });
  }
  const complete = document.log[0].event.operation.type === 'create';
  const did = complete ? 'did:cel:' + results[0].eventDigest : undefined;
  if (expectedDid !== undefined) assert.equal(did, expectedDid, 'DID mismatch');
  return { status: complete || priorDigest ? 'wire-proof-chain-valid' : 'history-required', ...(did ? { didCel: did } : {}), head: previous, entries: results };
}

export function encodeCbor(value) {
  // Canonical JSON materialization normalizes negative zero before CBOR encoding.
  function integerEncoding(child) {
    if (typeof child === 'number' && Number.isInteger(child) && !Number.isSafeInteger(child)) {
      const integer = BigInt(child);
      if (integer >= -(1n << 64n) && integer < (1n << 64n)) return integer;
    }
    if (Array.isArray(child)) return child.map(integerEncoding);
    if (child && typeof child === 'object') return Object.fromEntries(Object.entries(child).map(([k, v]) => [k, integerEncoding(v)]));
    return child;
  }
  return encode(integerEncoding(JSON.parse(canonicalize(value))), rfc8949EncodeOptions);
}
export function decodeCbor(input) {
  const options = { useMaps: true, allowIndefinite: false, allowUndefined: false, allowNaN: false, allowInfinity: false, allowBigInt: true, rejectDuplicateMapKeys: true, retainStringBytes: true };
  const tokenizer = new Tokenizer(input, options);
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  while (!tokenizer.done()) {
    const token = tokenizer.next();
    if (token.type.name === 'string') utf8.decode(token.byteValue);
    assert.ok(token.type.name !== 'bytes' && token.type.name !== 'tag', 'unsupported CBOR value');
  }
  function jsonValue(value) {
    if (value instanceof Map) {
      const result = Object.create(null);
      for (const [k, v] of value) { assert.equal(typeof k, 'string', 'non-text map key'); result[k] = jsonValue(v); }
      return result;
    }
    if (Array.isArray(value)) return value.map(jsonValue);
    if (typeof value === 'bigint') { const number = Number(value); assert.ok(Number.isFinite(number) && BigInt(number) === value, 'inexact CBOR integer'); return number; }
    return value;
  }
  const result = jsonValue(decode(input, options));
  checkValues(result);
  return result;
}
