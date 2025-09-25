import { describe, it, expect } from 'bun:test';
import credential from "../../fixtures/credentials/case-10.json";
import { LDCredentialToJWT } from '../../../lib/vcs/v1/jwt';
describe("jwt utils", () => {
  it("should reformat credential to JWT format", () => {
    const newCred = LDCredentialToJWT(credential);

    expect(newCred.jti).toBe("urn:uvci:af5vshde843jf831j128fj");
    expect(newCred.sub).toBe("did:example:123");
    expect(newCred.iss).toBe(
      "did:key:z6MkiY62766b1LJkExWMsM3QG4WtX7QpY823dxoYzr9qZvJ3"
    );
    expect(newCred.nbf).toBe(1575375592);
    expect(newCred.iat).toBe(1575375592);
    expect(newCred.exp).toBe(1890994792);
    expect(newCred).toHaveProperty("nonce");
    expect(newCred.vc.type).toStrictEqual([
      "VerifiableCredential",
      "VaccinationCertificate",
    ]);
    expect(newCred.vc["@context"]).toStrictEqual([
      "https://www.w3.org/2018/credentials/v1",
      "https://w3id.org/vaccination/v1",
    ]);
  });
});