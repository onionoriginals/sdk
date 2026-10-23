import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { base58, hex } from "@scure/base";
import {
  createProof,
  decodeMultikey,
  didKeyMultikey,
  encodeMultikey,
  localSigner,
  multibaseDecode,
  multibaseEncode,
  proofHashData,
  sha256Multihash,
  verifyEd25519,
  verifyProof,
  type DataIntegrityProof,
} from "../src/crypto/index.js";
import { parseJson, type JsonObject } from "../src/json/index.js";
import { OriginalsError } from "../src/errors.js";

const w3c = (name: string) =>
  readFileSync(new URL(`./fixtures/w3c-eddsa-jcs-2022/${name}`, import.meta.url), "utf8");
const json = (text: string) => parseJson(text) as JsonObject;

interface Bip340Case {
  secretKeyHex: string;
  parity: "even" | "odd";
  publicKeyMultibase: string;
  compressedPublicKeyHex: string;
  document: JsonObject;
  proof: DataIntegrityProof;
}
const bip340 = json(
  readFileSync(new URL("./fixtures/bip340-jcs-2025.didbtcr2.json", import.meta.url), "utf8"),
) as unknown as { cases: Bip340Case[] };

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof OriginalsError) return error.code;
    throw error;
  }
  return undefined;
}

describe("multibase, multihash and multikey", () => {
  test("multibase is base58btc with the z prefix only", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 255]);
    expect(multibaseDecode(multibaseEncode(bytes))).toEqual(bytes);
    expect(errorCode(() => multibaseDecode("u" + "AAECAw"))).toBe("MULTIBASE_UNSUPPORTED");
    expect(errorCode(() => multibaseDecode("z0OIl"))).toBe("MULTIBASE_INVALID");
  });

  test("sha2-256 multihash", () => {
    const mh = sha256Multihash(new TextEncoder().encode("abc"));
    expect(hex.encode(mh)).toBe("1220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("decodes Ed25519 and secp256k1 Multikeys and re-encodes them exactly", () => {
    const ed = decodeMultikey(json(w3c("keyPair.json")).publicKeyMultibase as string);
    expect(ed.type).toBe("Ed25519");
    expect(ed.publicKey.length).toBe(32);
    for (const c of bip340.cases) {
      const k = decodeMultikey(c.publicKeyMultibase);
      expect(k.type).toBe("secp256k1");
      expect(hex.encode(k.publicKey)).toBe(c.compressedPublicKeyHex);
      expect(encodeMultikey(k.type, k.publicKey)).toBe(c.publicKeyMultibase);
    }
  });

  test("C12-55: a key in any other encoding is not a Multikey", () => {
    const ed = decodeMultikey(json(w3c("keyPair.json")).publicKeyMultibase as string);
    // Same Ed25519 key, but raw bytes without the multicodec prefix.
    expect(errorCode(() => decodeMultikey(multibaseEncode(ed.publicKey)))).toBe("MULTIKEY_UNSUPPORTED");
    // P-256 (0x1200) is outside the profile.
    expect(errorCode(() => decodeMultikey(multibaseEncode(new Uint8Array([0x80, 0x24, ...new Uint8Array(33).fill(2)]))))).toBe("MULTIKEY_UNSUPPORTED");
    // Truncated Ed25519 key.
    expect(errorCode(() => decodeMultikey(multibaseEncode(new Uint8Array([0xed, 0x01, ...ed.publicKey.slice(1)]))))).toBe("MULTIKEY_INVALID");
    // An uncompressed secp256k1 point is a different encoding.
    expect(errorCode(() => decodeMultikey(multibaseEncode(new Uint8Array([0xe7, 0x01, 4, ...new Uint8Array(64).fill(1)]))))).toBe("MULTIKEY_INVALID");
    // A JWK is not a string Multikey at all.
    expect(errorCode(() => decodeMultikey({ kty: "OKP" } as never))).toBe("MULTIKEY_INVALID");
  });

  test("did:key verification methods must repeat the key as their fragment", () => {
    const mk = json(w3c("keyPair.json")).publicKeyMultibase as string;
    expect(didKeyMultikey(`did:key:${mk}#${mk}`)).toBe(mk);
    expect(errorCode(() => didKeyMultikey(`did:key:${mk}#key-1`))).toBe("DID_KEY_INVALID");
    expect(errorCode(() => didKeyMultikey(`did:key:${mk}`))).toBe("DID_KEY_INVALID");
    expect(errorCode(() => didKeyMultikey(`did:web:example.com#${mk}`))).toBe("DID_KEY_INVALID");
  });
});

