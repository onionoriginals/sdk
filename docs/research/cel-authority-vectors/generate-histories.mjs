// Written decision scenarios, not Bitcoin observations or production test results.
// Expected outcomes below are hand-selected from the authority contract.
import { readFileSync, writeFileSync } from 'node:fs';
import { keyFixture, makeEntry, bytes, digest, copy, base58 } from '../cel-profile-vectors/profile-reference.mjs';
const here = new URL('./', import.meta.url);
const A = keyFixture('ed25519', Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
const published = JSON.parse(readFileSync(new URL('../cel-profile-vectors/published-w3c/ecdsa-jcs-2019-p256.json', here), 'utf8'));
const bSecret = base58.decode(/secretKeyMultibase["']?\s*:\s*"z([^"]+)"/.exec(published.examples[0].literal)[1]).slice(2);
const B = keyFixture('p256', bSecret);
const H = keyFixture('ed25519', Buffer.alloc(32, 7)); // Public scenario key; never funded.
const profile = 'originals/cel/3', time = '2026-09-05T00:00:00.000Z';
const web = 'did:webvh:fixture:example.com:art'; // Symbolic method binding, not a verified SCID.
const sat = '5000000000', btc = 'did:btco:reg:' + sat;
const d0 = digest(Buffer.from('version zero fixture bytes'));
const d1 = digest(Buffer.from('version one fixture bytes'));
const resource = { id: 'art.png', mediaType: 'image/png', digestMultibase: d0 };
const entries = {};
function add(id, type, data, previous, key = A) {
  const event = { ...(previous ? { previousEvent: digest(bytes(entries[previous].event)) } : {}), operation: { type, data: { profile, ...data } } };
  entries[id] = makeEntry(event, key);
  return id;
}
add('G', 'create', { controller: A.controller, createdAt: time, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Original', resources: [resource], metadata: { phase: 'creation' } });
const cel = 'did:cel:' + digest(bytes(entries.G.event));
add('W', 'migrate', { from: cel, to: web, layer: 'webvh', migratedAt: time }, 'G');
add('T', 'migrate', { from: web, to: btc, layer: 'btco', migratedAt: time }, 'W');
add('R', 'rotateKey', { newController: B.controller, rotatedAt: time }, 'T');
entries.Rwrong = makeEntry(copy(entries.R.event), B);
add('Aretired', 'update', { name: 'Rejected old key' }, 'R', A);
add('Bupdate', 'update', { name: 'Current key update' }, 'R', B);
add('Hupdate', 'update', { name: 'Holder-authored update' }, 'T', H);
add('U', 'update', { name: 'First branch' }, 'T');
add('V', 'update', { name: 'Second branch' }, 'T');
add('U2', 'update', { metadata: { phase: 'second update' } }, 'U');
add('D', 'deactivate', { deactivatedAt: time, reason: 'Done' }, 'R', B);
add('Dupdate', 'update', { name: 'Rejected after deactivation' }, 'D', B);
add('ReturnA', 'rotateKey', { newController: A.controller, rotatedAt: time }, 'R', B);
add('Aauthorized', 'update', { name: 'Explicitly reauthorized' }, 'ReturnA', A);
add('NoOpRotation', 'rotateKey', { newController: A.controller, rotatedAt: time }, 'T');
add('Resource', 'update', { resources: [{ ...resource, digestMultibase: d1, previousDigestMultibase: d0 }] }, 'T');
add('BadResource', 'update', { resources: [{ ...resource, digestMultibase: d1, previousDigestMultibase: digest(Buffer.from('wrong prior bytes')) }] }, 'T');
add('WrongFrom', 'migrate', { from: cel, to: btc, layer: 'btco', migratedAt: time }, 'W');
add('WrongSatClaim', 'migrate', { from: web, to: 'did:btco:reg:5000000001', layer: 'btco', migratedAt: time }, 'W');
add('LateMigration', 'migrate', { from: web, to: btc, layer: 'btco', migratedAt: time }, 'T');
add('G2', 'create', { controller: B.controller, createdAt: time, nonce: Buffer.alloc(16, 2).toString('base64url'), name: 'Another Original', resources: [resource], metadata: { phase: 'creation' } }, undefined, B);
const cel2 = 'did:cel:' + digest(bytes(entries.G2.event));
const web2 = 'did:webvh:fixture2:example.com:other';
add('W2', 'migrate', { from: cel2, to: web2, layer: 'webvh', migratedAt: time }, 'G2', B);
add('T2', 'migrate', { from: web2, to: btc, layer: 'btco', migratedAt: time }, 'W2', B);

function pub(id, eventIds, height = 102, tx = 1, index = 0, extras = {}) {
  return { id, entries: eventIds, sat, network: 'regtest', position: [height, tx, index], complete: true, confirmed: true, ...extras };
}
const boundary = pub('boundary', ['G', 'W', 'T'], 101, 1);
const rotation = pub('rotation', ['R']);
const snapshot = { network: 'regtest', sat, tipBefore: 'declared-tip-110', tipAfter: 'declared-tip-110', enumerationComplete: true, owner: 'A' };
const cases = [];
function expected(head = 'T', controller = 'A', changes = {}) {
  return { status: 'accepted-at-declared-snapshot', head, headDigest: digest(bytes(entries[head].event)), controller,
    name: 'Original', metadata: { phase: 'creation' }, active: true,
    resourceDigest: d0, resourceVersion: 1, aliases: [cel, web, btc], owner: 'A', ...changes };
}
function scenario(id, publications, expectation, changes = {}) {
  cases.push({ id, snapshot: { ...snapshot, ...changes }, publications, expected: expectation });
}
scenario('boundary-establishes-current-controller', [boundary], expected());
scenario('sale-changes-possession-only', [boundary], expected('T', 'A', { owner: 'H' }), { owner: 'H' });
scenario('holder-cannot-author', [boundary, pub('holder', ['Hupdate'])], expected('T', 'A', { owner: 'H' }), { owner: 'H' });
scenario('holder-can-publish-controller-authorized-bytes', [boundary, pub('authorized', ['U'])], expected('U', 'A', { name: 'First branch', owner: 'H' }), { owner: 'H' });
scenario('rotation-retires-A', [boundary, rotation], expected('R', 'B'));
scenario('new-key-cannot-authorize-its-own-rotation', [boundary, pub('wrong-rotation', ['Rwrong'])], expected());
scenario('retired-A-cannot-append-after-reacquisition', [boundary, rotation, pub('old-key', ['Aretired'], 103)], expected('R', 'B'));
scenario('current-B-can-append', [boundary, rotation, pub('new-key', ['Bupdate'], 103)], expected('Bupdate', 'B', { name: 'Current key update', owner: 'B' }), { owner: 'B' });
scenario('rotation-and-B-update-in-one-publication', [boundary, pub('batch', ['R', 'Bupdate'])], expected('Bupdate', 'B', { name: 'Current key update' }));
scenario('bad-second-entry-rolls-back-entire-publication', [boundary, pub('bad-batch', ['R', 'Aretired'])], expected());
scenario('same-block-separate-extension-is-too-early', [boundary, pub('first', ['U'], 102, 1), pub('second', ['U2'], 102, 2)], expected('U', 'A', { name: 'First branch' }));
scenario('same-block-internal-batch-is-valid', [boundary, pub('batch', ['U', 'U2'])], expected('U2', 'A', { name: 'First branch', metadata: { phase: 'second update' } }));
scenario('later-block-extension-is-valid', [boundary, pub('first', ['U'], 102), pub('second', ['U2'], 103)], expected('U2', 'A', { name: 'First branch', metadata: { phase: 'second update' } }));
scenario('same-block-fork-uses-numeric-transaction-position', [pub('tx-ten', ['U'], 102, 10, 0, { inscriptionNumber: -100 }), boundary, pub('tx-two', ['V'], 102, 2, 0, { inscriptionNumber: 100 })], expected('V', 'A', { name: 'Second branch' }));
scenario('same-transaction-fork-uses-numeric-envelope-index', [pub('index-ten', ['U'], 102, 1, 10), boundary, pub('index-two', ['V'], 102, 1, 2)], expected('V', 'A', { name: 'Second branch' }));
scenario('invalid-earlier-candidate-does-not-win', [boundary, pub('bad', ['Rwrong'], 102, 1), pub('good', ['R'], 102, 2)], expected('R', 'B'));
scenario('inspected-unrelated-bytes-do-not-poison', [boundary, pub('unrelated', [], 102, 1, 0, { unrelated: true }), pub('good', ['U'], 103)], expected('U', 'A', { name: 'First branch' }));
scenario('non-extending-branch-does-not-replace-head', [boundary, pub('first', ['U'], 102), pub('other', ['V'], 103)], expected('U', 'A', { name: 'First branch' }));
scenario('resource-update-is-bound-to-its-prior-digest', [boundary, pub('resource', ['Resource'])], expected('Resource', 'A', { resourceDigest: d1, resourceVersion: 2 }));
scenario('wrong-prior-resource-digest-is-ignored', [boundary, pub('bad-resource', ['BadResource'])], expected());
scenario('deactivation-is-terminal-for-authorship', [boundary, rotation, pub('deactivate', ['D'], 103), pub('after', ['Dupdate'], 104)], expected('D', 'B', { active: false, owner: 'H' }), { owner: 'H' });
scenario('explicit-current-key-rotation-can-reauthorize-A', [boundary, rotation, pub('return', ['ReturnA'], 103), pub('update', ['Aauthorized'], 104)], expected('Aauthorized', 'A', { name: 'Explicitly reauthorized' }));
scenario('no-op-rotation-is-invalid', [boundary, pub('no-op', ['NoOpRotation'])], expected());
scenario('migration-from-must-match-current-alias', [pub('invalid-boundary', ['G', 'W', 'WrongFrom'], 101)], { status: 'not-found', head: null, controller: null });
scenario('btco-is-terminal-for-migration', [boundary, pub('late-migration', ['LateMigration'])], expected());
scenario('orphan-delta-does-not-create-an-asset', [pub('orphan', ['R'])], { status: 'not-found', head: null, controller: null });
scenario('unconfirmed-candidate-is-pending', [boundary, pub('pending', ['U'], 102, 1, 0, { confirmed: false })], expected());
scenario('provider-sat-association-mismatch-is-inconsistent', [boundary, pub('wrong-sat', ['U'], 102, 1, 0, { sat: '5000000001' })], { status: 'inconsistent-evidence', head: null, controller: null });
scenario('provider-network-mismatch-is-inconsistent', [boundary, pub('wrong-network', ['U'], 102, 1, 0, { network: 'mainnet' })], { status: 'inconsistent-evidence', head: null, controller: null });
scenario('signed-wrong-sat-claim-is-an-invalid-candidate', [pub('wrong-claim', ['G', 'W', 'WrongSatClaim'], 100, 1), boundary], expected());
scenario('incomplete-enumeration-cannot-claim-latest', [boundary], { status: 'incomplete', head: null, controller: null }, { enumerationComplete: false });
scenario('unavailable-bytes-cannot-be-called-junk', [boundary, pub('unavailable', [], 102, 1, 0, { complete: false })], { status: 'incomplete', head: null, controller: null });
scenario('missing-creation-position-cannot-be-guessed', [boundary, pub('unknown-order', ['U'], 102, 1, 0, { position: null })], { status: 'incomplete', head: null, controller: null });
scenario('tip-change-invalidates-combined-result', [boundary, rotation], { status: 'chain-changed', head: null, controller: null }, { tipAfter: 'different-tip-110' });
scenario('reorg-without-rotation-restores-previous-authority', [boundary], expected('T', 'A'), { tipBefore: 'replacement-tip-110', tipAfter: 'replacement-tip-110', cachedHead: 'R', cachedController: 'B' });
scenario('reorg-without-deactivation-restores-active-history', [boundary, rotation], expected('R', 'B'), { tipBefore: 'replacement-tip-110', tipAfter: 'replacement-tip-110', cachedHead: 'D', cachedActive: false });
scenario('duplicate-identical-observation-is-idempotent', [boundary, copy(boundary), rotation], expected('R', 'B'));
scenario('conflicting-observation-for-one-id-is-not-a-fork', [boundary, rotation, pub('rotation', ['U'])], { status: 'inconsistent-evidence', head: null, controller: null });
const laterBoundary = pub('another-boundary', ['G2', 'W2', 'T2'], 103, 1);
scenario('earliest-boundary-fixes-the-sat-identity', [laterBoundary, boundary], expected());
scenario('requested-later-identity-cannot-filter-away-earlier-boundary', [laterBoundary, boundary], { status: 'identity-mismatch', head: null, controller: null }, { expectedDid: cel2 });
scenario('requested-earliest-identity-agrees', [laterBoundary, boundary], expected(), { expectedDid: cel });
scenario('required-verification-capability-unavailable', [boundary, rotation, pub('uncheckable', ['Bupdate'], 103, 1, 0, { capabilityUnavailable: true })], { status: 'unsupported-capability', head: null, controller: null });
const entryDigests = Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, digest(bytes(e.event))]));
writeFileSync(new URL('histories.json', here), JSON.stringify({
  scope: 'Hand-worked decision histories with real signatures from public test keys. Positions, completeness, ownership and tips are DECLARED SCENARIOS, not Bitcoin observations. WebVH method binding is symbolic and not verified. This is not production or regtest evidence.',
  actors: { A: A.controller, B: B.controller, H: H.controller }, entries, entryDigests, cases,
}, null, 2) + '\n');
console.log(JSON.stringify({ signedEntries: Object.keys(entries).length, workedHistories: cases.length }));
