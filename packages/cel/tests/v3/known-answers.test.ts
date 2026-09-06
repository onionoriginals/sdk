import { expect, test } from "bun:test";
import { base58 } from "@scure/base";
import p256 from "../../../../docs/research/cel-profile-vectors/published-w3c/ecdsa-jcs-2019-p256.json";
import p384 from "../../../../docs/research/cel-profile-vectors/published-w3c/ecdsa-jcs-2019-p384.json";
import ed25519 from "../../../../docs/research/cel-profile-vectors/published-w3c/eddsa-jcs-2022-ed25519.json";
import canonical from "../../../../docs/research/cel-profile-vectors/canonical-json.json";
import {
  canonicalizeValue,
  decodeValue,
  digestBytes,
  jcsSigningMessage,
  verifyJcsSignature,
  createLocalSigner,
} from "../../src/v3/index.js";

for (const v of canonical.acceptedCanonicalization)
  test(`literal JCS known answer: ${v.name}`, () => {
    const actual = canonicalizeValue(decodeValue(v.inputJson, "json"));
    expect(actual).toBe(v.expectedCanonical);
    expect(Buffer.from(actual).toString("hex")).toBe(v.expectedUtf8Hex);
    expect(digestBytes(new TextEncoder().encode(actual))).toBe(
      v.expectedDigestMultibase,
    );
  });
for (const [algorithm, fixture] of [
  ["P-256", p256],
  ["P-384", p384],
  ["Ed25519", ed25519],
] as const)
  test(`published W3C ${algorithm} cryptographic known answer`, async () => {
    const examples = fixture.examples.map((e) => e.literal);
    const document = JSON.parse(examples[1]),
      configuration = JSON.parse(examples[4]);
    const secret = base58
      .decode(/secretKeyMultibase["']?\s*:\s*"z([^"]+)"/.exec(examples[0])![1])
      .slice(2);
    const signer = createLocalSigner(algorithm, secret);
    const message = jcsSigningMessage(document, configuration, algorithm);
    expect(canonicalizeValue(document)).toBe(examples[2]);
    expect(canonicalizeValue(configuration)).toBe(examples[5]);
    expect(Buffer.from(message).toString("hex")).toBe(examples[7]);
    expect(
      verifyJcsSignature(
        document,
        configuration,
        new Uint8Array(Buffer.from(examples[8], "hex")),
        signer.controller,
      ),
    ).toBe(true);
    expect(Buffer.from(await signer.sign(message)).toString("hex")).toBe(
      examples[8],
    );
    // These are cryptographic primitives, not a claim that CEL accepts this VC wrapper.
  });
