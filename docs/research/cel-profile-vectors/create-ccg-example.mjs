// Reference fixture only. No Originals SDK imports, wallet keys, or networking.
// The seed below is the publicly documented RFC 8032 test key, not a real wallet.
import { createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const { canonicalize } = rootRequire('./node_modules/.bun/json-canonicalize@2.0.0/node_modules/json-canonicalize');

const here = new URL('./', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest();
const canonicalBytes = value => Buffer.from(canonicalize(value), 'utf8');
const multihash = bytes => 'u' + Buffer.concat([Buffer.from([0x12, 0x20]), hash(bytes)]).toString('base64url');
function base58btc(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let result = '';
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return 'z' + result;
}
const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' });
const publicKey = createPublicKey(key);
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
assert.equal(rawPublicKey.toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
assert.equal(sign(null, Buffer.alloc(0), key).toString('hex'), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
const publicKeyMultibase = base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]));
const controller = 'did:key:' + publicKeyMultibase;
const png = readFileSync(new URL('../../regtest/examples/content.png', import.meta.url));
const event = {
  operation: {
    type: 'create',
    data: {
      profile: 'originals/cel/3',
      controller,
      createdAt: '2026-09-05T00:00:00.000Z',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      name: 'art.png',
      resources: [{ id: 'art.png', mediaType: 'image/png', digestMultibase: multihash(png) }],
    },
  },
};
const proofConfig = {
  type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022',
  created: '2026-09-05T00:00:00.000Z',
  verificationMethod: controller + '#' + publicKeyMultibase,
  proofPurpose: 'assertionMethod',
};
const eventBytes = canonicalBytes(event);
const configBytes = canonicalBytes(proofConfig);
const message = Buffer.concat([hash(configBytes), hash(eventBytes)]);
const signature = sign(null, message, key);
assert.ok(verify(null, message, publicKey, signature));
const changed = structuredClone(event);
changed.operation.data.name = 'a different title';
assert.equal(verify(null, Buffer.concat([hash(configBytes), hash(canonicalBytes(changed))]), publicKey, signature), false);
assert.equal(verify(null, Buffer.concat([hash(configBytes), hash(canonicalBytes({ event }))]), publicKey, signature), false);
const document = { log: [{ event, proof: [{ ...proofConfig, proofValue: base58btc(signature) }] }] };
const evidence = {
  status: 'Reference-generated CCG-layout example with a standard EdDSA signature construction. Not produced or accepted by the new SDK, and not inscribed on Bitcoin. Its representation is specified in specs/originals-cel-v3-profile.md; production implementation remains pending.',
  testKey: 'Public RFC 8032 section 7.1 test key 1; nonce is a fixed fixture value. Never use this key or nonce for real assets.',
  sources: ['https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1', 'https://www.w3.org/TR/2025/REC-vc-di-eddsa-20250515/#eddsa-jcs-2022'],
  referenceTools: 'json-canonicalize 2.0.0 for JCS; Node crypto for SHA-256 and Pure Ed25519. No Originals implementation imported.',
  didCel: 'did:cel:' + multihash(eventBytes),
  expectedEventCanonical: eventBytes.toString('utf8'),
  expectedEventUtf8Hex: eventBytes.toString('hex'),
  expectedEventSha256: hash(eventBytes).toString('hex'),
  expectedProofConfigurationCanonical: configBytes.toString('utf8'),
  expectedProofConfigurationSha256: hash(configBytes).toString('hex'),
  expectedSigningMessageHex: message.toString('hex'),
  expectedSignatureHex: signature.toString('hex'),
  checks: { rfc8032PrimitiveKnownAnswer: true, signatureVerifies: true, changedNameRejected: true, wrongEventWrapperRejected: true },
};
writeFileSync(new URL('ccg-create.example.json', here), JSON.stringify(document, null, 2) + '\n');
writeFileSync(new URL('ccg-create.evidence.json', here), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ didCel: evidence.didCel, checks: evidence.checks, example: fileURLToPath(new URL('ccg-create.example.json', here)) }));
