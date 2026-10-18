const base = process.argv[2];
const { SchnorrMultikey } = await import(`${base}/node_modules/@did-btcr2/cryptosuite/dist/esm/index.js`);
const { secp256k1 } = await import(`${base}/node_modules/@noble/curves/secp256k1.js`).catch(() => import(`${base}/node_modules/@noble/curves/secp256k1`));
const hex = (b) => Buffer.from(b).toString('hex');
const out = { generator: "@did-btcr2/cryptosuite@10.0.1 (BIP340Cryptosuite, bip340-jcs-2025)", generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), cases: [] };
const controller = 'did:vh:QmTestAuthor0000000000000000000000000000000000';
let n = 0;
for (let seed = 1; out.cases.length < 4 && seed < 64; seed++) {
  const sk = new Uint8Array(32).fill(seed);
  const pub = secp256k1.getPublicKey(sk, true);
  const parity = pub[0] === 2 ? 'even' : 'odd';
  if (out.cases.some((c) => c.parity === parity) && out.cases.length < 2) continue;
  const id = `#key-${seed}`;
  const mk = SchnorrMultikey.fromSecretKey(id, controller, sk);
  const doc = {
    versionId: '1-QmPlaceholderEntryHash000000000000000000000000',
    versionTime: '2026-10-18T12:00:00Z',
    parameters: { method: 'originals:1.0', scid: 'QmScid', note: `case ${++n}` },
    state: { id: 'did:vh:QmScid', name: 'Harbor at dawn ☀', n: 1.5, list: [true, null, "é"] },
  };
  const config = { type: 'DataIntegrityProof', cryptosuite: 'bip340-jcs-2025', proofPurpose: 'assertionMethod', verificationMethod: `${controller}${id}` };
  const proof = mk.toCryptosuite().createProof(doc, config);
  const verified = mk.toCryptosuite().verifyProof({ ...doc, proof });
  out.cases.push({ secretKeyHex: hex(sk), parity, publicKeyMultibase: mk.toVerificationMethod().publicKeyMultibase, compressedPublicKeyHex: hex(pub), document: doc, proof, generatorVerified: verified.verified });
}
console.log(JSON.stringify(out, null, 2));
