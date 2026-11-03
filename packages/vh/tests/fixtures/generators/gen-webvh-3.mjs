// Independent did:webvh 1.0 logs from didwebvh-ts 3: SCID, entry hashes, eddsa-jcs-2022
// hashing (prepareDataForSigning), pre-rotation and witness proofs are all its code.
// The scenario matches gen-webvh.mjs (didwebvh-ts 2.8.0) through the 3.x API, where the
// caller supplies the complete DID document and witnesses sign through signWitnessProofEntry.
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
const updateSigner = (k) => signerFor(k, `did:key:${k.multikey}#${k.multikey}`);
// One Originals assertion key, controlled by the DID being created.
const didDocument = {
  '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
  id: '{DID}',
  controller: '{DID}',
  verificationMethod: [{ id: `{DID}#${orig.multikey.slice(-8)}`, type: 'Multikey', controller: '{DID}', publicKeyMultibase: orig.multikey }],
  authentication: [],
  assertionMethod: [`{DID}#${orig.multikey.slice(-8)}`],
};

// Log A: pre-rotation, rotation, then witness activation and a witnessed update.
const created = await W.createDID({
  address: 'example.com', signer: updateSigner(k1), verifier,
  updateKeys: [k1.multikey], nextKeyHashes: [await W.deriveNextKeyHash(k2.multikey)],
  didDocument, created: t(1),
});
let log = created.log;
const u2 = await W.updateDID({ log, signer: updateSigner(k2), verifier, updateKeys: [k2.multikey], nextKeyHashes: [], updated: t(2) });
log = u2.log;
const u3 = await W.updateDID({ log, signer: updateSigner(k2), verifier, witness: witnessParam, updated: t(3) });
const sign = async (trusted, candidate, ws, prior) => {
  const entries = [];
  for (const w of ws) {
    entries.push(await W.signWitnessProofEntry({ trustedLog: trusted, candidateLog: candidate, witnessSigner: signerFor(w, `${w.did}#${w.multikey}`), witnessProofs: prior, verifier }));
  }
  return { versionId: entries[0].versionId, proof: entries.flatMap((e) => e.proof) };
};
const w3 = await sign(log, u3.log, witnesses.slice(0, 2), []);
log = u3.log;
const u4 = await W.updateDID({ log, signer: updateSigner(k2), verifier, witnessProofs: [w3], updated: t(4),
  didDocument: { ...log[log.length - 1].state, alsoKnownAs: ['https://example.com/alice'] } });
const w4 = await sign(log, u4.log, witnesses.slice(1, 3), [w3]);
log = u4.log;
const witnessFile = [w3, w4];
const resolvedA = await W.resolveDIDFromLog(log, { witnessProofs: witnessFile, verifier });
if (resolvedA.didResolutionMetadata.error) throw new Error(`log A does not resolve: ${resolvedA.didResolutionMetadata.error}`);
const c1 = await W.createDID({ address: 'example.org', signer: updateSigner(k1), verifier, updateKeys: [k1.multikey], didDocument, created: t(1) });
const c2 = await W.deactivateDID({ log: c1.log, signer: updateSigner(k1), verifier });
const out = { generator: 'didwebvh-ts@3.0.0 (did:webvh:1.0)', note: 'Keys are seeded test keys; never use them elsewhere.',
  keys: { k1: k1.multikey, k2: k2.multikey, originals: orig.multikey, witnesses: witnesses.map((w) => w.did) },
  did: created.did, logA: log, witnessA: witnessFile,
  resolvedA: { versionId: resolvedA.didDocumentMetadata.versionId, deactivated: resolvedA.didDocumentMetadata.deactivated },
  logC: c2.log };
console.log(JSON.stringify(out, null, 2));
