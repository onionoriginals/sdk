/**
 * BBS+ Cryptosuite Manager (bbs-2023)
 *
 * EXPERIMENTAL — NOT A SHIPPING FEATURE.
 *
 * Scaffolding for the Data Integrity BBS cryptosuite (selective disclosure)
 * following the W3C Data Integrity BBS Cryptosuites v1.0 specification. The
 * underlying BBS+ primitives (BbsSimple) are unimplemented and THROW on every
 * call, so no BBS+ proof can currently be created, derived, or verified —
 * every code path here fails loudly. Do not present bbs-2023 as a supported
 * cryptosuite to SDK consumers until BbsSimple is implemented and the
 * SECURITY TODOs in this file are resolved.
 */
import { BbsSimple, type BbsKeyPair } from './bbsSimple.js';
import { BBSCryptosuiteUtils } from './bbs.js';
import { multikey } from '../../crypto/Multikey.js';
import { canonize } from '../utils/jsonld.js';
import { sha256Bytes } from '../../utils/hash.js';
import type { DataIntegrityProof, VerificationResult } from './eddsa.js';

export interface BBSProofOptions {
  verificationMethod: string;
  proofPurpose?: string;
  privateKey?: Uint8Array | string;
  publicKey?: Uint8Array | string;
  documentLoader?: (url: string) => Promise<any>;
  mandatoryPointers?: string[];
  challenge?: string;
  domain?: string;
}

export interface BBSDeriveOptions {
  documentLoader?: (url: string) => Promise<any>;
  presentationHeader?: Uint8Array;
  selectivePointers: string[];
}

/**
 * Convert a JSON-LD credential into ordered messages for BBS+ signing.
 * Each field path becomes a separate message to enable selective disclosure.
 */
function credentialToMessages(credential: Record<string, unknown>, mandatoryPointers: string[]): {
  messages: Uint8Array[];
  fieldPaths: string[];
  mandatoryIndexes: number[];
  selectiveIndexes: number[];
} {
  const encoder = new TextEncoder();
  const fieldPaths: string[] = [];
  const messages: Uint8Array[] = [];

  function extractFields(obj: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(obj)) {
      const path = `${prefix}/${key}`;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        extractFields(value as Record<string, unknown>, path);
      } else {
        fieldPaths.push(path);
        messages.push(encoder.encode(`${path}=${JSON.stringify(value)}`));
      }
    }
  }

  extractFields(credential, '');

  const mandatorySet = new Set(mandatoryPointers);
  const mandatoryIndexes: number[] = [];
  const selectiveIndexes: number[] = [];

  for (let i = 0; i < fieldPaths.length; i++) {
    if (mandatorySet.has(fieldPaths[i])) {
      mandatoryIndexes.push(i);
    } else {
      selectiveIndexes.push(i);
    }
  }

  return { messages, fieldPaths, mandatoryIndexes, selectiveIndexes };
}

/**
 * Exact length of a BLS12-381-SHA-256 BBS signature: a 48-byte compressed G1
 * point (A) followed by a 32-byte scalar (e).
 */
const BBS_SIGNATURE_LENGTH = 80;

