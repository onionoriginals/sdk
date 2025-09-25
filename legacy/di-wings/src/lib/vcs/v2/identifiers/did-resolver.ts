import { DIDKeyResolver } from './did-key-resolver';
import { ProofError } from '../errors';

export interface DIDDocument {
  '@context': string | string[];
  id: string;
  verificationMethod?: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase?: string;
  }>;
  authentication?: string[];
  assertionMethod?: string[];
  keyAgreement?: string[];
  capabilityInvocation?: string[];
  capabilityDelegation?: string[];
  service?: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}

export class DIDResolver {
  private methodResolvers: { [method: string]: any } = {
    key: DIDKeyResolver,
    // Add other DID method resolvers here
  };

  async resolve(did: string): Promise<DIDDocument> {
    try {
      const [, method, identifier] = did.split(':');
      
      if (!method || !identifier) {
        throw new Error('Invalid DID format');
      }

      const resolver = this.methodResolvers[method];
      if (!resolver) {
        throw new Error(`Unsupported DID method: ${method}`);
      }
      return await resolver.resolve(did);
    } catch (error: any) {
      throw new ProofError(`Failed to resolve DID: ${error.message}`);
    }
  }

  async resolveVerificationMethod(didUrl: string): Promise<any> {
    try {
      const [did, fragment] = didUrl.split('#');
      const didDocument = await this.resolve(did);

      if (!fragment) {
        throw new Error('No verification method specified');
      }

      const verificationMethod = didDocument.verificationMethod?.find(vm => vm.id === didUrl);
      if (!verificationMethod) {
        throw new Error(`Verification method not found: ${didUrl}`);
      }

      return verificationMethod;
    } catch (error: any) {
      throw new ProofError(`Failed to resolve verification method: ${error.message}`);
    }
  }
}
