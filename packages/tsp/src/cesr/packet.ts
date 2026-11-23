import { decodeCount, decodeFixedData, decodeIndexedData, decodeVariableData, decodeVariableDataIndex } from './decode.js';
import {
  encodeCount,
  encodeFixedData,
  encodeIndexedData,
  encodeVariableData,
  bytesFromNumberStream,
} from './encode.js';
import {
  DIGEST_DUMMY,
  ED25519_SIGNATURE,
  TSP_ATTACH_GRP,
  TSP_BLAKE2B256,
  TSP_GENERIC_STREAM,
  TSP_HPKEBASE_CIPHERTEXT,
  TSP_HOP_LIST,
  TSP_INDEX_SIG_GRP,
  TSP_NONCE,
  TSP_PAYLOAD,
  TSP_PLAINTEXT,
  TSP_SEALEDBOX_CIPHERTEXT,
  TSP_SHA256,
  TSP_VERSION,
  TSP_VID,
  TSP_WRAPPER,
  XRFI,
  XRFA,
  XSCS,
  XCTL,
  XHOP,
  XPAD,
  XRFD,
  YTSP,
} from './consts.js';

export enum CryptoType {
  Plaintext = 0,
  HpkeBase = 1,
  SealedBox = 2,
}

export enum SignatureType {
  NoSignature = 0,
  Ed25519 = 1,
  MlDsa65 = 2,
}

export type Digest = { kind: 'sha256' | 'blake2b256'; bytes: Uint8Array };

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeError';
  }
}

export interface Envelope<Vid = Uint8Array> {
  cryptoType: CryptoType;
  signatureType: SignatureType;
  sender: Vid;
  receiver: Vid | null;
}

export type Payload<Vid = Uint8Array> =
  | { type: 'generic'; data: Uint8Array }
  | { type: 'control'; data: Uint8Array }
  | { type: 'padding'; nonce: Uint8Array }
  | { type: 'nested'; data: Uint8Array }
  | { type: 'routed'; hops: Vid[]; data: Uint8Array }
  | {
      type: 'rfi';
      requestDigest: Digest;
      nonce: Uint8Array;
      replyPath: Vid[];
      referral: { newVid: Vid; signature: Uint8Array } | null;
    }
  | { type: 'rfa'; requestDigest: Digest; replyDigest: Digest }
  | { type: 'rfd'; reply: Digest };

const DATA_LIMIT = 3 * (1 << 24);

function checkedEncodeVariableData(id: number, payload: Uint8Array, stream: number[]): void {
  if (payload.length >= DATA_LIMIT) {
    throw new EncodeError('ExcessiveFieldSize');
  }
  encodeVariableData(id, payload, stream);
}

function checkedDecodeVariableDataIndex(id: number, stream: Uint8Array, pos: number) {
  const found = decodeVariableDataIndex(id, stream, pos);
  if (!found) return null;
  const len = found.range[1] - found.range[0];
  if (len >= DATA_LIMIT) return null;
  return found;
}

function encVersion(stream: number[]): void {
  stream.push(...YTSP);
  encodeCount(TSP_VERSION[0], TSP_VERSION[1], stream);
}

export function encodeEnvelopePrefix(
  sender: Uint8Array,
  receiver: Uint8Array | null,
  stream: number[],
): void {
  encVersion(stream);
  if (sender.length === 0) throw new EncodeError('InvalidVid');
  checkedEncodeVariableData(TSP_VID, sender, stream);
  checkedEncodeVariableData(TSP_VID, receiver ?? new Uint8Array(0), stream);
}

export function encodeEnvelope(envelope: Envelope<Uint8Array>, stream: number[]): void {
  encodeEnvelopePrefix(envelope.sender, envelope.receiver, stream);
}

export function finalizeEnvelopeFrame(data: number[]): void {
  const frame: number[] = [];
  encodeCount(TSP_WRAPPER, Math.floor(data.length / 3), frame);
  data.unshift(...frame);
}

