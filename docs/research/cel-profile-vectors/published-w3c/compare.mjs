// Published-vector comparison only. No Originals SDK/CEL implementation imports.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const celRequire = createRequire(new URL("../../../../packages/cel/package.json", import.meta.url));
const rootRequire = createRequire(new URL("../../../../package.json", import.meta.url));
const nistPath = celRequire.resolve("@noble/curves/nist.js");
const { p256, p384 } = await import(nistPath);
const { ed25519 } = await import(celRequire.resolve("@noble/curves/ed25519.js"));
const { base58 } = await import(celRequire.resolve("@scure/base"));
const { canonicalize } = rootRequire(
  "./node_modules/.bun/json-canonicalize@2.0.0/node_modules/json-canonicalize",
);
const curvesVersion = JSON.parse(await readFile(nistPath.replace(/nist\.js$/, "package.json"), "utf8")).version;
const canonicalizeVersion = rootRequire(
  "./node_modules/.bun/json-canonicalize@2.0.0/node_modules/json-canonicalize/package.json",
).version;

const hex = (value) => Buffer.from(value).toString("hex");
const unhex = (value) => Uint8Array.from(Buffer.from(value, "hex"));
const digest = (algorithm, text) => createHash(algorithm).update(text).digest("hex");

function keyBytes(value, length) {
  assert.equal(value[0], "z");
  const multikey = base58.decode(value.slice(1));
  let index = 0;
  while (multikey[index++] & 0x80) assert.ok(index < multikey.length);
  const bytes = multikey.slice(index);
  assert.equal(bytes.length, length);
  return bytes;
}

// W3C's Ed25519 key example uses JavaScript-style unquoted property names.
// Extract its two literal strings without evaluating source text.
function keysFromLiteral(literal) {
  const values = {};
  for (const name of ["publicKeyMultibase", "secretKeyMultibase"]) {
    values[name] = literal.match(new RegExp(`"?${name}"?\\s*:\\s*"([^"]+)"`))?.[1];
    assert.equal(typeof values[name], "string");
  }
  return values;
}

const results = [];
for (const [suite, algorithm, curve, keyLength, publicLength] of [
  ["ecdsa-jcs-2019-p256", "sha256", p256, 32, 33],
  ["ecdsa-jcs-2019-p384", "sha384", p384, 48, 49],
  ["eddsa-jcs-2022-ed25519", "sha256", ed25519, 32, 32],
]) {
  const fixture = JSON.parse(await readFile(new URL(`./${suite}.json`, import.meta.url), "utf8"));
  const e = fixture.examples.map((example) => example.literal);
  const document = JSON.parse(e[1]);
  const proofOptions = JSON.parse(e[4]);
  assert.equal(canonicalize(document), e[2], `${suite}: canonical document`);
  assert.equal(canonicalize(proofOptions), e[5], `${suite}: canonical proof options`);
  assert.equal(digest(algorithm, e[2]), e[3], `${suite}: document hash`);
  assert.equal(digest(algorithm, e[5]), e[6], `${suite}: proof hash`);
  assert.equal(e[6] + e[3], e[7], `${suite}: concatenated hashes`);
  assert.equal("z" + base58.encode(unhex(e[8])), e[9], `${suite}: encoded signature`);
  assert.deepEqual(JSON.parse(e[10]), {
    ...document,
    proof: { ...proofOptions, proofValue: e[9] },
  }, `${suite}: assembled published document`);

  const keys = keysFromLiteral(e[0]);
  const secretKey = keyBytes(keys.secretKeyMultibase, keyLength);
  const publicKey = keyBytes(keys.publicKeyMultibase, publicLength);
  const message = unhex(e[7]);
  const signature = unhex(e[8]);
  const isEcdsa = suite.startsWith("ecdsa-");
  const options = isEcdsa ? { prehash: true, lowS: false } : undefined;
  assert.equal(curve.verify(signature, message, publicKey, options), true, `${suite}: published signature`);
  assert.equal(hex(curve.sign(message, secretKey, options)), e[8], `${suite}: deterministic signature`);

  const result = {
    suite,
    publishedSource: fixture.source,
    firstExample: fixture.examples[0].number,
    finalExample: fixture.examples.at(-1).number,
    canonicalStringsAndHashesMatch: true,
    publishedSignatureVerifies: true,
    deterministicSignatureMatches: true,
    messageBytes: message.length,
    signatureBytes: signature.length,
  };
  if (isEcdsa) {
    result.withoutEcdsaMessageHashVerifies = curve.verify(signature, message, publicKey, {
      prehash: false,
      lowS: false,
    });
    result.withLowSRestrictionVerifies = curve.verify(signature, message, publicKey, {
      prehash: true,
      lowS: true,
    });
    assert.equal(result.withoutEcdsaMessageHashVerifies, false);
    assert.equal(result.withLowSRestrictionVerifies, suite.endsWith("p256"));
  }
  results.push(result);
}

console.log(JSON.stringify({
  scope: "Published W3C cryptographic vector behavior only; not whole processor conformance.",
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
  libraries: { "@noble/curves": curvesVersion, "json-canonicalize": canonicalizeVersion },
  results,
}, null, 2));
