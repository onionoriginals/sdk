import { DIDDocument } from "../../../lib/dids";
import { describe, expect, it } from "bun:test";

describe("DIDDocument", () => {
  it("can initialize from json", async () => {
    const json = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/suites/jws-2020/v1"
      ],
      "id": "did:web:example.com",
      "verificationMethod": [
        {
          "id": "did:web:example.com#key-0",
          "controller": "did:web:example.com",
          "type": "JsonWebKey2020",
          "publicKeyJwk": {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": "-1DbVcaL159vjV1vuKDixdJ0FppLbGarLw_sGJ9OqfQ"
          }
        },
        {
          "id": "did:web:example.com#key-2",
          "controller": "did:web:example.com",
          "type": "JsonWebKey2020",
          "publicKeyJwk": {
            "kty": "OKP",
            "crv": "X25519",
            "x": "fQwRvPeImgps_58yMWoaYeoEIYZW_XDgpmKMQHn7ozQ"
          }
        }
      ],
      "authentication": ["did:web:example.com#key-0"],
      "assertionMethod": ["did:web:example.com#key-0"],
      "keyAgreement": ["did:web:example.com#key-2"],
      "service": [
        {
          "id": "did:web:example.com#didcomm",
          "type": "DIDCommMessaging",
          "serviceEndpoint": "http://example.com/didcomm",
          "routingKeys": ["did:web:example.com#key-2"]
        }
      ]
    };

    const didDoc = new DIDDocument(json);

    expect(didDoc.id).toBe("did:web:example.com");
    expect(didDoc.context).toContain("https://www.w3.org/ns/did/v1");
    expect(didDoc.context).toContain(
      "https://w3id.org/security/suites/jws-2020/v1"
    );
    expect(didDoc.verificationMethod).toHaveLength(2);
    expect(didDoc.authentication[0].controller).toBe("did:web:example.com");
    expect(didDoc.authentication[0].id).toBe("did:web:example.com#key-0");
    expect(didDoc.service[0].type).toBe("DIDCommMessaging");
    expect(didDoc.service[0].id).toBe("did:web:example.com#didcomm");
  });

  it("can get all key agreement keys", async () => {
    const json = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/suites/jws-2020/v1"
      ],
      "id": "did:web:example.com",
      "verificationMethod": [
        {
          "id": "did:web:example.com#key-2",
          "controller": "did:web:example.com",
          "type": "JsonWebKey2020",
          "publicKeyJwk": {
            "kty": "OKP",
            "crv": "X25519",
            "x": "fQwRvPeImgps_58yMWoaYeoEIYZW_XDgpmKMQHn7ozQ"
          }
        }
      ],
      "keyAgreement": ["did:web:example.com#key-2"]
    };
    const didDoc = new DIDDocument(json);

    const kaks = didDoc.getAllKeyAgreements();

    expect(kaks.length).toBe(1);
    expect(kaks[0]).toMatchObject({
      id: "did:web:example.com#key-2",
      controller: "did:web:example.com",
      type: "JsonWebKey2020",
      publicKeyJwk: {
        kty: "OKP",
        crv: "X25519",
        x: "fQwRvPeImgps_58yMWoaYeoEIYZW_XDgpmKMQHn7ozQ",
      },
    });
  });
});