// Generates reference evidence from public test keys and non-Originals libraries.
// The corresponding checker reads the saved corpus without regenerating it.
import { readFileSync, writeFileSync } from 'node:fs';
import { bytes, digest, copy, keyFixture, makeEntry, signingEvidence, encodeCbor, base58 } from './profile-reference.mjs';

const here = new URL('./', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, here), 'utf8'));
const write = (name, value) => writeFileSync(new URL(name, here), JSON.stringify(value, null, 2) + '\n');
const ed = keyFixture('ed25519', Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
function publishedKey(name) {
  const literal = read(`published-w3c/ecdsa-jcs-2019-${name}.json`).examples[0].literal;
  const multikey = base58.decode(/secretKeyMultibase["']?\s*:\s*"z([^"]+)"/.exec(literal)[1]);
  return keyFixture(name, multikey.slice(2));
}
const p256 = publishedKey('p256'), p384 = publishedKey('p384');
const png = readFileSync(new URL('../../regtest/examples/content.png', here));
const resource = { id: 'art.png', mediaType: 'image/png', digestMultibase: digest(png) };
const profile = 'originals/cel/3', time = '2026-09-05T00:00:00.000Z';
const creation = (key, metadata) => makeEntry({ operation: { type: 'create', data: { profile, controller: key.controller, createdAt: time, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'art.png', resources: [copy(resource)], ...(metadata ? { metadata } : {}) } } }, key);
const genesis = creation(ed);
const follow = (previous, type, data, key = ed) => makeEntry({ previousEvent: digest(bytes(previous.event)), operation: { type, data: { profile, ...data } } }, key);
const renamed = follow(genesis, 'update', { name: 'A second title' });
const changed = follow(renamed, 'update', { resources: [{ ...resource, digestMultibase: digest(Buffer.from('next file bytes')), previousDigestMultibase: resource.digestMultibase }] });
const migrated = follow(genesis, 'migrate', { from: 'did:cel:' + digest(bytes(genesis.event)), to: 'did:webvh:fixture:example.com:art', layer: 'webvh', migratedAt: time });
const anchored = follow(migrated, 'migrate', { from: 'did:webvh:fixture:example.com:art', to: 'did:btco:reg:5000000000', layer: 'btco', migratedAt: time });
const rotated = follow(genesis, 'rotateKey', { newController: p256.controller, rotatedAt: time });
const deactivated = follow(genesis, 'deactivate', { deactivatedAt: time, reason: 'Fixture retirement' });
const accepted = [];
function accept(id, entries, options = {}) {
  const document = { log: entries };
  const evidence = entries.map(entry => {
    const proofs = Array.isArray(entry.proof) ? entry.proof : [entry.proof];
    return proofs.map(({ proofValue, ...config }) => ({ ...signingEvidence(entry.event, config, config.cryptosuite === 'ecdsa-jcs-2019' && config.verificationMethod.startsWith(p384.controller) ? 'sha384' : 'sha256'), signatureHex: Buffer.from(base58.decode(proofValue.slice(1))).toString('hex') }));
  });
  accepted.push({ id, scope: options.scope ?? 'Representation, proof construction and internal hash links only; no complete Originals authorization/fold or Bitcoin claim.', document,
    expected: { status: options.status ?? 'wire-proof-chain-valid', ...(entries[0].event.operation.type === 'create' ? { didCel: 'did:cel:' + digest(bytes(entries[0].event)) } : {}), head: digest(bytes(entries.at(-1).event)), entries: evidence },
    cborHex: Buffer.from(encodeCbor(document)).toString('hex'), ...options });
}
accept('ed25519-create', [genesis]);
accept('p256-create', [creation(p256)]);
accept('p384-create', [creation(p384)]);
const metadata = JSON.parse('{"10":"ten","2":"two","__proto__":{"signed":"retained"},"constructor":"constructor value","prototype":"prototype value","nested":[{"10":10,"2":2}],"é":"composed","é":"decomposed","😀":"non-BMP","דּ":"BMP","number":1e30}');
accept('metadata-key-and-unicode-preservation', [creation(ed, metadata)]);
const single = copy(genesis); single.proof = single.proof[0];
accept('single-proof-object', [single]);
const noDate = makeEntry(copy(genesis.event), ed, { created: undefined });
accept('proof-created-omitted', [noDate]);
const multiple = copy(genesis); multiple.proof.push(noDate.proof[0]);
accept('multiple-controller-proofs', [multiple]);
const reversed = copy(multiple); reversed.proof.reverse();
accept('proof-order-does-not-change-identity', [reversed]);
accept('create-and-two-updates', [genesis, renamed, changed]);
accept('delta-needs-history', [renamed, changed], { status: 'history-required' });
accept('delta-with-prior-head', [renamed, changed], { priorDigest: digest(bytes(genesis.event)) });
accept('rotation-wire', [genesis, rotated]);
accept('deactivation-wire', [genesis, deactivated]);
accept('migration-wire', [genesis, migrated, anchored], { scope: 'Wire/proof only. The WebVH alias is a syntax illustration, not a resolvable DID or verified WebVH identity; no Bitcoin publication exists.' });

const rejected = [];
function reject(id, mutate, stage = 'structure', source = { log: [genesis] }) {
  const document = copy(source); mutate(document);
  rejected.push({ id, stage, document, expected: 'rejected' });
}
reject('old-events-wrapper', d => { d.events = d.log; delete d.log; });
reject('old-did-document-wrapper', d => { d.didDocument = { id: 'did:btco:reg:1' }; d.celLog = d.log; delete d.log; });
reject('entry-type-data-in-old-position', d => { d.log[0] = { ...d.log[0].event.operation, proof: d.log[0].proof }; });
reject('missing-profile', d => { delete d.log[0].event.operation.data.profile; });
reject('unknown-profile', d => { d.log[0].event.operation.data.profile = 'originals/cel/99'; });
reject('data-did-cannot-select-identity', d => { d.log[0].event.operation.data.did = 'did:cel:claimed'; });
reject('data-and-dataReference', d => { d.log[0].event.operation.dataReference = { digestMultibase: resource.digestMultibase }; });
reject('dataReference-array-is-not-CCG', d => { delete d.log[0].event.operation.data; d.log[0].event.operation.dataReference = [resource]; });
reject('empty-log', d => { d.log = []; });
reject('empty-proof-array', d => { d.log[0].proof = []; });
reject('too-many-proofs', d => { d.log[0].proof = Array.from({ length: 9 }, () => copy(genesis.proof[0])); });
reject('genesis-previous-null', d => { d.log[0].event.previousEvent = null; });
reject('genesis-previous-digest', d => { d.log[0].event.previousEvent = digest(bytes(genesis.event)); });
reject('unknown-operation', d => { d.log[0].event.operation.type = 'transfer'; });
reject('holder-author', d => { d.log[0].event.operation.data.author = ed.controller; });
reject('custom-proof-label', d => { d.log[0].proof[0].type = 'OriginalsCelProof'; });
reject('custom-suite-label', d => { d.log[0].proof[0].cryptosuite = 'originals-cel-ed25519-jcs-v1'; });
reject('wrong-purpose', d => { d.log[0].proof[0].proofPurpose = 'authentication'; });
reject('proof-chain-unsupported', d => { d.log[0].proof[0].previousProof = 'urn:proof:1'; });
reject('cached-bitcoin-proof-fields', d => { d.log[0].proof[0].blockHeight = 101; });
reject('leap-second-proof-time', d => { d.log[0].proof[0].created = '2016-12-31T23:59:60Z'; });
reject('invalid-calendar-date', d => { d.log[0].event.operation.data.createdAt = '2026-02-30T00:00:00Z'; });
reject('lowercase-time', d => { d.log[0].proof[0].created = '2026-09-05t00:00:00z'; });
reject('empty-resource-urls', d => { d.log[0].event.operation.data.resources[0].url = []; });
reject('relative-resource-url', d => { d.log[0].event.operation.data.resources[0].url = ['art.png']; });
reject('malformed-percent-url', d => { d.log[0].event.operation.data.resources[0].url = ['https://example.com/%xx']; });
reject('media-type-parameter-outside-profile', d => { d.log[0].event.operation.data.resources[0].mediaType = 'image/png; charset=utf-8'; });
reject('duplicate-resource-id', d => { d.log[0].event.operation.data.resources.push(copy(resource)); }, 'semantic');
reject('noncanonical-nonce', d => { d.log[0].event.operation.data.nonce = 'AAAAAAAAAAAAAAAAAAAAAB'; }, 'semantic');
reject('padded-resource-digest', d => { d.log[0].event.operation.data.resources[0].digestMultibase += '='; });
reject('name-changed-after-signing', d => { d.log[0].event.operation.data.name = 'Changed'; }, 'proof');
reject('own-prototype-value-changed', d => { d.log[0].event.operation.data.metadata.__proto__.signed = 'changed'; }, 'proof', { log: [creation(ed, metadata)] });
reject('numeric-looking-key-value-changed', d => { d.log[0].event.operation.data.metadata['2'] = 'changed'; }, 'proof', { log: [creation(ed, metadata)] });
reject('verification-method-fragment-mismatch', d => { d.log[0].proof[0].verificationMethod = ed.controller + '#' + p256.fingerprint; }, 'proof');
reject('suite-key-mismatch', d => { d.log[0].proof[0].cryptosuite = 'ecdsa-jcs-2019'; }, 'proof');
reject('one-valid-one-invalid-proof', d => { d.log[0].proof.push({ ...d.log[0].proof[0], proofValue: 'z' + '1'.repeat(64) }); }, 'proof');
reject('missing-previous-event', d => { delete d.log[1].event.previousEvent; }, 'structure', { log: [genesis, renamed] });
const brokenChain = follow(creation(p256), 'update', { name: 'Wrong predecessor' });
rejected.push({ id: 'valid-signature-wrong-chain-link', stage: 'chain', document: { log: [genesis, brokenChain] }, expected: 'rejected' });
rejected.push({ id: 'valid-log-wrong-requested-DID', stage: 'identity', document: { log: [genesis] }, expectedDid: 'did:cel:' + resource.digestMultibase, expected: 'rejected' });
const wrongWrapper = makeEntry({ event: copy(genesis.event) }, ed).proof;
rejected.push({ id: 'signature-over-wrong-wrapper', stage: 'proof', document: { log: [{ event: copy(genesis.event), proof: wrongWrapper }] }, expected: 'rejected' });
write('profile-documents.json', {
  provenance: 'Public RFC8032/W3C keys; json-canonicalize 2.0.0, Node SHA-2, Noble2.2.0 signing, cborg5.1.7 encoding. No Originals production code. Expected acceptance/rejection is declared from the written profile, not obtained from the reference checker. Node/OpenSSL independently checks signatures.',
  coverage: 'Representation, schema, selected semantic checks, signatures, event digests, internal previousEvent links and genesis DID binding. No full fold/controller succession, WebVH identity, Bitcoin/provider behavior, runtime-object validation or resource retrieval.',
  accepted, rejected,
});
write('transport-inputs.json', {
  json: [
    { id: 'numeric-and-prototype-member-names', source: '{"10":10,"2":2,"__proto__":{"x":1}}', expected: 'accepted' },
    { id: 'composed-and-decomposed-unicode', source: '{"é":1,"é":2}', expected: 'accepted' },
    { id: 'duplicate-decoded-key', source: '{"name":1,"name":2}', expected: 'rejected' },
    { id: 'escaped-duplicate-key', source: '{"name":1,"\\u006eame":2}', expected: 'rejected' },
    { id: 'lone-surrogate-value', source: '{"x":"\\ud800"}', expected: 'rejected' },
    { id: 'lone-surrogate-key', source: '{"\\udfff":1}', expected: 'rejected' },
    { id: 'nonfinite-number', source: '{"x":1e999}', expected: 'rejected' },
    { id: 'multiple-json-documents', source: '{}{}', expected: 'rejected' },
    { id: 'json-bom', source: '\ufeff{}', expected: 'rejected' },
  ],
  cbor: [
    ['integer-one', 'a1616101', 'accepted'], ['float-one-same-value', 'a16161f93c00', 'accepted'],
    ['alternate-integer-width', 'a161611801', 'accepted'], ['negative-zero', 'a16161f98000', 'accepted'],
    ['exact-large-integer', 'a161611b2000000000000000', 'accepted'],
    ['duplicate-map-key', 'a2616101616102', 'rejected'], ['non-text-map-key', 'a10101', 'rejected'],
    ['byte-string', 'a161614101', 'rejected'], ['tag', 'a16161c000', 'rejected'],
    ['undefined', 'a16161f7', 'rejected'], ['infinity', 'a16161f97c00', 'rejected'],
    ['nan', 'a16161f97e00', 'rejected'], ['invalid-utf8', 'a1616161ff', 'rejected'],
    ['indefinite-map', 'bf616101ff', 'rejected'], ['trailing-item', 'a000', 'rejected'],
    ['inexact-large-integer', 'a161611b2000000000000001', 'rejected'],
  ].map(([id, hex, expected]) => ({ id, hex, expected })),
});
console.log(JSON.stringify({ acceptedDocuments: accepted.length, rejectedDocuments: rejected.length, jsonInputs: 9, cborInputs: 16 }));
