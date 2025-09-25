import { describe, it, expect, afterEach } from "bun:test";
import { mock, clearMocks } from "bun-bagel";
import type { MockOptions } from "bun-bagel";
import { DIDMethodNotSupported, DIDNotFoundError, DIDResolver } from "../../../lib/dids";

describe('DIDResolver', () => {
  afterEach(() => {
    clearMocks();
  });

  it("throws DIDNotFound when did not resolved", async () => {
    const resolver = new DIDResolver();
    const options: MockOptions = {
      response: {
        status: 404
      }
    };
    mock("https://example.com/.well-known/did.json", options);

    try {
      const did = await resolver.resolve("did:web:example.com");
      expect(true).toBeFalsy()
    } catch (e) {
      expect(e instanceof DIDNotFoundError).toBeTruthy();
    }
  });

  it("throws not supported when did method not found", async () => {
    const resolver = new DIDResolver();

    let res, err;
    try {
      res = await resolver.resolve("did:fake:example.com");
    } catch (e: any) {
      err = e;
    }
    expect(err.message).toBe('DID did:fake:example.com not found');
  });
});

describe('did:web', () => {
  afterEach(() => {
    clearMocks();
  });

  it("can resolve a web did", async () => {
    const didDoc = {
      "@context": ["https://www.w3.org/ns/did/v1"],
      "id": "did:web:example.com",
      "verificationMethod": []
    };
    const options: MockOptions = {
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        data: didDoc
      }
    };
    mock("https://example.com/.well-known/did.json", options);

    const resolver = new DIDResolver();
    const did = await resolver.resolve("did:web:example.com");

    expect(did["@context"]).toContain("https://www.w3.org/ns/did/v1");
  });

  it("can resolve a web did w/ a path", async () => {
    const didDoc = {
      "@context": ["https://www.w3.org/ns/did/v1"],
      "id": "did:web:example.com:user:123",
      "verificationMethod": []
    };
    const options: MockOptions = {
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        data: didDoc
      }
    };
    mock("https://example.com/user/123/did.json", options);

    const resolver = new DIDResolver();
    const did = await resolver.resolve("did:web:example.com:user:123");

    expect(did["@context"]).toContain("https://www.w3.org/ns/did/v1");
  });

  it("can resolve a web did w/ a port", async () => {
    const didDoc = {
      "@context": ["https://www.w3.org/ns/did/v1"],
      "id": "did:web:example.com%3A3000:user:123",
      "verificationMethod": []
    };
    const options: MockOptions = {
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        data: didDoc
      }
    };
    mock("https://example.com:3000/user/123/did.json", options);

    const resolver = new DIDResolver();
    const did = await resolver.resolve("did:web:example.com%3A3000:user:123");

    expect(did["@context"]).toContain("https://www.w3.org/ns/did/v1");
  });

  it("can resolve a web did w/ http on localhost", async () => {
    const didDoc = {
      "@context": ["https://www.w3.org/ns/did/v1"],
      "id": "did:web:localhost%3A5102",
      "verificationMethod": []
    };
    const options: MockOptions = {
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        data: didDoc
      }
    };
    mock("http://localhost:5102/.well-known/did.json", options);

    const resolver = new DIDResolver();
    const did = await resolver.resolve("did:web:localhost%3A5102");

    expect(did["@context"]).toContain("https://www.w3.org/ns/did/v1");
  });
});

describe('did:peer', () => {
  it("can resolve a peer did (alg 0)", async () => {
    const did = "did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V";

    const resolver = new DIDResolver();
    const resolvedDoc = await resolver.resolve(did);

    expect(resolvedDoc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(resolvedDoc.verificationMethod![0].id).toBe("did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V#6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V");
    expect(resolvedDoc.authentication![0].id).toBe("did:peer:0z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V#6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V");
  });

  it("can resolve a peer did (alg 2)", async () => {
    const did = "did:peer:2.Ez6LSpSrLxbAhg2SHwKk7kwpsH7DM7QjFS5iK6qP87eViohud.Vz6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V.SeyJ0IjoiZG0iLCJzIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9lbmRwb2ludDEiLCJyIjpbImRpZDpleGFtcGxlOnNvbWVtZWRpYXRvciNzb21la2V5MSJdLCJhIjpbImRpZGNvbW0vdjIiLCJkaWRjb21tL2FpcDI7ZW52PXJmYzU4NyJdfQ";
    const resolver = new DIDResolver();
    const resolvedDoc = await resolver.resolve(did);

    expect(resolvedDoc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(resolvedDoc.verificationMethod!.length).toBe(2);
    expect(resolvedDoc.keyAgreement![0].id).toBe("#key-1");
    expect(resolvedDoc.authentication![0].id).toBe("#key-2");
  });
});

describe('did:key', () => {
  it("can resolve a did:key", async () => {
    const did = "did:key:z6MkjdxYZ17j7DNPfgSB5LviYRxTCXPunZ5Vfbm5QKCEBVgt";

    const resolver = new DIDResolver();
    const resolvedDoc = await resolver.resolve(did);
    
    expect(resolvedDoc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(resolvedDoc.verificationMethod!.length).toBe(1);
    expect(resolvedDoc.authentication![0].id).toBe(`${did}#${did.split(':')[2]}`);
    expect(resolvedDoc.assertionMethod![0].id).toBe(`${did}#${did.split(':')[2]}`);
  });
});