function encodeDigest(digest: Digest, stream: number[]): void {
  const id = digest.kind === 'sha256' ? TSP_SHA256 : TSP_BLAKE2B256;
  encodeFixedData(id, digest.bytes, stream);
}

function encodeSenderIdentity(sender: Uint8Array | null, stream: number[]): void {
  checkedEncodeVariableData(TSP_VID, sender ?? new Uint8Array(0), stream);
}

function encodePadding(padding: Uint8Array | null, stream: number[]): void {
  checkedEncodeVariableData(TSP_PLAINTEXT, padding ?? new Uint8Array(0), stream);
}

function encodeOpaqueData(data: Uint8Array, stream: number[]): void {
  const primitive: number[] = [];
  checkedEncodeVariableData(TSP_PLAINTEXT, data, primitive);
  encodeCount(TSP_GENERIC_STREAM, Math.floor(primitive.length / 3), stream);
  stream.push(...primitive);
}

function encodeHops(hops: Uint8Array[], stream: number[]): void {
  const temp: number[] = [];
  for (const hop of hops) {
    checkedEncodeVariableData(TSP_VID, hop, temp);
  }
  encodeCount(TSP_HOP_LIST, Math.floor(temp.length / 3), stream);
  stream.push(...temp);
}

function encodeReferral(
  referral: { newVid: Uint8Array; signature: Uint8Array } | null,
  stream: number[],
): void {
  if (!referral) {
    encodeCount(TSP_HOP_LIST, 0, stream);
    return;
  }
  const temp: number[] = [];
  checkedEncodeVariableData(TSP_VID, referral.newVid, temp);
  encodeSignatureAttachment(referral.signature, SignatureType.Ed25519, temp);
  encodeCount(TSP_HOP_LIST, Math.floor(temp.length / 3), stream);
  stream.push(...temp);
}

export function encodePayload(
  payload: Payload,
  senderIdentity: Uint8Array | null,
  padding: Uint8Array | null,
  output: number[],
): void {
  const temp: number[] = [];

  switch (payload.type) {
    case 'generic':
      temp.push(...XSCS);
      encodeSenderIdentity(senderIdentity, temp);
      encodePadding(padding, temp);
      encodeOpaqueData(payload.data, temp);
      break;
    case 'control':
      temp.push(...XCTL);
      encodeSenderIdentity(senderIdentity, temp);
      encodePadding(padding, temp);
      encodeOpaqueData(payload.data, temp);
      break;
    case 'padding':
      temp.push(...XPAD);
      encodeSenderIdentity(senderIdentity, temp);
      encodeFixedData(TSP_NONCE, payload.nonce, temp);
      encodePadding(padding, temp);
      break;
    case 'rfi':
      temp.push(...XRFI);
      encodeSenderIdentity(senderIdentity, temp);
      encodeDigest(payload.requestDigest, temp);
      encodeFixedData(TSP_NONCE, payload.nonce, temp);
      encodeHops(payload.replyPath, temp);
      encodeReferral(
        payload.referral
          ? { newVid: payload.referral.newVid, signature: payload.referral.signature }
          : null,
        temp,
      );
      encodePadding(padding, temp);
      break;
    case 'rfa':
      temp.push(...XRFA);
      encodeSenderIdentity(senderIdentity, temp);
      encodeDigest(payload.requestDigest, temp);
      encodeDigest(payload.replyDigest, temp);
      encodePadding(padding, temp);
      break;
    case 'rfd':
      temp.push(...XRFD);
      encodeSenderIdentity(senderIdentity, temp);
      encodeDigest(payload.reply, temp);
      encodePadding(padding, temp);
      break;
    default:
      throw new EncodeError('Unsupported payload type');
  }

  encodeCount(TSP_PAYLOAD, Math.floor(temp.length / 3), output);
  output.push(...temp);
}

function cryptoCesrCode(crypto: CryptoType): number {
  switch (crypto) {
    case CryptoType.SealedBox:
      return TSP_SEALEDBOX_CIPHERTEXT;
    case CryptoType.HpkeBase:
      return TSP_HPKEBASE_CIPHERTEXT;
    default:
      throw new DecodeError('InvalidCrypto');
  }
}

