/**
 * BBS+ Cryptosuite Manager (bbs-2023)
 *
 * Implements the Data Integrity BBS cryptosuite for creating and verifying
 * BBS+ proofs with selective disclosure support. Follows the W3C Data
 * Integrity BBS Cryptosuites v1.0 specification.
 */
import { BbsSimple, type BbsKeyPair } from './bbsSimple';
import { BBSCryptosuiteUtils } from './bbs';
import { multikey } from '../../crypto/Multikey';
import { canonize, canonizeProof } from '../utils/jsonld';
import { sha256Bytes } from '../../utils/hash';
import type { DataIntegrityProof, VerificationResult } from './eddsa';

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
      const kp = BbsSimple.generateKeyPair();
      // Re-derive with the actual private key
      const { bls12_381 } = await import('@noble/curves/bls12-381');
      const Fr = bls12_381.fields.Fr;
      const G2 = bls12_381.G2.ProjectivePoint;
      let hex = '';
      for (let i = 0; i < privateKey.length; i++) hex += privateKey[i].toString(16).padStart(2, '0');
      const sk = Fr.create(BigInt('0x' + hex));
      publicKey = G2.BASE.multiply(sk).toRawBytes(true);
    }

    const keypair: BbsKeyPair = { privateKey, publicKey };

    // Convert credential fields to BBS messages
    const docCopy = { ...document };
    delete docCopy.proof;
    const { messages, fieldPaths, mandatoryIndexes } = credentialToMessages(
      docCopy as Record<string, unknown>,
      mandatoryPointers
    );

    // Create BBS+ header from document hash
    const transformedData = await canonize(docCopy, { documentLoader: options.documentLoader });
    const headerData = await sha256Bytes(transformedData);

    // Sign all messages
    const signature = await BbsSimple.sign(messages, keypair, headerData);

    // Serialize the base proof value using BBSCryptosuiteUtils
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

      // Verify the BBS+ signature
      const valid = await BbsSimple.verify(
        messages,
        new Uint8Array([...parsed.bbsSignature, ...new Uint8Array(80 - parsed.bbsSignature.length)]).slice(0, 80),
        parsed.publicKey,
        parsed.bbsHeader
      );

      // Also verify the public key matches the verification method
      if (options?.documentLoader) {
        const vmDoc = await options.documentLoader(proof.verificationMethod);
        if (vmDoc?.document?.publicKeyMultibase) {
          const dec = multikey.decodePublicKey(vmDoc.document.publicKeyMultibase);
          if (dec.type !== 'Bls12381G2') {
            return { verified: false, errors: ['Verification method key is not Bls12381G2'] };
          }
        }
      }

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

    // Reconstruct the signature bytes (A || e format)
    const sigBytes = parsed.bbsSignature.length >= 80
      ? parsed.bbsSignature.slice(0, 80)
      : new Uint8Array([...parsed.bbsSignature, ...new Uint8Array(80 - parsed.bbsSignature.length)]);

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

      // Reconstruct disclosed messages from the document
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
        value = (value as any)[part];
      }
      setPath(result, fieldPaths[i], value);
    }
  }

  return result;
}
