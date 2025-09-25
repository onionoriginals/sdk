import { IdentifierDocument } from './identifier-document';
import { VerificationMethod } from '../common/verification-method';
import { base58 } from '@scure/base';

export class DIDKeyResolver {
  static async resolve(did: string): Promise<Partial<IdentifierDocument>> {
    const controller = did.split('#')[0];
    if (!did.startsWith('did:key:')) {
      throw new Error('Invalid did:key format');
    }
    const publicKeyMultibase = controller.split(':')[2];
    const encodedPublicKey = publicKeyMultibase.slice(1);
    const publicKeyBytes = base58.decode(encodedPublicKey);
    const keyType = this.getKeyType(publicKeyBytes[0]);

    const verificationMethod: VerificationMethod = {
      id: `${controller}#${publicKeyMultibase}`,
      type: "Multikey",
      controller,
      publicKeyMultibase: publicKeyMultibase
    };
    if (did.includes('#')) {
      return verificationMethod;
    }

    const verificationMethodReference = `${controller}#${publicKeyMultibase}`;

    return new IdentifierDocument({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: controller,
      verificationMethod: [verificationMethod],
      authentication: [verificationMethodReference],
      assertionMethod: [verificationMethodReference],
      capabilityInvocation: [verificationMethodReference],
      capabilityDelegation: [verificationMethodReference],
      keyAgreement: keyType === 'X25519KeyAgreementKey2019' ? [verificationMethodReference] : undefined
    }).toJSON();
  }

  private static getKeyType(code: number): string {
    switch (code) {
      case 0xed:
        return 'Ed25519VerificationKey2018';
      case 0xec:
        return 'X25519KeyAgreementKey2019';
      case 0xeb:
        return 'Bls12381G2Key2020';
      default:
        throw new Error('Unsupported key type');
    }
  }
}