export function encodeCiphertext(ciphertext: Uint8Array, crypto: CryptoType, stream: number[]): void {
  checkedEncodeVariableData(cryptoCesrCode(crypto), ciphertext, stream);
}

function encodeSignatureAttachment(
  signature: Uint8Array,
  sigType: SignatureType,
  output: number[],
): void {
  if (sigType === SignatureType.NoSignature) return;
  if (sigType === SignatureType.Ed25519) {
    const primitiveQuadlets = Math.ceil((signature.length + 2) / 3);
    encodeCount(TSP_ATTACH_GRP, primitiveQuadlets + 1, output);
    encodeCount(TSP_INDEX_SIG_GRP, primitiveQuadlets, output);
    encodeIndexedData(ED25519_SIGNATURE, 0, signature, output);
  } else {
    throw new EncodeError('Unsupported signature type');
  }
}

export function encodeSignature(signature: Uint8Array, output: number[], sigType: SignatureType): void {
  encodeSignatureAttachment(signature, sigType, output);
}

export function encodeDigestInput(
  payload: Payload,
  senderIdentity: Uint8Array | null,
  envelopePrefix: Uint8Array,
  output: number[],
): void {
  for (const b of envelopePrefix) output.push(b);

  if (payload.type === 'rfi') {
    output.push(...XRFI);
    encodeSenderIdentity(senderIdentity, output);
    output.push(...DIGEST_DUMMY);
    encodeFixedData(TSP_NONCE, payload.nonce, output);
    encodeHops(payload.replyPath, output);
    if (payload.referral) {
      checkedEncodeVariableData(TSP_VID, payload.referral.newVid, output);
    } else {
      encodeCount(TSP_HOP_LIST, 0, output);
    }
  } else if (payload.type === 'rfa') {
    output.push(...XRFA);
    encodeSenderIdentity(senderIdentity, output);
    encodeDigest(payload.requestDigest, output);
    output.push(...DIGEST_DUMMY);
  } else {
    throw new EncodeError('NoDigestSlot');
  }
}

function decodeDigest(stream: Uint8Array): { digest: Digest; rest: Uint8Array } | null {
  const sha = decodeFixedData(TSP_SHA256, stream, 32);
  if (sha) return { digest: { kind: 'sha256', bytes: sha.value }, rest: sha.rest };
  const b2 = decodeFixedData(TSP_BLAKE2B256, stream, 32);
  if (b2) return { digest: { kind: 'blake2b256', bytes: b2.value }, rest: b2.rest };
  return null;
}

function decodeSenderIdentity(stream: Uint8Array): { vid: Uint8Array | null; rest: Uint8Array } | null {
  const found = decodeVariableData(TSP_VID, stream);
  if (!found) return null;
  return { vid: found.value.length === 0 ? null : found.value, rest: found.rest };
}

function decodePadding(stream: Uint8Array): Uint8Array | null {
  const found = decodeVariableData(TSP_PLAINTEXT, stream);
  return found?.rest ?? null;
}

function decodeOpaqueData(stream: Uint8Array): { data: Uint8Array; rest: Uint8Array } | null {
  const count = decodeCount(TSP_GENERIC_STREAM, stream);
  if (!count) return null;
  const streamBytes = count.count * 3;
  if (count.rest.length < streamBytes) return null;
  const region = count.rest.subarray(0, streamBytes);
  const inner = decodeVariableData(TSP_PLAINTEXT, region);
  if (!inner || inner.rest.length > 0) return null;
  return { data: inner.value, rest: count.rest.subarray(streamBytes) };
}

