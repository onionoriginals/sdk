import { IdentifierDocument } from './identifier-document';
import { DIDKeyResolver } from './did-key-resolver';

export class IdentifierDocumentResolver {
  private static instance: IdentifierDocumentResolver;

  private constructor() {}

  public static getInstance(): IdentifierDocumentResolver {
    if (!IdentifierDocumentResolver.instance) {
      IdentifierDocumentResolver.instance = new IdentifierDocumentResolver();
    }
    return IdentifierDocumentResolver.instance;
  }

  async resolve(identifier: string): Promise<Partial<IdentifierDocument>> {
    if (identifier.startsWith('did:key:')) {
      return DIDKeyResolver.resolve(identifier);
    } else {
      throw new Error('Unsupported identifier type');
    }
  }
}
