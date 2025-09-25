import { base64url } from 'multiformats/bases/base64';
import * as cbor from 'cbor-js';

/**
 * Minimal BBS utility methods ported from legacy for working with
 * Data Integrity BBS (bbs-2023) base and derived proof value encoding.
 *
 * Notes:
 * - This module focuses on serialization/parsing helpers used by callers
 *   to pack/unpack proof values. It does not perform signing or verification.
 * - All methods operate on Uint8Array inputs and return multibase strings
 *   (base64url with 'u' prefix) where applicable to match the spec.
 */
export class BBSCryptosuiteUtils {
  private static compareBytes(a: Uint8Array, b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private static concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // ===== Base proof (serialize/parse) =====

  static serializeBaseProofValue(
    bbsSignature: Uint8Array,
    bbsHeader: Uint8Array,
    publicKey: Uint8Array,
    hmacKey: Uint8Array,
    mandatoryPointers: string[],
    featureOption: 'baseline' | 'anonymous_holder_binding' | 'pseudonym_issuer_pid' | 'pseudonym_hidden_pid',
    pid?: Uint8Array,
    signerBlind?: Uint8Array
  ): string {
    let headerBytes: Uint8Array;
    let components: (Uint8Array | string[] | Uint8Array)[];

    switch (featureOption) {
      case 'baseline':
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x02]);
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers as unknown as Uint8Array];
        break;
      case 'anonymous_holder_binding':
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x04]);
        if (!signerBlind) throw new Error('signerBlind is required for anonymous_holder_binding');
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers as unknown as Uint8Array, signerBlind];
        break;
      case 'pseudonym_issuer_pid':
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x06]);
        if (!pid) throw new Error('pid is required for pseudonym_issuer_pid');
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers as unknown as Uint8Array, pid];
        break;
      case 'pseudonym_hidden_pid':
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x08]);
        if (!signerBlind) throw new Error('signerBlind is required for pseudonym_hidden_pid');
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers as unknown as Uint8Array, signerBlind];
        break;
      default:
        throw new Error(`Unsupported feature option: ${featureOption}`);
    }

    const encodedComponents = cbor.encode(components);
    const proofBytes = BBSCryptosuiteUtils.concatBytes(headerBytes, new Uint8Array(encodedComponents));
    return base64url.encode(proofBytes);
  }

  static parseBaseProofValue(proofValue: string): {
    bbsSignature: Uint8Array;
    bbsHeader: Uint8Array;
    publicKey: Uint8Array;
    hmacKey: Uint8Array;
    mandatoryPointers: string[];
    featureOption: 'baseline' | 'anonymous_holder_binding' | 'pseudonym_issuer_pid' | 'pseudonym_hidden_pid' | 'base_proof';
    pid?: Uint8Array;
    signerBlind?: Uint8Array;
  } {
    if (!proofValue.startsWith('u')) {
      throw new Error('Proof value must be multibase base64url (u-prefixed)');
    }
    const decoded = base64url.decode(proofValue);
    const header = decoded.slice(0, 3);
    let featureOption: any;
    if (this.compareBytes(header, [0xd9, 0x5d, 0x02])) featureOption = 'baseline';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x04])) featureOption = 'anonymous_holder_binding';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x06])) featureOption = 'pseudonym_issuer_pid';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x08])) featureOption = 'pseudonym_hidden_pid';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x03])) featureOption = 'base_proof';
    else throw new Error('Invalid BBS base proof header');

    const components: any[] = cbor.decode(decoded.slice(3).buffer) as any[];
    const base = {
      bbsSignature: components[0] as Uint8Array,
      bbsHeader: components[1] as Uint8Array,
      publicKey: components[2] as Uint8Array,
      hmacKey: components[3] as Uint8Array,
      mandatoryPointers: components[4] as string[],
      featureOption
    } as any;

    if (featureOption === 'anonymous_holder_binding' || featureOption === 'pseudonym_hidden_pid') {
      base.signerBlind = components[5] as Uint8Array;
    }
    if (featureOption === 'pseudonym_issuer_pid') {
      base.pid = components[5] as Uint8Array;
    }
    return base;
  }

  // ===== Label map compression helpers =====

  private static compressLabelMap(labelMap: { [key: string]: string }): { [key: string]: string } {
    const map: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(labelMap)) {
      const c14nMatch = k.match(/^c14n(\d+)$/);
      const bMatch = v.match(/^b(\d+)$/);
      if (!c14nMatch || !bMatch) {
        throw new Error(`Invalid label map entry: ${k} -> ${v}`);
      }
      const key = parseInt(c14nMatch[1], 10);
      const value = parseInt(bMatch[1], 10);
      map[key] = value.toString();
    }
    return map;
  }

  private static decompressLabelMap(compressed: { [key: string]: string }): { [key: string]: string } {
    const map: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(compressed)) {
      map[`c14n${k}`] = `b${v}`;
    }
    return map;
  }

  // ===== Derived proof (serialize/parse) =====

  static serializeDerivedProofValue(
    bbsProof: Uint8Array,
    labelMap: { [key: string]: string },
    mandatoryIndexes: number[],
    selectiveIndexes: number[],
    presentationHeader: Uint8Array,
    featureOption: 'baseline' | 'anonymous_holder_binding' | 'pseudonym',
    pseudonym?: string,
    lengthBBSMessages?: number
  ): string {
    const compressedLabelMap = this.compressLabelMap(labelMap);

    let headerBytes: Uint8Array;
    let components: (Uint8Array | { [key: string]: string } | number[] | number | string)[];

    switch (featureOption) {
      case 'baseline':
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x03]);
        components = [
          bbsProof,
          compressedLabelMap,
          mandatoryIndexes,
          selectiveIndexes,
          presentationHeader
        ];
        break;
      case 'anonymous_holder_binding':
        if (typeof lengthBBSMessages !== 'number') {
          throw new Error('lengthBBSMessages is required for anonymous_holder_binding');
        }
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x05]);
        components = [
          bbsProof,
          compressedLabelMap,
          mandatoryIndexes,
          selectiveIndexes,
          presentationHeader,
          lengthBBSMessages
        ];
        break;
      case 'pseudonym':
        if (!pseudonym || typeof lengthBBSMessages !== 'number') {
          throw new Error('pseudonym and lengthBBSMessages are required for pseudonym features');
        }
        headerBytes = new Uint8Array([0xd9, 0x5d, 0x07]);
        components = [
          bbsProof,
          compressedLabelMap,
          mandatoryIndexes,
          selectiveIndexes,
          presentationHeader,
          pseudonym,
          lengthBBSMessages
        ];
        break;
      default:
        throw new Error(`Unsupported feature option: ${featureOption}`);
    }

    const encodedComponents = cbor.encode(components);
    const proofBytes = this.concatBytes(headerBytes, new Uint8Array(encodedComponents));
    return base64url.encode(proofBytes);
  }

  static parseDerivedProofValue(proofValue: string): {
    bbsProof: Uint8Array;
    labelMap: { [key: string]: string };
    mandatoryIndexes: number[];
    selectiveIndexes: number[];
    presentationHeader: Uint8Array;
    featureOption: 'baseline' | 'anonymous_holder_binding' | 'pseudonym';
    pseudonym?: string;
    lengthBBSMessages?: number;
  } {
    if (!proofValue.startsWith('u')) {
      throw new Error('Proof value must be multibase base64url (u-prefixed)');
    }
    const decoded = base64url.decode(proofValue);
    const header = decoded.slice(0, 3);
    let featureOption: 'baseline' | 'anonymous_holder_binding' | 'pseudonym';
    if (this.compareBytes(header, [0xd9, 0x5d, 0x03])) featureOption = 'baseline';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x05])) featureOption = 'anonymous_holder_binding';
    else if (this.compareBytes(header, [0xd9, 0x5d, 0x07])) featureOption = 'pseudonym';
    else throw new Error('Invalid BBS derived proof header');

    const components: any[] = cbor.decode(decoded.slice(3).buffer) as any[];
    const decompressedLabelMap = this.decompressLabelMap(components[1]);
    const result: any = {
      bbsProof: components[0],
      labelMap: decompressedLabelMap,
      mandatoryIndexes: components[2],
      selectiveIndexes: components[3],
      presentationHeader: components[4],
      featureOption
    };
    if (featureOption === 'anonymous_holder_binding') {
      result.lengthBBSMessages = components[5];
    } else if (featureOption === 'pseudonym') {
      result.pseudonym = components[5];
      result.lengthBBSMessages = components[6];
    }
    return result;
  }
}

