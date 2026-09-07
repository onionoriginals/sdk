// Reads saved expected evidence; never regenerates it or imports Originals code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDocument, schemaValidate, decodeCbor, bytes, encodeCbor } from './profile-reference.mjs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const corpus = read('profile-documents.json');
for (const fixture of corpus.accepted) {
  const result = checkDocument(fixture.document, fixture.expected.didCel, fixture.priorDigest);
  assert.equal(result.status, fixture.expected.status, fixture.id);
  assert.equal(result.head, fixture.expected.head, fixture.id);
  for (const [index, expectedProofs] of fixture.expected.entries.entries()) {
    for (const [p, expected] of expectedProofs.entries()) {
      const { signer, ...actual } = result.entries[index].proofs[p];
      assert.deepEqual(actual, expected, fixture.id);
    }
  }
  const decoded = decodeCbor(Buffer.from(fixture.cborHex, 'hex'));
  assert.deepEqual(bytes(decoded), bytes(fixture.document), fixture.id + ': CBOR preserves canonical JSON');
  assert.equal(checkDocument(decoded, fixture.expected.didCel, fixture.priorDigest).head, result.head, fixture.id);
}
for (const fixture of corpus.rejected) {
  if (fixture.stage === 'structure') assert.equal(schemaValidate(fixture.document), false, fixture.id);
  else assert.equal(schemaValidate(fixture.document), true, fixture.id + ': not merely a schema rejection');
  assert.throws(() => checkDocument(fixture.document, fixture.expectedDid), undefined, fixture.id);
}
const inputs = read('transport-inputs.json');
for (const fixture of inputs.cbor) {
  if (fixture.expected === 'accepted') decodeCbor(Buffer.from(fixture.hex, 'hex'));
  else assert.throws(() => decodeCbor(Buffer.from(fixture.hex, 'hex')), undefined, fixture.id);
}
// Literal preferred encodings, independent of fixture generation.
assert.equal(Buffer.from(encodeCbor({ a: 1 })).toString('hex'), 'a1616101');
assert.equal(Buffer.from(encodeCbor({ a: -0 })).toString('hex'), 'a1616100');
assert.equal(Buffer.from(encodeCbor({ a: 2 ** 53 })).toString('hex'), 'a161611b0020000000000000');
assert.equal(Buffer.from(encodeCbor({ a: -(2 ** 64) })).toString('hex'), 'a161613bffffffffffffffff');
assert.equal(Buffer.from(encodeCbor({ a: 2 ** 64 })).toString('hex'), 'a16161fa5f800000');
console.log(JSON.stringify({ runtime: process.version, acceptedDocuments: corpus.accepted.length, rejectedDocuments: corpus.rejected.length, cborInputs: inputs.cbor.length, preferredEncodingCases: 5, status: 'passed', scope: corpus.coverage }, null, 2));
