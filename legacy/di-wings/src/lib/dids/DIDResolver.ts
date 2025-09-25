// import { resolve as didPeer } from "@aviarytech/did-peer"

import { DIDDocument } from "./DIDDocument.js";
import type { IDIDDocument } from "../common/interfaces.js";

export class DIDNotFoundError extends Error {
  constructor(did: string) {
    super(did);
    this.message = `DID ${did} not found`
  }
}

export class DIDMethodNotSupported extends Error {
  constructor(method: string) {
    super(method)
    this.message = `DID method ${method} not supported by resolver`
  }
}

export class DIDResolver {
  async resolve(did: string): Promise<IDIDDocument> {
    try {
      let document: any;
      if (did.split(":").length < 3) {
        throw new Error(`${did} not a valid DID`)
      }
      if (did.startsWith('did:web:')) {
        const [_, method, id, ...extras] = did.split(":");
        let domain = id.split("#").length > 1 ? id.split("#")[0] : id;
        let path = extras.join('/')
        const [host, port] = domain.split('%3A');
        const resp = await fetch(
          `http${host.indexOf("localhost") >= 0 ? '' : "s"
          }://${host}${!port ? '' : `:${port}`}/${path === '' ? '.well-known' : path}/did.json`
        );
        document = await resp.json();
      }
      // if (did.startsWith('did:peer:')) {
      //   try {
      //     document = await didPeer(did)
      //   } catch (e: any) {
      //     console.error(`could not resolve did:peer`, e.message)
      //   }
      // }
      if (did.startsWith('did:key:')) {
        try {
          const [x, y, id] = did.split(':');
          const [pub, fingerprint] = id.split('#');
          const vm = `did:key:${pub}#${pub}`;
          document = {
            "@context": [
              "https://www.w3.org/ns/did/v1",
              "https://w3id.org/security/suites/ed25519-2020/v1"],
            "id": `did:key:${pub}`,
            "verificationMethod": [
              {
                "id": vm,
                "type": 'Ed25519VerificationKey2020',
                "controller": `did:key:${pub}`,
                "publicKeyMultibase": pub
              }
            ],
            "assertionMethod": [vm],
            "authentication": [vm]
          }
        } catch (e: any) {
          console.error(`could not resolve did:key`, e.message);
        }
      }
      if (!document) throw new DIDNotFoundError(did);
      if (typeof document === 'object') {
        return new DIDDocument(document)
      }
      return new DIDDocument(JSON.parse(document));
    } catch (e: any) {
      const [_, method] = did.split(":")
      if (e.message.indexOf("Unsupported iri") >= 0) throw new DIDMethodNotSupported(`did:${method}`)
      if (e.message.indexOf("status code 404") >= 0) throw new DIDNotFoundError(did)
      throw e;
    }
  }
}