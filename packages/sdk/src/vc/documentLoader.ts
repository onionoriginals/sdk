import { DIDManager } from '../did/DIDManager.js';
import { PRELOADED_CONTEXTS } from '../utils/serialization.js';
import { multikey } from '../crypto/Multikey.js';

type LoadedDocument = { document: unknown; documentUrl: string; contextUrl: string | null };

// Serve the full bundled context documents so canonicalization sees real term
// definitions. Stub contexts here previously caused every credential field to
// be dropped from the signed dataset (issue #167).
const CONTEXTS: Record<string, unknown> = PRELOADED_CONTEXTS;

export class DocumentLoader {
  constructor(private didManager: DIDManager) {}

  async load(iri: string): Promise<LoadedDocument> {
    if (iri.startsWith('did:')) {
      return this.resolveDID(iri);
    }
    const doc = CONTEXTS[iri];
    if (doc) {
      return { document: doc, documentUrl: iri, contextUrl: null };
    }
    throw new Error(`Document not found: ${iri}`);
  }

  private async resolveDID(didUrl: string): Promise<LoadedDocument> {
    const [did, fragment] = didUrl.split('#');
    const didDoc = await this.didManager.resolveDID(did);
    if (!didDoc) {
      // The DID itself did not resolve. For fragment (verification method)
      // lookups, fall back to keys explicitly registered out-of-band via
      // registerVerificationMethod — but ONLY for self-certifying methods
      // (did:key, did:peer) whose key material is bound into the identifier
      // and which have no hosted, revocable authoritative state. For hosted
      // methods (did:webvh) or on-chain methods (did:btco), an unreachable
      // document must fail closed: trusting a registry entry would bypass
      // deactivation and key rotation published by the authoritative source.
      const isSelfCertifying = did.startsWith('did:key:') || did.startsWith('did:peer:');
      // did:key is FULLY self-certifying: the identifier IS the public
      // multikey, so the key node can be synthesized locally with no
      // resolution — did:key:{mk}#{mk} always denotes the key {mk}. Only the
      // canonical fragment form is accepted, and the key must decode as a
      // valid multikey (fail closed on garbage).
      //
      // Retirement still wins: an out-of-band registry entry marking this
      // exact VM revoked/compromised must fail closed even though the key is
      // self-certifying — otherwise the only compromise-recovery mechanism
      // for did:key would be unreachable (the synthesis below would always
      // return a fresh, unmarked node first). So the registry retirement
      // check runs BEFORE synthesis.
      if (fragment && isSelfCertifying) {
        const cached = verificationMethodRegistry.get(didUrl);
        if (cached && ((cached as { revoked?: string; compromised?: string }).revoked ||
                       (cached as { revoked?: string; compromised?: string }).compromised)) {
          throw new Error(`Verification method is retired (revoked or compromised): ${didUrl}`);
        }
      }
      if (fragment && did.startsWith('did:key:')) {
        const mk = did.slice('did:key:'.length);
        if (fragment === mk) {
          try {
            multikey.decodePublicKey(mk);
            return {
              document: {
                '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
                id: didUrl,
                type: 'Multikey',
                controller: did,
                publicKeyMultibase: mk
              },
              documentUrl: didUrl,
              contextUrl: null
            };
          } catch {
            // not a decodable multikey — fall through to the registry/failure path
          }
        }
      }
      if (fragment && isSelfCertifying) {
        const cached = verificationMethodRegistry.get(didUrl);
        if (cached) {
          // (retirement already handled above)
          return {
            document: { '@context': ['https://www.w3.org/ns/did/v1'], ...cached },
            documentUrl: didUrl,
            contextUrl: null
          };
        }
      }
      throw new Error(`DID not resolved: ${did}`);
    }

    interface DIDDocWithContext {
      '@context'?: unknown;
      verificationMethod?: Array<{ id?: string; revoked?: string; compromised?: string }>;
    }

    const didDocTyped = didDoc as DIDDocWithContext;

    // Fail closed on retired keys: a verification method that has been revoked
    // (rotated out) or marked compromised must never resolve as a usable
    // verification key, otherwise an attacker holding the old private key could
    // forge credential proofs that verifyProof would accept. The VM is left in
    // the DID document precisely so verifiers can recognise it as retired.
    const assertNotRetired = (vm: { revoked?: string; compromised?: string }): void => {
      if (vm.revoked || vm.compromised) {
        throw new Error(`Verification method is retired (revoked or compromised): ${didUrl}`);
      }
    };

    if (fragment) {
      // The resolved DID document is authoritative. A verification method
      // published by the DID document MUST take precedence over the global
      // verificationMethodRegistry — otherwise any caller of
      // `registerVerificationMethod` could shadow a DID's real key with an
      // attacker-controlled key and forge credential signatures.
      const vms = didDocTyped.verificationMethod;
      // Match the requested verification method against the DID document
      // tolerant of fragment-id FORMAT differences: a DID document may publish
      // a VM with a RELATIVE id (e.g. `#key-0`) while the request uses the
      // ABSOLUTE form (`did:example:123#key-0`), or vice versa. Both are
      // equivalent per DID Core (a relative DID URL resolves against the
      // document's DID). Normalising before comparison prevents the loader from
      // missing a published VM and falling back to the registry (a forgery
      // vector) or returning a key-less stub (spurious verification failure).
      const normalizeVmId = (id?: string): string | undefined =>
        id && id.startsWith('#') ? `${did}${id}` : id;
      const requestedVmId = normalizeVmId(didUrl);
      const vm = vms?.find((m) => normalizeVmId(m.id) === requestedVmId);
      if (vm) {
        assertNotRetired(vm);
        return {
          // Return the VM under the requested (absolute) id so the resolved
          // document is internally consistent with documentUrl, regardless of
          // whether the DID document published it relatively or absolutely.
          document: { '@context': didDocTyped['@context'], ...vm, id: didUrl },
          documentUrl: didUrl,
          contextUrl: null
        };
      }
      // Fallback ONLY when the DID document does not itself publish this
      // verification method, and ONLY for self-certifying methods (did:key,
      // did:peer) whose key material is bound into the identifier. For hosted
      // (did:webvh) or on-chain (did:btco) methods the resolved document is
      // authoritative: a key the controller REMOVED (a common rotation style)
      // must not be resurrected from the process-global registry, or a
      // rotated-out key would keep verifying signatures indefinitely.
      const isSelfCertifyingMethod = did.startsWith('did:key:') || did.startsWith('did:peer:');
      if (isSelfCertifyingMethod) {
        const cached = verificationMethodRegistry.get(didUrl);
        if (cached) {
          assertNotRetired(cached);
          return {
            document: { '@context': didDocTyped['@context'], ...cached },
            documentUrl: didUrl,
            contextUrl: null
          };
        }
      }
      return {
        document: { '@context': didDocTyped['@context'], id: didUrl },
        documentUrl: didUrl,
        contextUrl: null
      };
    }
    return { document: didDoc, documentUrl: didUrl, contextUrl: null };
  }
}

export const createDocumentLoader = (didManager: DIDManager) => {
  // Reuse one DocumentLoader per factory call. It holds no per-IRI state (it
  // reads from module-level PRELOADED_CONTEXTS and verificationMethodRegistry),
  // so this removes the per-IRI allocation with no behavior change.
  const loader = new DocumentLoader(didManager);
  return (iri: string) => loader.load(iri);
};

export const verificationMethodRegistry: Map<string, Record<string, unknown>> = new Map();
export function registerVerificationMethod(vm: Record<string, unknown> & { id?: string }): void {
  if (vm?.id) verificationMethodRegistry.set(vm.id, vm);
}

