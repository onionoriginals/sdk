// Independent did:webvh 1.0 logs from didwebvh-ts: SCID, entry hashes, eddsa-jcs-2022
// hashing (prepareDataForSigning), pre-rotation and witness proofs are all its code.
const repo = process.argv[2];
const W = await import(`${repo}/node_modules/didwebvh-ts/dist/esm/index.js`);
const { ed25519 } = await import(`${repo}/node_modules/@noble/curves/ed25519.js`);
const { base58 } = await import(`${repo}/node_modules/@scure/base/index.js`);
const mk = (pub) => 'z' + base58.encode(new Uint8Array([0xed, 0x01, ...pub]));
const key = (seed) => { const sk = new Uint8Array(32).fill(seed); const pub = ed25519.getPublicKey(sk); return { sk, pub, multikey: mk(pub) }; };
const signerFor = (k, vmId) => ({
  getVerificationMethodId: () => vmId,
  async sign({ document, proof }) {
    const data = await W.prepareDataForSigning(document, proof);
    return { proofValue: 'z' + base58.encode(ed25519.sign(data, k.sk)) };
  },
});
const verifier = { async verify(sig, msg, pub) { return ed25519.verify(sig, msg, pub); } };
const k1 = key(11), k2 = key(12), orig = key(21);
const witnesses = [31, 32, 33].map(key).map((k) => ({ ...k, did: `did:key:${k.multikey}` }));
const witnessParam = { threshold: 2, witnesses: witnesses.map((w) => ({ id: w.did })) };
const t = (s) => `2026-10-18T12:00:0${s}Z`;
const vmFor = (did) => ({ id: `${did}#orig-1`, type: 'Multikey', controller: did, publicKeyMultibase: orig.multikey });

// Log A: pre-rotation, rotation, then witness activation and a witnessed update.
const created = await W.createDID({
  domain: 'example.com', signer: signerFor(k1, `did:key:${k1.multikey}#${k1.multikey}`), verifier,
  updateKeys: [k1.multikey], nextKeyHashes: [await W.deriveNextKeyHash(k2.multikey)],
  verificationMethods: [{ type: 'Multikey', publicKeyMultibase: orig.multikey, purpose: 'assertionMethod' }],
  created: t(1),
});
let log = created.log;
const u2 = await W.updateDID({ log, signer: signerFor(k2, `did:key:${k2.multikey}#${k2.multikey}`), verifier,
  updateKeys: [k2.multikey], nextKeyHashes: [], updated: t(2) });
log = u2.log;
const u3draft = await W.updateDID({ log, signer: signerFor(k2, `did:key:${k2.multikey}#${k2.multikey}`), verifier,
  witness: witnessParam, updated: t(3) }).catch((e) => ({ error: String(e) }));
if (u3draft.error) throw new Error(u3draft.error);
log = u3draft.log;
const wsigners = Object.fromEntries(witnesses.map((w) => [w.did, signerFor(w, `${w.did}#${w.multikey}`)]));
const sign = async (versionId, ws) => W.signWitnessProofEntry({ versionId, witnesses: ws.map((w) => ({ id: w.did })),
  witnessSignersByDid: wsigners, created: t(9) });
const w3 = await sign(log[2].versionId, witnesses.slice(0, 2));
const u4 = await W.updateDID({ log, signer: signerFor(k2, `did:key:${k2.multikey}#${k2.multikey}`), verifier,
  alsoKnownAs: ['https://example.com/alice'], updated: t(4), witnessProofs: [w3] });
log = u4.log;
const w4 = await sign(log[3].versionId, witnesses.slice(1, 3));
const witnessFile = [w3, w4];
const resolvedA = await W.resolveDIDFromLog(log, { witnessProofs: witnessFile, verifier });
const c1 = await W.createDID({ domain: 'example.org', signer: signerFor(k1, `did:key:${k1.multikey}#${k1.multikey}`), verifier,
  updateKeys: [k1.multikey], verificationMethods: [{ type: 'Multikey', publicKeyMultibase: orig.multikey, purpose: 'assertionMethod' }], created: t(1) });
const c2 = await W.deactivateDID({ log: c1.log, signer: signerFor(k1, `did:key:${k1.multikey}#${k1.multikey}`), verifier });
const out = { generator: 'didwebvh-ts@2.8.0 (did:webvh:1.0)', note: 'Keys are seeded test keys; never use them elsewhere.',
  keys: { k1: k1.multikey, k2: k2.multikey, originals: orig.multikey, witnesses: witnesses.map((w) => w.did) },
  did: created.did, logA: log, witnessA: witnessFile, resolvedA: { versionId: resolvedA.meta.versionId, deactivated: resolvedA.meta.deactivated },
  logC: c2.log };
console.log(JSON.stringify(out, null, 2));
