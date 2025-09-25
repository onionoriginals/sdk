import { DIDDocumentVerificationMethod } from "../../../lib/dids";
import { describe, expect, it } from "bun:test"

describe("DIDDocumentVerificationMethod", () => {
  it("can initialize from json", async () => {
    const json = {
      "id": "did:web:example.com#key-2",
      "controller": "did:web:example.com",
      "type": "JsonWebKey2020",
      "publicKeyJwk": {
        "kty": "OKP",
        "crv": "X25519",
        "x": "fQwRvPeImgps_58yMWoaYeoEIYZW_XDgpmKMQHn7ozQ"
      }
    };

    const v = new DIDDocumentVerificationMethod(json);

    expect(v.id).toBe("did:web:example.com#key-2");
    expect(v.controller).toBe("did:web:example.com");
    expect(v.type).toBe("JsonWebKey2020");
  });

  it("can export json of unknown type", async () => {
    const v = new DIDDocumentVerificationMethod({id: 'test', type: 'unknownCryptoSuite'});
    expect(v.id).toBe("test");
    expect(v.type).toBe("unknownCryptoSuite" as any);
  });
});