/** Constant-time-ish byte comparison for public key matching. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class BBSCryptosuiteManager {

  /**
   * Create a BBS+ Data Integrity proof on a document.
   *
   * Signs all credential fields as separate BBS+ messages, enabling
   * later selective disclosure via deriveProof().
   */
  static async createProof(document: any, options: BBSProofOptions): Promise<DataIntegrityProof> {
    const mandatoryPointers = options.mandatoryPointers || ['/issuer', '/issuanceDate', '/@context'];

    // Resolve private key
    let privateKey: Uint8Array;
    if (typeof options.privateKey === 'string') {
      const dec = multikey.decodePrivateKey(options.privateKey);
      if (dec.type !== 'Bls12381G2') throw new Error('BBS+ requires Bls12381G2 key type');
      privateKey = dec.key;
    } else if (options.privateKey instanceof Uint8Array) {
      privateKey = options.privateKey;
    } else {
      throw new Error('Private key required for BBS+ proof creation');
    }

    // Resolve public key
    let publicKey: Uint8Array;
    if (typeof options.publicKey === 'string') {
      const dec = multikey.decodePublicKey(options.publicKey);
      if (dec.type !== 'Bls12381G2') throw new Error('BBS+ requires Bls12381G2 key type');
      publicKey = dec.key;
    } else if (options.publicKey instanceof Uint8Array) {
      publicKey = options.publicKey;
    } else {
      // Derive public key from private key
      BbsSimple.generateKeyPair();
      // Re-derive with the actual private key
      const { bls12_381 } = await import('@noble/curves/bls12-381.js');
      const Fr = bls12_381.fields.Fr;
      const G2 = bls12_381.G2.Point;
      let hex = '';
      for (let i = 0; i < privateKey.length; i++) hex += privateKey[i].toString(16).padStart(2, '0');
      const sk = Fr.create(BigInt('0x' + hex));
      publicKey = G2.BASE.multiply(sk).toBytes(true);
    }

    const keypair: BbsKeyPair = { privateKey, publicKey };

    // Convert credential fields to BBS messages
    const docCopy = { ...document };
    delete docCopy.proof;
    const { messages } = credentialToMessages(
      docCopy as Record<string, unknown>,
      mandatoryPointers
    );

    // Create BBS+ header from document hash
    const transformedData = await canonize(docCopy, { documentLoader: options.documentLoader });
    const headerData = await sha256Bytes(transformedData);

    // Sign all messages
    const signature = await BbsSimple.sign(messages, keypair, headerData);

    // Serialize the base proof value using BBSCryptosuiteUtils
    //
    // SECURITY TODO (must fix before enabling BBS+): this "hmacKey" is
    // derived from the canonicalized document hash — a DETERMINISTIC, PUBLIC
    // value, not a secret. Per the bbs-2023 spec the HMAC key must be a
    // fresh cryptographically random secret used to shuffle blank-node
    // labels; a public/predictable key defeats the unlinkability that BBS+
    // selective disclosure is supposed to provide. Inert today only because
    // BbsSimple.sign above always throws before this line is reached.
    const hmacKey = headerData.slice(0, 32);
    const proofValue = BBSCryptosuiteUtils.serializeBaseProofValue(
      signature,
      headerData,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'baseline'
    );

    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      created: new Date().toISOString(),
      verificationMethod: options.verificationMethod,
      proofPurpose: options.proofPurpose || 'assertionMethod',
      proofValue,
      ...(options.challenge && { challenge: options.challenge }),
      ...(options.domain && { domain: options.domain })
    };
  }

  /**
   * Verify a BBS+ Data Integrity proof.
   */
  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    try {
      if (proof.cryptosuite !== 'bbs-2023') {
        return { verified: false, errors: [`Expected bbs-2023 cryptosuite, got ${proof.cryptosuite}`] };
      }

      // Parse the base proof
      const parsed = BBSCryptosuiteUtils.parseBaseProofValue(proof.proofValue);

      // Reconstruct the document messages
      const docCopy = { ...document };
      delete docCopy.proof;
      const { messages } = credentialToMessages(
        docCopy as Record<string, unknown>,
        parsed.mandatoryPointers
      );

      // Resolve the public key from the DID document. The verification key MUST
      // come from the resolved verification method, never from the proof itself
      // (which is attacker-controlled). Mirrors EdDSACryptosuiteManager.
      if (!options?.documentLoader) {
        return { verified: false, errors: ['documentLoader is required to resolve the verification method public key'] };
      }
      const vmDoc = await options.documentLoader(proof.verificationMethod);
      const publicKeyMultibase = vmDoc?.document?.publicKeyMultibase;
      if (!publicKeyMultibase) {
        return { verified: false, errors: ['Verification method does not contain a publicKeyMultibase'] };
      }
      const dec = multikey.decodePublicKey(publicKeyMultibase);
      if (dec.type !== 'Bls12381G2') {
        return { verified: false, errors: ['Verification method key is not Bls12381G2'] };
      }

      // The proof-embedded public key (if present) MUST match the DID-document
      // key byte-for-byte. Reject key substitution before any signature check.
      if (parsed.publicKey && !bytesEqual(parsed.publicKey, dec.key)) {
        return { verified: false, errors: ['Proof public key does not match verification method'] };
      }

      // A BLS12-381-SHA-256 BBS signature is exactly 80 bytes (A: 48-byte G1
      // point || e: 32-byte scalar). Anything else is malformed and must be
      // REJECTED — never zero-padded or truncated into a "plausible" 80-byte
      // value, which would hand attacker-controlled bytes to the verifier.
      if (parsed.bbsSignature.length !== BBS_SIGNATURE_LENGTH) {
        return {
          verified: false,
          errors: [`Invalid BBS+ signature length: expected ${BBS_SIGNATURE_LENGTH} bytes, got ${parsed.bbsSignature.length}`]
        };
      }

      // Verify the BBS+ signature against the DID-document public key.
      const valid = await BbsSimple.verify(
        messages,
        parsed.bbsSignature,
        dec.key,
        parsed.bbsHeader
      );

      return valid
        ? { verified: true }
        : { verified: false, errors: ['BBS+ signature verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown BBS+ verification error'] };
    }
  }

  /**
   * Derive a selective disclosure proof from a BBS+ base proof.
   *
   * Creates a new proof that only reveals the specified fields while
   * cryptographically proving the hidden fields exist in the original credential.
   */
  static async deriveProof(
    document: any,
    proof: DataIntegrityProof,
    options: BBSDeriveOptions
  ): Promise<{ document: any; proof: DataIntegrityProof }> {
    if (proof.cryptosuite !== 'bbs-2023') {
      throw new Error(`Cannot derive from cryptosuite: ${proof.cryptosuite}`);
    }

    const parsed = BBSCryptosuiteUtils.parseBaseProofValue(proof.proofValue);
    const presentationHeader = options.presentationHeader || new Uint8Array(0);

    // Reconstruct messages from document
    const docCopy = { ...document };
    delete docCopy.proof;
    const { messages, fieldPaths } = credentialToMessages(
      docCopy as Record<string, unknown>,
      parsed.mandatoryPointers
    );

    // Determine which indexes to disclose
    const selectiveSet = new Set(options.selectivePointers);
    const mandatorySet = new Set(parsed.mandatoryPointers);
    const disclosedIndexes: number[] = [];
    const disclosedMessages: Uint8Array[] = [];

    for (let i = 0; i < fieldPaths.length; i++) {
      if (mandatorySet.has(fieldPaths[i]) || selectiveSet.has(fieldPaths[i])) {
        disclosedIndexes.push(i);
        disclosedMessages.push(messages[i]);
      }
    }

    // The base proof's signature bytes (A || e format) must be exactly 80
    // bytes. Reject malformed lengths instead of padding/truncating — a
    // zero-padded signature is attacker-influenceable garbage, not a
    // recoverable input.
    if (parsed.bbsSignature.length !== BBS_SIGNATURE_LENGTH) {
      throw new Error(`Invalid BBS+ signature length: expected ${BBS_SIGNATURE_LENGTH} bytes, got ${parsed.bbsSignature.length}`);
    }
    const sigBytes = parsed.bbsSignature;

    // Generate the BBS+ selective disclosure proof
    const bbsProof = await BbsSimple.createProof({
      publicKey: parsed.publicKey,
      signature: sigBytes,
      header: parsed.bbsHeader,
      presentationHeader,
      messages,
      disclosedIndexes,
    });

    // Build label map (canonical to blank node mapping)
    const labelMap: { [key: string]: string } = {};
    for (let i = 0; i < fieldPaths.length; i++) {
      labelMap[`c14n${i}`] = `b${i}`;
    }

    // Determine mandatory and selective index arrays
    const mandatoryIndexes = disclosedIndexes.filter(i => mandatorySet.has(fieldPaths[i]));
    const selectiveIndexes = disclosedIndexes.filter(i => selectiveSet.has(fieldPaths[i]));

    // Serialize derived proof
    const derivedProofValue = BBSCryptosuiteUtils.serializeDerivedProofValue(
      bbsProof,
      labelMap,
      mandatoryIndexes,
      selectiveIndexes,
      presentationHeader,
      'baseline'
    );

    // Build disclosed document (only disclosed fields)
    const disclosedDoc = buildDisclosedDocument(docCopy, fieldPaths, disclosedIndexes);

    const derivedProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      created: proof.created,
      verificationMethod: proof.verificationMethod,
      proofPurpose: proof.proofPurpose,
      proofValue: derivedProofValue,
    };

    return { document: disclosedDoc, proof: derivedProof };
  }

  /**
   * Verify a derived (selective disclosure) proof.
   */
  static async verifyDerivedProof(
    document: any,
    proof: DataIntegrityProof,
    options: {
      publicKey: Uint8Array;
      header: Uint8Array;
      presentationHeader?: Uint8Array;
      totalMessageCount: number;
      documentLoader?: (url: string) => Promise<any>;
    }
  ): Promise<VerificationResult> {
    try {
      const parsed = BBSCryptosuiteUtils.parseDerivedProofValue(proof.proofValue);
      const presentationHeader = options.presentationHeader || new Uint8Array(0);

      // Reconstruct disclosed messages from the document. The disclosed
      // document is built by buildDisclosedDocument, which inserts fields in
      // original-credential enumeration order, so enumerating it yields the
      // disclosed messages in ascending original-index order — the same order
      // deriveProof paired them with disclosedIndexes.
      const docCopy = { ...document };
      delete docCopy.proof;
      const { messages: disclosedMessages } = credentialToMessages(
        docCopy as Record<string, unknown>,
        []
      );

      const allDisclosedIndexes = [
        ...parsed.mandatoryIndexes,
        ...parsed.selectiveIndexes,
      ].sort((a, b) => a - b);

      // Positional pairing of message k with allDisclosedIndexes[k] is only
      // meaningful when the counts agree. A disclosed document with extra or
      // missing fields would silently shift every message onto the wrong
      // index, so fail closed instead.
      if (disclosedMessages.length !== allDisclosedIndexes.length) {
        return {
          verified: false,
          errors: [
            `Disclosed document has ${disclosedMessages.length} field(s) but the derived proof discloses ${allDisclosedIndexes.length} index(es)`
          ]
        };
      }

      const valid = await BbsSimple.verifyProof({
        publicKey: options.publicKey,
        proof: parsed.bbsProof,
        header: options.header,
        presentationHeader,
        disclosedMessages,
        disclosedIndexes: allDisclosedIndexes,
        totalMessageCount: options.totalMessageCount,
      });

      return valid
        ? { verified: true }
        : { verified: false, errors: ['BBS+ derived proof verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown BBS+ verification error'] };
    }
  }
}

/**
 * Build a document containing only the disclosed fields.
 */
function buildDisclosedDocument(
  original: Record<string, unknown>,
  fieldPaths: string[],
  disclosedIndexes: number[]
): Record<string, unknown> {
  const disclosedSet = new Set(disclosedIndexes.map(i => fieldPaths[i]));
  const result: Record<string, unknown> = {};

  function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
    const parts = path.slice(1).split('/'); // remove leading /
    let current: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  for (let i = 0; i < fieldPaths.length; i++) {
    if (disclosedSet.has(fieldPaths[i])) {
      // Get the value from original document
      const parts = fieldPaths[i].slice(1).split('/');
      let value: any = original;
      for (const part of parts) {
        if (value === undefined || value === null) break;
        value = (value)[part];
      }
      setPath(result, fieldPaths[i], value);
    }
  }

  return result;
}
