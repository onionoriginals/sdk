import { EnvironmentVariableSecretResolver, JSONSecretResolver } from "../../../lib/dids";
import { SecretTypeNotFound } from "../../../lib/dids/Secret";
import { describe, expect, it } from "bun:test"
import { base64url } from "../../../lib/crypto";

describe("SecretResolver", () => {
  it("can resolve a JsonWebKey2020 JSON file", async () => {
    const secretFile = {
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

    const resolver = new JSONSecretResolver(secretFile);
    const secret = await resolver.resolve(secretFile["id"]);
    const jwk = await secret.asJsonWebKey();

    expect(secret.id).toBe("did:web:example.com#key-0");
    expect(secret.type).toBe("JsonWebKey2020");
    expect(jwk.privateKeyJwk!.crv).toBe("Ed25519");
    expect(jwk.privateKeyJwk!.d).toBe(
      "u7OKM36_b8k4Yk6QI0c_lOznRsKwnOzlhTfqCkr6VmY"
    );
    expect(jwk.privateKeyJwk!.kty).toBe("OKP");
    expect(jwk.privateKeyJwk!.x).toBe(
      "s_7sGeMPuhusy_X4slKydGXWAhvVfqBDW2DwZHloWr0"
    );
  });

  it("can resolve a X25519KeyAgreementKey2019 JSON file", async () => {
    const secretFile = {
      "id": "did:web:example.com#key-1",
      "type": "X25519KeyAgreementKey2019",
      "publicKeyBase58": "3zSE11h82KtPYPj8p9cTgzr6yDWFYEsfM19xc1K5vjKY",
      "privateKeyBase58": "66pGmEHd7fBfQa9ap27vWSouHAmipbmmw6GduBwNRY6y"
    };
    const resolver = new JSONSecretResolver(secretFile);

    const secret = await resolver.resolve(secretFile["id"]);
    const jwk = await secret.asJsonWebKey();

    expect(secret.id).toBe("did:web:example.com#key-1");
    expect(secret.type).toBe("X25519KeyAgreementKey2019");
    expect(secret.privateKeyBase58).toBe(
      "66pGmEHd7fBfQa9ap27vWSouHAmipbmmw6GduBwNRY6y"
    );
    expect(jwk.privateKeyJwk!.crv).toBe("X25519");
    expect(jwk.privateKeyJwk!.kty).toBe("OKP");
    expect(jwk.privateKeyJwk!.d).toBe(
      "S8fJ_kWYHtou5yMYqEUQgeJgBz5el-BdH_msKrkwXQY"
    );
  });

  it("throws error when doesn't support a key type", async () => {
    expect(() => {
      new JSONSecretResolver({
        id: "did:web:example.com#key-1",
        type: "BAR",
      });
    }).toThrow(SecretTypeNotFound);
  });

  it("env var secret resolver can resolve a X25519KeyAgreementKey2019 JSON file", async () => {
    const secretFile = {
      "id": "did:web:example.com#key-1",
      "type": "X25519KeyAgreementKey2019",
      "publicKeyBase58": "3zSE11h82KtPYPj8p9cTgzr6yDWFYEsfM19xc1K5vjKY",
      "privateKeyBase58": "66pGmEHd7fBfQa9ap27vWSouHAmipbmmw6GduBwNRY6y"
    };
    const resolver = new EnvironmentVariableSecretResolver({SECRETS: base64url.encode(JSON.stringify([secretFile]))});
    
    const secret = await resolver.resolve(secretFile["id"]);
    const jwk = await secret.asJsonWebKey();

    expect(secret.id).toBe("did:web:example.com#key-1");
    expect(secret.type).toBe("X25519KeyAgreementKey2019");
    expect(secret.privateKeyBase58).toBe(
      "66pGmEHd7fBfQa9ap27vWSouHAmipbmmw6GduBwNRY6y"
    );
    expect(jwk.privateKeyJwk!.crv).toBe("X25519");
    expect(jwk.privateKeyJwk!.kty).toBe("OKP");
    expect(jwk.privateKeyJwk!.d).toBe(
      "S8fJ_kWYHtou5yMYqEUQgeJgBz5el-BdH_msKrkwXQY"
    );
  });

  it("env var secret resolver throws error when doesn't have SECRETS key", async () => {
    expect(() => {
      new EnvironmentVariableSecretResolver({});
    }).toThrow('No (base64 encoded) SECRETS found in environment');
  });
});