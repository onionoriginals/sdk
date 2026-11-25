import { encodeX25519PrivateMultikey, encodeX25519PublicMultikey } from '@originals/tsp';
import { x25519 } from '@noble/curves/ed25519.js';
import type { WebVHVerificationMethodInput } from '../did/webvh-document.js';
import { assertSdkDidDocumentHasNoJwk } from './deliver.js';

export const TSP_ENC_VM_ID = '#key-tsp-enc';
export const TSP_SERVICE_ID = '#tsp-transport';

export type TspWebvhKeyMaterial = {
  encryptionPublicMultibase: string;
  encryptionPrivateMultibase: string;
  encryptionPrivateKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
};

export function generateTspWebvhKeyMaterial(): TspWebvhKeyMaterial {
  const encryptionPrivateKey = x25519.utils.randomSecretKey();
  const encryptionPublicKey = x25519.getPublicKey(encryptionPrivateKey);
  return {
    encryptionPrivateKey,
    encryptionPublicKey,
    encryptionPublicMultibase: encodeX25519PublicMultikey(encryptionPublicKey),
    encryptionPrivateMultibase: encodeX25519PrivateMultikey(encryptionPrivateKey),
  };
}

export function tspWebvhDocumentFields(
  transport: string,
  material: TspWebvhKeyMaterial,
): {
  additionalVerificationMethods: WebVHVerificationMethodInput[];
  services: Array<Record<string, unknown>>;
  keyAgreement: string[];
} {
  const additionalVerificationMethods: WebVHVerificationMethodInput[] = [
    {
      id: TSP_ENC_VM_ID,
      type: 'Multikey',
      publicKeyMultibase: material.encryptionPublicMultibase,
      purpose: 'keyAgreement',
    },
  ];
  const services = [
    {
      id: TSP_SERVICE_ID,
      type: 'TSPTransport',
      serviceEndpoint: transport,
    },
  ];
  const fields = {
    additionalVerificationMethods,
    services,
    keyAgreement: [TSP_ENC_VM_ID],
  };
  assertSdkDidDocumentHasNoJwk({
    verificationMethod: additionalVerificationMethods,
    service: services,
  });
  return fields;
}