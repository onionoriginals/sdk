// A small reference evaluation of DECLARED scenarios; never a production verifier.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDocument, copy, digest, bytes } from '../cel-profile-vectors/profile-reference.mjs';
const fixture = JSON.parse(readFileSync(new URL('histories.json', import.meta.url), 'utf8'));
const empty = status => ({ status, head: null, controller: null });
const actor = controller => Object.entries(fixture.actors).find(([, did]) => did === controller)?.[0];

function applyPublication(previous, publication) {
  const document = { log: publication.entries.map(id => fixture.entries[id]) };
  const checked = checkDocument(document, undefined, previous?.headDigest);
  const state = previous ? copy(previous) : null;
  let next = state;
  for (const [i, entry] of document.log.entries()) {
    const { type, data } = entry.event.operation;
    const signer = next?.controllerDid ?? data.controller;
    for (const proof of checked.entries[i].proofs) assert.equal(proof.signer, signer, 'current controller required');
    if (!next) {
      assert.equal(type, 'create');
      const did = 'did:cel:' + digest(bytes(entry.event));
      next = { controllerDid: data.controller, name: data.name, metadata: copy(data.metadata ?? {}), active: true,
        resources: data.resources.map(r => ({ ...copy(r), version: 1 })), aliases: [did], layer: 'cel' };
    } else {
      assert.equal(next.active, true, 'deactivated');
      assert.equal(entry.event.previousEvent, next.headDigest);
      if (type === 'rotateKey') {
        assert.notEqual(data.newController, next.controllerDid, 'no-op rotation');
        next.controllerDid = data.newController;
      } else if (type === 'update') {
        if (Object.hasOwn(data, 'name')) next.name = data.name;
        if (Object.hasOwn(data, 'metadata')) next.metadata = copy(data.metadata);
        for (const replacement of data.resources ?? []) {
          const index = next.resources.findIndex(r => r.id === replacement.id);
          assert.ok(index >= 0, 'unknown resource');
          assert.equal(next.resources[index].digestMultibase, replacement.previousDigestMultibase, 'wrong prior digest');
          const { previousDigestMultibase, ...descriptor } = replacement;
          next.resources[index] = { ...copy(descriptor), version: next.resources[index].version + 1 };
        }
      } else if (type === 'deactivate') next.active = false;
      else if (type === 'migrate') {
        assert.equal(data.from, next.aliases.at(-1), 'migration alias mismatch');
        assert.equal(data.layer, next.layer === 'cel' ? 'webvh' : next.layer === 'webvh' ? 'btco' : null, 'terminal migration');
        if (data.layer === 'btco') assert.equal(data.to, 'did:btco:reg:' + publication.sat, 'wrong anchoring sat');
        next.layer = data.layer; next.aliases.push(data.to);
      } else assert.fail('unexpected creation');
    }
    next.head = publication.entries[i]; next.headDigest = checked.entries[i].eventDigest;
  }
  if (!previous) {
    const last = document.log.at(-1).event.operation;
    assert.equal(last.type, 'migrate'); assert.equal(last.data.layer, 'btco');
    assert.equal(next.layer, 'btco');
  }
  return next;
}
function evaluate(scenario) {
  const { snapshot } = scenario;
  if (snapshot.tipBefore !== snapshot.tipAfter) return empty('chain-changed');
  if (!snapshot.enumerationComplete) return empty('incomplete');
  const seen = new Map(), positions = new Map(), publications = [];
  for (const publication of scenario.publications) {
    if (!publication.confirmed) continue;
    if (publication.sat !== snapshot.sat || publication.network !== snapshot.network) return empty('inconsistent-evidence');
    if (publication.capabilityUnavailable) return empty('unsupported-capability');
    if (!publication.complete || !Array.isArray(publication.position) || publication.position.length !== 3) return empty('incomplete');
    const existing = seen.get(publication.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(publication)) return empty('inconsistent-evidence');
      continue;
    }
    const position = publication.position.join(':');
    if (positions.has(position)) return empty('inconsistent-evidence');
    positions.set(position, publication.id); seen.set(publication.id, publication); publications.push(publication);
  }
  publications.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2]);
  let state = null, lastHeight;
  for (const publication of publications) {
    if (publication.unrelated) continue;
    if (state && publication.position[0] <= lastHeight) continue;
    try {
      const next = applyPublication(state, publication);
      state = next; lastHeight = publication.position[0];
    } catch (error) {
      // Model state/schema rejections only. Unexpected tool failures must surface.
      if (!(error instanceof assert.AssertionError)) throw error;
    }
  }
  if (!state) return empty('not-found');
  if (snapshot.expectedDid && snapshot.expectedDid !== state.aliases[0]) return empty('identity-mismatch');
  return { status: 'accepted-at-declared-snapshot', head: state.head, headDigest: state.headDigest,
    controller: actor(state.controllerDid), name: state.name, metadata: state.metadata, active: state.active,
    resourceDigest: state.resources[0].digestMultibase, resourceVersion: state.resources[0].version,
    aliases: state.aliases, owner: snapshot.owner };
}

// Every named event is cryptographically checked in a suitable wire-only document,
// including events later rejected by the authority model. No fake signature flags.
for (const [id, entry] of Object.entries(fixture.entries)) {
  assert.equal(digest(bytes(entry.event)), fixture.entryDigests[id], id);
  checkDocument({ log: [entry] });
}
for (const scenario of fixture.cases) {
  const actual = evaluate(scenario);
  assert.deepEqual(actual, scenario.expected, scenario.id);
  // Provider return order must not alter a decision. Expected state is fixed above.
  assert.deepEqual(evaluate({ ...scenario, publications: [...scenario.publications].reverse() }), scenario.expected, scenario.id + ': reversed provider order');
}
console.log(JSON.stringify({ status: 'passed', signedEntries: Object.keys(fixture.entries).length, workedHistories: fixture.cases.length, providerOrderPermutations: fixture.cases.length, scope: fixture.scope }, null, 2));