describe("eddsa-jcs-2022 (W3C test vectors)", () => {
  const keys = json(w3c("keyPair.json"));
  const unsigned = json(w3c("unsigned.json"));
  const options = json(w3c("proofConfigJCS.json")) as unknown as DataIntegrityProof;
  // privateKeyMultibase is ed25519-priv (0x1300 varint 0x80 0x26) + 32 bytes.
  const secret = base58.decode((keys.privateKeyMultibase as string).slice(1)).slice(2);

  test("hash data equals the published proof-config hash ‖ document hash", () => {
    const data = proofHashData(unsigned, options);
    expect(hex.encode(data)).toBe(w3c("combinedHashJCS.txt").trim());
  });

  test("creates the published proof value byte for byte", async () => {
    const signer = localSigner("Ed25519", secret);
    expect(signer.publicKeyMultibase).toBe(keys.publicKeyMultibase as string);
    const proof = await createProof(unsigned, options, signer);
    expect(proof.proofValue).toBe(w3c("sigBTC58JCS.txt").trim());
    expect(hex.encode(multibaseDecode(proof.proofValue))).toBe(w3c("sigHexJCS.txt").trim());
  });

  test("verifies the published signed credential, and only that", () => {
    const signed = json(w3c("signedJCS.json"));
    const { proof, ...document } = signed;
    const pk = keys.publicKeyMultibase as string;
    expect(verifyProof(document, proof as unknown as DataIntegrityProof, pk)).toBe(true);
    expect(verifyProof({ ...document, name: "Altered" }, proof as unknown as DataIntegrityProof, pk)).toBe(false);
    const altered = { ...(proof as JsonObject), created: "2023-02-24T23:36:39Z" };
    expect(verifyProof(document, altered as unknown as DataIntegrityProof, pk)).toBe(false);
    // A proof context that the document does not start with fails.
    const foreign = { ...(proof as JsonObject), "@context": ["https://example.com/other"] };
    expect(verifyProof(document, foreign as unknown as DataIntegrityProof, pk)).toBe(false);
  });
});

describe("bip340-jcs-2025 (vectors from @did-btcr2/cryptosuite)", () => {
  test("covers both public-key parities", () => {
    expect(new Set(bip340.cases.map((c) => c.parity))).toEqual(new Set(["even", "odd"]));
  });

  test("verifies every independently produced proof", () => {
    for (const c of bip340.cases) expect(verifyProof(c.document, c.proof, c.publicKeyMultibase)).toBe(true);
  });

  test("rejects altered documents, proofs and keys", () => {
    const [a, b] = bip340.cases;
    expect(verifyProof({ ...a.document, versionTime: "2026-10-18T12:00:01Z" }, a.proof, a.publicKeyMultibase)).toBe(false);
    expect(verifyProof(a.document, { ...a.proof, proofPurpose: "authentication" }, a.publicKeyMultibase)).toBe(false);
    expect(verifyProof(a.document, a.proof, b.publicKeyMultibase)).toBe(false);
    expect(verifyProof(a.document, { ...a.proof, proofValue: b.proof.proofValue }, a.publicKeyMultibase)).toBe(false);
  });

  test("our proofs verify, including keys with odd y", async () => {
    for (const c of bip340.cases) {
      const signer = localSigner("secp256k1", hex.decode(c.secretKeyHex));
      expect(signer.publicKeyMultibase).toBe(c.publicKeyMultibase);
      const options = { ...c.proof, proofValue: undefined } as unknown as DataIntegrityProof;
      const proof = await createProof(c.document, options, signer);
      expect(verifyProof(c.document, proof, c.publicKeyMultibase)).toBe(true);
    }
  });
});

