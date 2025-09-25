import jws from "./contexts/jws2020.json";
import credentialExamples from "./contexts/credentials-examples.json";
import credentials from "./contexts/credentials.json";
import ed255192020 from "./contexts/ed255192020.json"
import didDoc from "./didDocuments/ed255192020.json"
import dids from "./contexts/dids.json";
import odrl from "./contexts/odrl.json";
import controller from "./controller.json";
import vax from "./contexts/vaccination.json";
import dataIntegrity from "./contexts/data-integrity.json";
import credentialsv2 from "./contexts/credentials-v2.json";

const documents: any = {
  "https://w3c-ccg.github.io/lds-jws2020/contexts/lds-jws2020-v1.json": jws,
  "https://www.w3.org/2018/credentials/examples/v1": credentialExamples,
  "https://www.w3.org/2018/credentials/v1": credentials,
  "https://www.w3.org/ns/credentials/v2": credentialsv2,
  "https://www.w3.org/ns/did/v1": dids,
  "https://www.w3.org/ns/odrl.jsonld": odrl,
  "https://w3id.org/vaccination/v1": vax,
  "https://w3id.org/security/suites/ed25519-2020/v1": ed255192020,
  "https://w3id.org/security/data-integrity/v2": dataIntegrity
};

export const documentLoader = async (iri: string): Promise<{ document: any; documentUrl: string; contextUrl: string }> => {
  try {
    if (iri.startsWith("did:example:123")) {
      return {
        document: controller,
        documentUrl: "did:example:123",
        contextUrl: ''
      };
    }
    if (iri.startsWith('did:key:z6MknCCLeeHBUaHu4aHSVLDCYQW9gjVJ7a63FpMvtuVMy53T')) {
      return {
        document: didDoc,
        documentUrl: "did:key:z6MknCCLeeHBUaHu4aHSVLDCYQW9gjVJ7a63FpMvtuVMy53T",
        contextUrl: ''
      }
    }
    return {
      document: documents[iri],
      documentUrl: iri,
      contextUrl: ''
    };
  } catch (e) {
    console.error(e, iri);
    return {
      document: null,
      documentUrl: iri,
      contextUrl: ''    };
  }
};