function decodeHops(stream: Uint8Array): { hops: Uint8Array[]; rest: Uint8Array } | null {
  const count = decodeCount(TSP_HOP_LIST, stream);
  if (!count) return null;
  const bytes = count.count * 3;
  if (count.rest.length < bytes) return null;
  let hopStream = count.rest.subarray(0, bytes);
  const rest = count.rest.subarray(bytes);
  const hops: Uint8Array[] = [];
  while (hopStream.length > 0) {
    const hop = decodeVariableData(TSP_VID, hopStream);
    if (!hop) return null;
    hops.push(hop.value);
    hopStream = hop.rest;
  }
  return { hops, rest };
}

function decodeReferral(
  stream: Uint8Array,
): { referral: { newVid: Uint8Array; signature: Uint8Array } | null; rest: Uint8Array } | null {
  const count = decodeCount(TSP_HOP_LIST, stream);
  if (!count) return null;
  const bytes = count.count * 3;
  if (count.rest.length < bytes) return null;
  let referral = count.rest.subarray(0, bytes);
  const rest = count.rest.subarray(bytes);
  if (referral.length === 0) return { referral: null, rest };
  const vid = decodeVariableData(TSP_VID, referral);
  if (!vid || vid.value.length === 0) return null;
  referral = vid.rest;
  const sig = decodeSignatureAttachment(referral);
  if (!sig || sig.rest.length > 0) return null;
  return { referral: { newVid: vid.value, signature: sig.signature }, rest };
}

function decodeSignatureAttachment(stream: Uint8Array): { signature: Uint8Array; rest: Uint8Array } | null {
  const attach = decodeCount(TSP_ATTACH_GRP, stream);
  if (!attach) return null;
  const regionLen = attach.count * 3;
  if (attach.rest.length < regionLen) return null;
  const region = attach.rest.subarray(0, regionLen);
  const rest = attach.rest.subarray(regionLen);
  const ig = decodeCount(TSP_INDEX_SIG_GRP, region);
  if (!ig) return null;
  if (ig.rest.length !== ig.count * 3) return null;
  const indexed = decodeIndexedData(ED25519_SIGNATURE, ig.rest, 64);
  if (!indexed) return null;
  if (indexed.index !== 0) return null;
  if (indexed.rest.length > 0) return null;
  return { signature: indexed.value, rest };
}

export interface DecodedEnvelope {
  envelope: Envelope<Uint8Array>;
  rawHeader: Uint8Array;
  signedData: Uint8Array;
  signature: Uint8Array;
  payloadBytes: Uint8Array | null;
  cryptoType: CryptoType;
  signatureType: SignatureType;
}

