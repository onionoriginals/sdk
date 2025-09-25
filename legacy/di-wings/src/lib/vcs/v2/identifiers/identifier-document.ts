import { VerificationMethod } from '../common/verification-method';
import { Service } from '../common/service';

export class IdentifierDocument {
  '@context': string[];
  id: string;
  controller?: string;
  alsoKnownAs?: string[];
  verificationMethod: VerificationMethod[];
  authentication: (string | VerificationMethod)[];
  assertionMethod: (string | VerificationMethod)[];
  keyAgreement: (string | VerificationMethod)[];
  capabilityInvocation: (string | VerificationMethod)[];
  capabilityDelegation: (string | VerificationMethod)[];
  service: Service[];

  constructor(data: Partial<IdentifierDocument>) {
    this['@context'] = data['@context'] || ['https://www.w3.org/ns/did/v1'];
    this.id = data.id!;
    this.controller = data.controller;
    this.alsoKnownAs = data.alsoKnownAs || [];
    this.verificationMethod = (data.verificationMethod || []).map(vm => new VerificationMethod(vm));
    this.authentication = this.normalizeVerificationMethod(data.authentication || []);
    this.assertionMethod = this.normalizeVerificationMethod(data.assertionMethod || []);
    this.keyAgreement = this.normalizeVerificationMethod(data.keyAgreement || []);
    this.capabilityInvocation = this.normalizeVerificationMethod(data.capabilityInvocation || []);
    this.capabilityDelegation = this.normalizeVerificationMethod(data.capabilityDelegation || []);
    this.service = (data.service || []).map(s => new Service(s));
  }

  private normalizeVerificationMethod(methods: (string | VerificationMethod)[]): VerificationMethod[] {
    return methods.map(method => {
      if (typeof method === 'string') {
        return this.verificationMethod.find(vm => vm.id === method) || new VerificationMethod({ id: method });
      }
      return new VerificationMethod(method);
    });
  }

  toJSON(): object {
    return {
      '@context': this['@context'],
      id: this.id,
      controller: this.controller,
      alsoKnownAs: this.alsoKnownAs,
      verificationMethod: this.verificationMethod.map(vm => vm.toJSON!()),
      authentication: typeof this.authentication === 'string' ? [this.authentication] : this.authentication.map(vm => vm as VerificationMethod).map(vm => vm.toJSON!()),
      assertionMethod: typeof this.assertionMethod === 'string' ? [this.assertionMethod] : this.assertionMethod.map(vm => vm as VerificationMethod).map(vm => vm.toJSON!()),
      keyAgreement: typeof this.keyAgreement === 'string' ? [this.keyAgreement] : this.keyAgreement.map(vm => vm as VerificationMethod).map(vm => vm.toJSON!()),
      capabilityInvocation: typeof this.capabilityInvocation === 'string' ? [this.capabilityInvocation] : this.capabilityInvocation.map(vm => vm as VerificationMethod).map(vm => vm.toJSON!()),
      capabilityDelegation: typeof this.capabilityDelegation === 'string' ? [this.capabilityDelegation] : this.capabilityDelegation.map(vm => vm as VerificationMethod).map(vm => vm.toJSON!()),
      service: this.service,
    };
  }
}
