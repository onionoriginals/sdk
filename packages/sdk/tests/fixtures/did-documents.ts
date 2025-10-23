/**
 * Test Fixtures for DID Documents and Related Data
 *
 * Provides standardized test data for DID resolution, inscription handling,
 * and lifecycle testing to ensure consistency across test suites.
 */

import type { DIDDocument } from '../../src/types/did';

/**
 * Standard test DID documents for each DID method
 */
export const testDidDocuments = {
  /**
   * Sample did:peer DID document for offline testing
   */
  peerDid: {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: 'did:peer:test123abc',
    verificationMethod: [
      {
        id: 'did:peer:test123abc#key-1',
        type: 'Multikey',
        controller: 'did:peer:test123abc',
        publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
      }
    ],
    authentication: ['did:peer:test123abc#key-1'],
    assertionMethod: ['did:peer:test123abc#key-1']
  } as DIDDocument,

  /**
   * Sample did:webvh DID document for web hosting testing
   */
  webvhDid: {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1'
    ],
    id: 'did:webvh:example.com:alice',
    verificationMethod: [
      {
        id: 'did:webvh:example.com:alice#key-0',
        type: 'Multikey',
        controller: 'did:webvh:example.com:alice',
        publicKeyMultibase: 'z6MkrHKzgsahxBLyNAbLQyB1pcWNYC9GmywiWPgkrvntAZcj'
      }
    ],
    authentication: ['did:webvh:example.com:alice#key-0'],
    assertionMethod: ['did:webvh:example.com:alice#key-0']
  } as DIDDocument,

  /**
   * Sample did:btco DID document for Bitcoin Ordinals testing
   */
  btcoDid: {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1'
    ],
    id: 'did:btco:123456',
    verificationMethod: [
      {
        id: 'did:btco:123456#key-0',
        type: 'Multikey',
        controller: 'did:btco:123456',
        publicKeyMultibase: 'zQ3shZc2QzApp2oymGvQbzP8eKheVshBHbU4ZYjeXqwSKEn6E'
      }
    ],
    authentication: ['did:btco:123456#key-0'],
    assertionMethod: ['did:btco:123456#key-0']
  } as DIDDocument,

  /**
   * Sample testnet did:btco DID document
   */
  btcoTestnetDid: {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1'
    ],
    id: 'did:btco:test:789012',
    verificationMethod: [
      {
        id: 'did:btco:test:789012#key-0',
        type: 'Multikey',
        controller: 'did:btco:test:789012',
        publicKeyMultibase: 'zQ3shZc2QzApp2oymGvQbzP8eKheVshBHbU4ZYjeXqwSKEn6E'
      }
    ],
    authentication: ['did:btco:test:789012#key-0'],
    assertionMethod: ['did:btco:test:789012#key-0']
  } as DIDDocument
};

/**
 * Test inscription data for Bitcoin Ordinals resolution
 */
export const testInscriptions = {
  /**
   * Valid DID inscription with proper format
   */
  validDidInscription: {
    inscriptionId: 'test-inscription-valid-did',
    content: 'BTCO DID: did:btco:123456',
    contentType: 'text/plain',
    contentUrl: 'http://test-ordinals/content/test-inscription-valid-did',
    sat: 123456,
    metadata: testDidDocuments.btcoDid
  },

  /**
   * Invalid inscription that doesn't contain a DID
   */
  invalidInscription: {
    inscriptionId: 'test-inscription-invalid',
    content: 'This is just some random text, not a DID',
    contentType: 'text/plain',
    contentUrl: 'http://test-ordinals/content/test-inscription-invalid',
    sat: 123456,
    metadata: null
  },

  /**
   * Deactivated DID inscription (contains 🔥 emoji)
   */
  deactivatedDidInscription: {
    inscriptionId: 'test-inscription-deactivated',
    content: 'BTCO DID: did:btco:123456 🔥',
    contentType: 'text/plain',
    contentUrl: 'http://test-ordinals/content/test-inscription-deactivated',
    sat: 123456,
    metadata: { ...testDidDocuments.btcoDid, deactivated: true }
  },

  /**
   * JSON-encoded DID document inscription
   */
  jsonDidInscription: {
    inscriptionId: 'test-inscription-json-did',
    content: JSON.stringify(testDidDocuments.btcoDid),
    contentType: 'application/json',
    contentUrl: 'http://test-ordinals/content/test-inscription-json-did',
    sat: 123456,
    metadata: testDidDocuments.btcoDid
  }
};

/**
 * Helper function to create mock fetch responses for inscription content
 */
export function createInscriptionFetchMock(inscriptionMap: Record<string, typeof testInscriptions[keyof typeof testInscriptions]>) {
  return async (url: string): Promise<Response> => {
    // Match content URLs
    for (const [key, inscription] of Object.entries(inscriptionMap)) {
      if (url === inscription.contentUrl) {
        return new Response(inscription.content, {
          status: 200,
          headers: { 'Content-Type': inscription.contentType }
        });
      }
    }

    // Default 404 for unknown URLs
    return new Response('Not Found', { status: 404 });
  };
}

/**
 * Helper function to create a mock OrdinalsProvider for testing
 */
export function createMockOrdinalsProvider(inscriptionMap: Record<string, typeof testInscriptions[keyof typeof testInscriptions]>) {
  return {
    async getSatInfo(satNumber: string) {
      const inscriptions = Object.values(inscriptionMap).filter(i => i.sat === Number(satNumber));
      return {
        inscription_ids: inscriptions.map(i => i.inscriptionId)
      };
    },

    async resolveInscription(inscriptionId: string) {
      const inscription = Object.values(inscriptionMap).find(i => i.inscriptionId === inscriptionId);
      if (!inscription) {
        throw new Error(`Inscription ${inscriptionId} not found`);
      }

      return {
        id: inscription.inscriptionId,
        inscription_id: inscription.inscriptionId,
        sat: inscription.sat,
        content_type: inscription.contentType,
        content_url: inscription.contentUrl
      };
    },

    async getMetadata(inscriptionId: string) {
      const inscription = Object.values(inscriptionMap).find(i => i.inscriptionId === inscriptionId);
      return inscription?.metadata || null;
    }
  };
}

/**
 * Standard test Bitcoin addresses for each network
 */
export const testBitcoinAddresses = {
  mainnet: {
    p2wpkh: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    p2tr: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
  },
  testnet: {
    p2wpkh: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    p2tr: 'tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv'
  },
  regtest: {
    p2wpkh: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    p2tr: 'bcrt1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq9jkkda'
  },
  signet: {
    p2wpkh: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    p2tr: 'tb1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqp3mvzv'
  }
};

/**
 * Helper to generate valid SHA-256 hashes for test resources
 */
export function makeTestHash(prefix: string): string {
  // Replace non-hex characters with their hex representation
  const hexOnly = prefix.split('').map(c => {
    if (/[0-9a-f]/i.test(c)) return c;
    return c.charCodeAt(0).toString(16).slice(-1);
  }).join('');

  return hexOnly.padEnd(64, '0');
}

/**
 * Standard verifiable credential contexts
 */
export const credentialContexts = {
  w3cCredential: 'https://www.w3.org/2018/credentials/v1',
  w3cDid: 'https://www.w3.org/ns/did/v1',
  securityV1: 'https://w3id.org/security/v1',
  securityV2: 'https://w3id.org/security/v2',
  multikey: 'https://w3id.org/security/multikey/v1'
};
