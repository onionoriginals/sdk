import { base58, base64urlnopad as base64url } from '@scure/base';
import { decodeX25519PublicMultikey, encodeX25519PublicMultikey } from './multikey-x25519.js';

const ED25519_PUBLIC_PREFIX = new Uint8Array([0xed, 0x01]);

export type VidKeys = {
  id: string;
  transport: string;
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
};

type VerificationMethod = {
  id: string;
  type: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: {
    kty?: string;
    crv?: string;
    x?: string;
    use?: string;
  };
};

type DidDocument = {
  id?: string;
  authentication?: Array<string | VerificationMethod>;
  assertionMethod?: Array<string | VerificationMethod>;
  keyAgreement?: Array<string | VerificationMethod>;
  verificationMethod?: VerificationMethod[];
  service?: Array<{
    type?: string;
    serviceEndpoint?: string | { uri?: string };
  }>;
};

function findVm(doc: DidDocument, ref: string | VerificationMethod): VerificationMethod | undefined {
  if (typeof ref !== 'string') return ref;
  const frag = ref.includes('#') ? ref.split('#').pop()! : ref;
  return doc.verificationMethod?.find((vm) => vm.id === ref || vm.id === `#${frag}` || vm.id.endsWith(`#${frag}`));
}

function decodeEd25519Multikey(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) throw new Error('expected multikey z-prefix');
  const raw = base58.decode(multibase.slice(1));
  if (raw.length === ED25519_PUBLIC_PREFIX.length + 32 && raw[0] === ED25519_PUBLIC_PREFIX[0]) {
    return raw.subarray(ED25519_PUBLIC_PREFIX.length);
  }
  // Standard multikey Ed25519 (0xed 0x01 + 32 bytes)
  if (raw.length >= 34 && raw[0] === 0xed) {
    return raw.subarray(raw.length - 32);
  }
  throw new Error('unsupported Ed25519 multikey');
}

function decodeSigningKey(vm: VerificationMethod): Uint8Array {
  if (vm.type === 'Multikey' && vm.publicKeyMultibase) {
    return decodeEd25519Multikey(vm.publicKeyMultibase);
  }
  if (vm.type === 'JsonWebKey2020' && vm.publicKeyJwk?.crv === 'Ed25519' && vm.publicKeyJwk.x) {
    return base64url.decode(vm.publicKeyJwk.x);
  }
  throw new Error(`unsupported signing method ${vm.type}`);
}

function decodeEncryptionKey(vm: VerificationMethod): Uint8Array {
  if (vm.type === 'Multikey' && vm.publicKeyMultibase) {
    return decodeX25519PublicMultikey(vm.publicKeyMultibase);
  }
  if (vm.type === 'JsonWebKey2020' && vm.publicKeyJwk?.crv === 'X25519' && vm.publicKeyJwk.x) {
    return base64url.decode(vm.publicKeyJwk.x);
  }
  throw new Error(`unsupported encryption method ${vm.type}`);
}

function parseTransport(doc: DidDocument): string {
  const services = doc.service ?? [];
  const hit = services.find((s) => {
    const t = (s.type ?? '').toLowerCase();
    return t === 'tsptransport' || t === 'tsp';
  });
  if (!hit) throw new Error('no TSP transport service');
  const ep = hit.serviceEndpoint;
  if (typeof ep === 'string') return ep;
  if (ep && typeof ep === 'object' && typeof ep.uri === 'string') return ep.uri;
  throw new Error('invalid TSP serviceEndpoint');
}

function firstRef(
  doc: DidDocument,
  list: Array<string | VerificationMethod> | undefined,
): VerificationMethod | undefined {
  if (!list?.length) return undefined;
  return findVm(doc, list[0]!);
}

export function resolveVidKeys(didDocument: DidDocument, targetId?: string): VidKeys {
  if (targetId && didDocument.id && didDocument.id !== targetId) {
    throw new Error('DID id mismatch');
  }
  const signing =
    firstRef(didDocument, didDocument.authentication) ??
    firstRef(didDocument, didDocument.assertionMethod);
  const enc = firstRef(didDocument, didDocument.keyAgreement);
  if (!signing || !enc) throw new Error('missing signing or encryption key reference');

  const signingVm = findVm(didDocument, signing);
  const encVm = findVm(didDocument, enc);
  if (!signingVm || !encVm) throw new Error('verification method not found');

  const signingPublicKey = decodeSigningKey(signingVm);
  const encryptionPublicKey = decodeEncryptionKey(encVm);

  return {
    id: didDocument.id ?? targetId ?? '',
    transport: parseTransport(didDocument),
    signingPublicKey,
    encryptionPublicKey,
  };
}

/** Build a DID document with Multikey VMs for this endpoint (never JsonWebKey2020). */
export function buildMultikeyDidDocument(vid: VidKeys): Record<string, unknown> {
  const edPub = new Uint8Array(ED25519_PUBLIC_PREFIX.length + vid.signingPublicKey.length);
  edPub.set(ED25519_PUBLIC_PREFIX, 0);
  edPub.set(vid.signingPublicKey, ED25519_PUBLIC_PREFIX.length);

  const encMb = encodeX25519PublicMultikey(vid.encryptionPublicKey);
  return {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: vid.id,
    verificationMethod: [
      {
        id: '#key-1',
        type: 'Multikey',
        publicKeyMultibase: `z${base58.encode(edPub)}`,
      },
      {
        id: '#key-2',
        type: 'Multikey',
        publicKeyMultibase: encMb,
      },
    ],
    authentication: ['#key-1'],
    keyAgreement: ['#key-2'],
    service: [
      {
        id: '#tsp',
        type: 'TSPTransport',
        serviceEndpoint: { uri: vid.transport },
      },
    ],
  };
}