describe("cryptosuite policy (P5.12)", () => {
  const keys = json(w3c("keyPair.json"));
  const signed = json(w3c("signedJCS.json"));
  const { proof, ...document } = signed;
  const pk = keys.publicKeyMultibase as string;

  test("C12-72: any other cryptosuite is unsupported, even with a valid signature", () => {
    for (const cryptosuite of ["ecdsa-jcs-2019", "eddsa-rdfc-2022", "Ed25519Signature2020", ""]) {
      const other = { ...(proof as JsonObject), cryptosuite } as unknown as DataIntegrityProof;
      expect(errorCode(() => verifyProof(document, other, pk))).toBe("CRYPTOSUITE_UNSUPPORTED");
    }
  });

  test("the key type must match the cryptosuite", () => {
    const c = bip340.cases[0];
    expect(errorCode(() => verifyProof(document, proof as unknown as DataIntegrityProof, c.publicKeyMultibase))).toBe("CRYPTOSUITE_KEY_MISMATCH");
  });

  test("proofs must be DataIntegrityProof with only Data Integrity members", () => {
    const base = proof as JsonObject;
    expect(errorCode(() => verifyProof(document, { ...base, type: "Ed25519Signature2020" } as never, pk))).toBe("PROOF_INVALID");
    expect(errorCode(() => verifyProof(document, { ...base, extra: 1 } as never, pk))).toBe("PROOF_UNKNOWN_MEMBER");
    expect(errorCode(() => verifyProof(document, { ...base, proofValue: undefined } as never, pk))).toBe("PROOF_INVALID");
  });
});

describe("Ed25519 acceptance (vh-log-interop-0 profile, section 2)", () => {
  const corpus = (name: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/vh-interop/ed25519/${name}`, import.meta.url), "utf8")) as unknown;

  test("C2SP CCTV: rejects low-order and non-canonical points and low-order residues, nothing else", () => {
    const rejectFlags = ["low_order_A", "low_order_R", "non_canonical_A", "non_canonical_R", "low_order_residue"];
    const cases = corpus("cctv.json") as Array<{ number: number; key: string; sig: string; msg: string; flags?: string[] }>;
    const wrong = cases.filter((v) => {
      const accept = !(v.flags ?? []).some((f) => rejectFlags.includes(f));
      return verifyEd25519(hex.decode(v.key), new TextEncoder().encode(v.msg), hex.decode(v.sig)) !== accept;
    });
    expect(cases.length).toBe(914);
    expect(wrong.map((v) => v.number)).toEqual([]);
  });

  test("Wycheproof: valid and invalid outcomes as published", () => {
    const { testGroups } = corpus("wycheproof.json") as { testGroups: Array<{ publicKey: { pk: string }; tests: Array<{ tcId: number; msg: string; sig: string; result: string }> }> };
    const wrong: number[] = [];
    let count = 0;
    for (const group of testGroups) {
      for (const t of group.tests) {
        count++;
        const sig = t.sig.length % 2 === 0 ? hex.decode(t.sig) : new Uint8Array(0);
        if (verifyEd25519(hex.decode(group.publicKey.pk), hex.decode(t.msg), sig) !== (t.result === "valid")) wrong.push(t.tcId);
      }
    }
    expect(count).toBe(151);
    expect(wrong).toEqual([]);
  });

  test("a Multikey decodes syntactically; an inadmissible point fails only when verifying", () => {
    const identity = new Uint8Array(32);
    identity[0] = 1; // y = 1: the identity point, order 1
    const mk = encodeMultikey("Ed25519", identity);
    expect(decodeMultikey(mk).type).toBe("Ed25519");
    expect(verifyEd25519(identity, new Uint8Array(64), new Uint8Array(64))).toBe(false);
  });
});