export function detectedTspHeader(
  stream: Uint8Array,
  pos: number,
): {
  sender: [number, number];
  receiver: [number, number] | null;
  cryptoType: CryptoType;
  signatureType: SignatureType;
  contentEnd: number;
  nextPos: number;
} {
  const origin = stream;
  let s = stream.subarray(pos);
  const frame = decodeCount(TSP_WRAPPER, s);
  if (!frame) throw new DecodeError('NotTsp');
  const contentStart = origin.length - frame.rest.length;
  const contentLen = frame.count * 3;
  const contentEnd = contentStart + contentLen;
  if (contentEnd > origin.length) throw new DecodeError('InvalidFrameCount');
  s = frame.rest;

  if (s.length < YTSP.length + 3) throw new DecodeError('NotTsp');
  if (s.subarray(0, 3).join(',') !== YTSP.join(',')) throw new DecodeError('NotTsp');
  s = s.subarray(3);
  const ver = decodeCount(TSP_VERSION[0], s);
  if (!ver) throw new DecodeError('VersionMismatch');
  s = ver.rest;

  let midPos = origin.length - s.length;
  const senderFound = checkedDecodeVariableDataIndex(TSP_VID, origin, midPos);
  if (!senderFound) throw new DecodeError('UnexpectedData');
  const senderBytes = origin.subarray(senderFound.range[0], senderFound.range[1]);
  if (senderBytes.length === 0) throw new DecodeError('VidError');
  midPos = senderFound.next;

  const receiverFound = checkedDecodeVariableDataIndex(TSP_VID, origin, midPos);
  if (!receiverFound) throw new DecodeError('UnexpectedData');
  const receiverBytes = origin.subarray(receiverFound.range[0], receiverFound.range[1]);
  midPos = receiverFound.next;

  s = origin.subarray(midPos);
  let cryptoType: CryptoType;
  if (decodeVariableData(TSP_HPKEBASE_CIPHERTEXT, s)) {
    cryptoType = CryptoType.HpkeBase;
  } else if (decodeVariableData(TSP_SEALEDBOX_CIPHERTEXT, s)) {
    cryptoType = CryptoType.SealedBox;
  } else {
    const pl = decodeCount(TSP_PAYLOAD, s);
    if (!pl) throw new DecodeError('UnexpectedData');
    const codeLen = s.length - pl.rest.length;
    const payloadBytes = pl.count * 3;
    const end = midPos + codeLen + payloadBytes;
    if (end !== contentEnd) throw new DecodeError('InvalidFrameCount');
    s = pl.rest;
    cryptoType = CryptoType.Plaintext;
  }

  if (origin.length - s.length !== contentEnd) {
    throw new DecodeError('InvalidFrameCount');
  }

  const sigStream = origin.subarray(contentEnd);
  const sig = decodeSignatureAttachment(sigStream);
  if (!sig) throw new DecodeError('InvalidSignatureType');
  if (sig.rest.length > 0) throw new DecodeError('TrailingGarbage');

  return {
    sender: senderFound.range,
    receiver: receiverBytes.length === 0 ? null : receiverFound.range,
    cryptoType,
    signatureType: SignatureType.Ed25519,
    contentEnd,
    nextPos: contentEnd + (sigStream.length - sig.rest.length),
  };
}

export function decodeEnvelope(stream: Uint8Array): DecodedEnvelope {
  const frame = decodeCount(TSP_WRAPPER, stream);
  if (!frame) throw new DecodeError('NotTsp');
  const frameLen = stream.length - frame.rest.length;

  let pos = frameLen;
  if (stream.subarray(pos, pos + YTSP.length).join(',') !== YTSP.join(',')) {
    throw new DecodeError('NotTsp');
  }
  pos += YTSP.length;
  const ver = decodeCount(TSP_VERSION[0], stream.subarray(pos));
  if (!ver) throw new DecodeError('VersionMismatch');
  pos = stream.length - ver.rest.length;

  const senderFound = checkedDecodeVariableDataIndex(TSP_VID, stream, pos);
  if (!senderFound) throw new DecodeError('UnexpectedData');
  const sender = stream.subarray(senderFound.range[0], senderFound.range[1]);
  pos = senderFound.next;

  const receiverFound = checkedDecodeVariableDataIndex(TSP_VID, stream, pos);
  if (!receiverFound) throw new DecodeError('UnexpectedData');
  const receiver =
    receiverFound.range[1] - receiverFound.range[0] === 0
      ? null
      : stream.subarray(receiverFound.range[0], receiverFound.range[1]);
  pos = receiverFound.next;

  let cryptoType: CryptoType;
  let payloadBytes: Uint8Array | null = null;
  const headerEnd = pos;
  const tail = stream.subarray(pos);
  if (decodeVariableData(TSP_HPKEBASE_CIPHERTEXT, tail)) {
    cryptoType = CryptoType.HpkeBase;
    const ct = checkedDecodeVariableDataIndex(TSP_HPKEBASE_CIPHERTEXT, stream, pos);
    if (!ct) throw new DecodeError('UnexpectedData');
    payloadBytes = stream.subarray(ct.range[0], ct.range[1]);
    pos = ct.next;
  } else if (decodeVariableData(TSP_SEALEDBOX_CIPHERTEXT, tail)) {
    cryptoType = CryptoType.SealedBox;
    const ct = checkedDecodeVariableDataIndex(TSP_SEALEDBOX_CIPHERTEXT, stream, pos);
    if (!ct) throw new DecodeError('UnexpectedData');
    payloadBytes = stream.subarray(ct.range[0], ct.range[1]);
    pos = ct.next;
  } else {
    const pl = decodeCount(TSP_PAYLOAD, tail);
    if (!pl) throw new DecodeError('UnexpectedData');
    const codeLen = tail.length - pl.rest.length;
    const end = pos + codeLen + pl.count * 3;
    payloadBytes = stream.subarray(pos, end);
    pos = end;
    cryptoType = CryptoType.Plaintext;
  }

  const signedData = stream.subarray(0, pos);
  const sig = decodeSignatureAttachment(stream.subarray(pos));
  if (!sig) throw new DecodeError('InvalidSignatureType');
  if (sig.rest.length > 0) throw new DecodeError('TrailingGarbage');

  return {
    envelope: {
      cryptoType,
      signatureType: SignatureType.Ed25519,
      sender,
      receiver,
    },
    rawHeader: stream.subarray(frameLen, headerEnd),
    signedData,
    signature: sig.signature,
    payloadBytes,
    cryptoType,
    signatureType: SignatureType.Ed25519,
  };
}

