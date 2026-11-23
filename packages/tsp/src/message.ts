import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad as base64url } from '@scure/base';
import { cesrFromBinary, cesrToBinary } from './cesr/binary.js';
import {
  CryptoType,
  DecodeError,
  Payload,
  SignatureType,
  decodeEnvelope,
  decodePayload,
  encodeCiphertext,
  encodeEnvelopePrefix,
  encodePayload,
  encodeSignature,
  finalizeEnvelopeFrame,
  encodeDigestInput,
  type Digest,
} from './cesr/packet.js';
export type { Payload } from './cesr/packet.js';
import { bytesFromNumberStream } from './cesr/encode.js';
import { hpkeOpen, hpkeSeal } from './crypto/hpke.js';

export type LocalVid = {
  id: string;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  encryptionPrivateKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  transport?: string;
};

export type OpenedMessage = {
  senderId: string;
  receiverId: string | null;
  crypto: CryptoType;
  payload: Payload;
  applicationData?: Uint8Array;
};

export function vidIdBytes(id: string): Uint8Array {
  return new TextEncoder().encode(id);
}

async function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<void> {
  const ok = await ed.verifyAsync(signature, message, publicKey);
  if (!ok) throw new Error('invalid signature');
}

async function signEd25519(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

function hashDigestInput(
  payload: Payload,
  senderIdentity: Uint8Array | null,
  envelopePrefix: Uint8Array,
): Uint8Array {
  const stream: number[] = [];
  encodeDigestInput(payload, senderIdentity, envelopePrefix, stream);
  return bytesFromNumberStream(stream);
}

export function verifyRelationshipDigest(
  payload: Payload,
  senderIdentity: Uint8Array | null,
  envelopePrefix: Uint8Array,
): void {
  if (payload.type !== 'rfi' && payload.type !== 'rfa') return;
  if (payload.type === 'rfa') {
    // Request digest is copied from the invite; only reply digest is self-referential.
    const replyOnly: Payload = payload;
    const embedded = replyOnly.replyDigest;
    if (embedded.kind !== 'sha256') throw new Error('unsupported digest algorithm');
    const computed = sha256(
      hashDigestInput(replyOnly, senderIdentity, envelopePrefix),
    );
    for (let i = 0; i < computed.length; i++) {
      if (computed[i] !== embedded.bytes[i]) throw new Error('digest mismatch');
    }
    return;
  }
  const embedded = payload.requestDigest;
  if (embedded.kind !== 'sha256') {
    throw new Error('unsupported digest algorithm');
  }
  const computed = sha256(hashDigestInput(payload, senderIdentity, envelopePrefix));
  if (computed.length !== embedded.bytes.length) throw new Error('digest mismatch');
  for (let i = 0; i < computed.length; i++) {
    if (computed[i] !== embedded.bytes[i]) throw new Error('digest mismatch');
  }
}

export async function openTspMessage(
  wire: Uint8Array,
  sender: Pick<LocalVid, 'signingPublicKey' | 'id'>,
  receiver?: Pick<LocalVid, 'encryptionPrivateKey' | 'id'>,
): Promise<OpenedMessage> {
  const binary = cesrToBinary(wire);
  const decoded = decodeEnvelope(binary);
  await verifyEd25519(sender.signingPublicKey, decoded.signedData, decoded.signature);

  const senderId = new TextDecoder().decode(decoded.envelope.sender);
  const receiverId = decoded.envelope.receiver
    ? new TextDecoder().decode(decoded.envelope.receiver)
    : null;

  if (decoded.cryptoType === CryptoType.Plaintext) {
    if (!decoded.payloadBytes) throw new DecodeError('missing payload');
    const inner = decodePayload(decoded.payloadBytes);
    verifyEsr(senderId, inner.senderIdentity);
    return {
      senderId,
      receiverId,
      crypto: CryptoType.Plaintext,
      payload: inner.payload,
      applicationData: inner.payload.type === 'generic' ? inner.payload.data : undefined,
    };
  }

  if (decoded.cryptoType !== CryptoType.HpkeBase) {
    throw new Error('unsupported crypto type');
  }
  if (!receiver) throw new Error('receiver keys required for confidential message');
  if (receiverId && receiverId !== receiver.id) {
    throw new Error('unexpected recipient');
  }

  const ct = decoded.payloadBytes;
  if (!ct) throw new DecodeError('missing ciphertext');
  const plaintext = await hpkeOpen(receiver.encryptionPrivateKey, ct, decoded.rawHeader);
  const inner = decodePayload(plaintext);
  verifyEsr(senderId, inner.senderIdentity);
  verifyRelationshipDigest(inner.payload, inner.senderIdentity, decoded.rawHeader);

  return {
    senderId,
    receiverId,
    crypto: CryptoType.HpkeBase,
    payload: inner.payload,
    applicationData: inner.payload.type === 'generic' ? inner.payload.data : undefined,
  };
}

function verifyEsr(senderId: string, essr: Uint8Array | null): void {
  if (!essr) return;
  const id = new TextDecoder().decode(essr);
  if (id !== senderId) throw new Error('ESSR sender mismatch');
}

export function computeRelationshipDigest(
  payload: Extract<Payload, { type: 'rfi' } | { type: 'rfa' }>,
  senderIdentity: Uint8Array | null,
  envelopePrefix: Uint8Array,
): Digest {
  const digestInput: number[] = [];
  encodeDigestInput(payload, senderIdentity, envelopePrefix, digestInput);
  return { kind: 'sha256', bytes: sha256(bytesFromNumberStream(digestInput)) };
}

export async function sealTspPayload(
  sender: LocalVid,
  receiver: LocalVid,
  payload: Payload,
  options?: { confidential?: boolean },
): Promise<Uint8Array> {
  const confidential = options?.confidential ?? payload.type !== 'generic';
  const stream: number[] = [];
  const senderBytes = vidIdBytes(sender.id);
  const receiverBytes = vidIdBytes(receiver.id);
  encodeEnvelopePrefix(senderBytes, receiverBytes, stream);
  const prefix = bytesFromNumberStream(stream);

  let sealedPayload = payload;
  if (payload.type === 'rfi') {
    const digest = computeRelationshipDigest(payload, senderBytes, prefix);
    sealedPayload = { ...payload, requestDigest: digest };
  } else if (payload.type === 'rfa') {
    const digest = computeRelationshipDigest(payload, senderBytes, prefix);
    sealedPayload = { ...payload, replyDigest: digest };
  }

  const senderInPayload = confidential ? senderBytes : null;
  const payloadCesr: number[] = [];
  encodePayload(sealedPayload, senderInPayload, null, payloadCesr);
  const payloadBytes = bytesFromNumberStream(payloadCesr);

  if (confidential) {
    const ct = await hpkeSeal(receiver.encryptionPublicKey, payloadBytes, prefix);
    encodeCiphertext(ct, CryptoType.HpkeBase, stream);
  } else {
    encodePayload(sealedPayload, senderInPayload, null, stream);
  }
  finalizeEnvelopeFrame(stream);
  const sig = await signEd25519(sender.signingPrivateKey, bytesFromNumberStream(stream));
  encodeSignature(sig, stream, SignatureType.Ed25519);
  return cesrFromBinary(bytesFromNumberStream(stream));
}

export async function sealTspMessage(
  sender: LocalVid,
  receiver: LocalVid,
  applicationPayload: Uint8Array,
): Promise<Uint8Array> {
  return sealTspPayload(sender, receiver, { type: 'generic', data: applicationPayload }, { confidential: true });
}

export async function signPlaintextMessage(
  sender: LocalVid,
  receiver: LocalVid | null,
  applicationPayload: Uint8Array,
): Promise<Uint8Array> {
  const stream: number[] = [];
  encodeEnvelopePrefix(vidIdBytes(sender.id), receiver ? vidIdBytes(receiver.id) : null, stream);
  const payload: Payload = { type: 'generic', data: applicationPayload };
  encodePayload(payload, null, null, stream);
  finalizeEnvelopeFrame(stream);
  const sig = await signEd25519(sender.signingPrivateKey, bytesFromNumberStream(stream));
  encodeSignature(sig, stream, SignatureType.Ed25519);
  return cesrFromBinary(bytesFromNumberStream(stream));
}

export function keysFromRev3Vid(v: {
  id: string;
  sigkey: string;
  enckey: string;
  publicSigkey?: string;
  publicEnckey?: string;
}): LocalVid {
  const signingPrivateKey = base64url.decode(v.sigkey);
  const encryptionPrivateKey = base64url.decode(v.enckey);
  return {
    id: v.id,
    signingPrivateKey,
    encryptionPrivateKey,
    signingPublicKey: v.publicSigkey ? base64url.decode(v.publicSigkey) : ed.getPublicKey(signingPrivateKey),
    encryptionPublicKey: v.publicEnckey ? base64url.decode(v.publicEnckey) : (() => {
      throw new Error('publicEnckey required');
    })(),
  };
}