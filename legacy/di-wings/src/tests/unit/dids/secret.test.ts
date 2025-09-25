import { Secret } from "../../../lib/dids";
import { describe, expect, it } from "bun:test";

describe("Secret", () => {
  it("can be constructed from json", async () => {
    const json = {
      "id": "did:web:example.com#key-0",
      "type": "JsonWebKey2020",
      "publicKeyJwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "s_7sGeMPuhusy_X4slKydGXWAhvVfqBDW2DwZHloWr0"
      },
      "privateKeyJwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "s_7sGeMPuhusy_X4slKydGXWAhvVfqBDW2DwZHloWr0",
        "d": "u7OKM36_b8k4Yk6QI0c_lOznRsKwnOzlhTfqCkr6VmY"
      }
    };

    const secret = new Secret(json);

    expect(secret.id).toBe("did:web:example.com#key-0");
    expect(secret.type).toBe("JsonWebKey2020");
    expect(secret.privateKeyJwk.x).toBe(
      "s_7sGeMPuhusy_X4slKydGXWAhvVfqBDW2DwZHloWr0"
    );
    expect(secret.privateKeyJwk.crv).toBe("Ed25519");
    expect(secret.privateKeyJwk.d).toBe(
      "u7OKM36_b8k4Yk6QI0c_lOznRsKwnOzlhTfqCkr6VmY"
    );
    expect(secret.privateKeyJwk.kty).toBe("OKP");
  });

  it("can be X25519KeyAgreementKey2020", async () => {
    const json = {
      "id": "did:web:example.com#key-1",
      "type": "X25519KeyAgreementKey2020",
      "publicKeyMultibase": "z6LSeRSE5Em5oJpwdk3NBaLVERBS332ULC7EQq5EtMsmXhsM",
      "privateKeyMultibase": "z3weeMD56C1T347EmB6kYNS7trpQwjvtQCpCYRpqGz6mcemT"
    };

    const secret = new Secret(json);

    expect(secret.id).toBe("did:web:example.com#key-1");
    expect(secret.type).toBe("X25519KeyAgreementKey2020");
    expect(secret.privateKeyMultibase).toBe("z3weeMD56C1T347EmB6kYNS7trpQwjvtQCpCYRpqGz6mcemT");
    expect(secret.publicKeyMultibase).toBe("z6LSeRSE5Em5oJpwdk3NBaLVERBS332ULC7EQq5EtMsmXhsM")
  });
});