export interface DecodedPayload {
  payload: Payload;
  senderIdentity: Uint8Array | null;
}

export function decodePayload(stream: Uint8Array): DecodedPayload {
  const frame = decodeCount(TSP_PAYLOAD, stream);
  if (!frame) throw new DecodeError('UnexpectedData');
  const payloadBytes = frame.count * 3;
  if (frame.rest.length < payloadBytes) throw new DecodeError('UnexpectedData');
  let body = frame.rest.subarray(0, payloadBytes);
  if (body.length < 3) throw new DecodeError('UnexpectedMsgType');
  const msgType = body.subarray(0, 3);
  body = body.subarray(3);

  const sender = decodeSenderIdentity(body);
  if (!sender) throw new DecodeError('UnexpectedData');
  body = sender.rest;

  const matchType = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]!);

  if (matchType(msgType, XSCS)) {
    body = decodePadding(body)!;
    const data = decodeOpaqueData(body)!;
    return { payload: { type: 'generic', data: data.data }, senderIdentity: sender.vid };
  }
  if (matchType(msgType, XCTL)) {
    body = decodePadding(body)!;
    const data = decodeOpaqueData(body)!;
    return { payload: { type: 'control', data: data.data }, senderIdentity: sender.vid };
  }
  if (matchType(msgType, XRFI)) {
    const dig = decodeDigest(body)!;
    body = dig.rest;
    const nonce = decodeFixedData(TSP_NONCE, body, 16)!;
    body = nonce.rest;
    const hops = decodeHops(body)!;
    body = hops.rest;
    const referral = decodeReferral(body)!;
    body = decodePadding(referral.rest)!;
    if (body.length > 0) throw new DecodeError('TrailingGarbage');
    return {
      payload: {
        type: 'rfi',
        requestDigest: dig.digest,
        nonce: nonce.value,
        replyPath: hops.hops,
        referral: referral.referral,
      },
      senderIdentity: sender.vid,
    };
  }
  if (matchType(msgType, XRFA)) {
    const req = decodeDigest(body)!;
    body = req.rest;
    const rep = decodeDigest(body)!;
    body = decodePadding(rep.rest)!;
    if (body.length > 0) throw new DecodeError('TrailingGarbage');
    return {
      payload: {
        type: 'rfa',
        requestDigest: req.digest,
        replyDigest: rep.digest,
      },
      senderIdentity: sender.vid,
    };
  }
  if (matchType(msgType, XPAD)) {
    const nonce = decodeFixedData(TSP_NONCE, body, 16)!;
    body = decodePadding(nonce.rest)!;
    return { payload: { type: 'padding', nonce: nonce.value }, senderIdentity: sender.vid };
  }

  throw new DecodeError('UnexpectedMsgType');
}

export function buildEnvelopeBytes(envelope: Envelope<Uint8Array>, inner: number[]): Uint8Array {
  const stream: number[] = [...inner];
  finalizeEnvelopeFrame(stream);
  return bytesFromNumberStream(stream);
}