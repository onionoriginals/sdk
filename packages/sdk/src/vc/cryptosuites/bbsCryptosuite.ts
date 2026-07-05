/**
 * BBS+ Cryptosuite Manager (bbs-2023)
 *
 * Implements the W3C Data Integrity BBS Cryptosuites v1.0 specification for
 * creating, verifying, and selectively disclosing BBS+ proofs. Ported from
 * aviarytech/di-wings (src/lib/vcs/v2/cryptosuites/bbs.ts) and adapted to the
 * Originals SDK's `canonize`/`multikey`/`DataIntegrityProof` types and the real
 * `@digitalbazaar/bbs-signatures` BLS12-381 backend.
 *
 * Only the "baseline" feature option is supported (no anonymous holder binding
 * or pseudonyms), matching the di-wings reference's supported surface.
 */
import * as bbs from '@digitalbazaar/bbs-signatures';
import jsonld from 'jsonld';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { BBSCryptosuiteUtils } from './bbs.js';
import { multikey } from '../../crypto/Multikey.js';
import { canonize } from '../utils/jsonld.js';
import type { DataIntegrityProof, VerificationResult } from './eddsa.js';
import {
  canonicalizeAndGroup,
  createHmac,
  createLabelMapFunction,
  createShuffledIdLabelMapFunction,
  hashMandatoryNQuads,
  labelReplacementCanonicalizeJsonLd,
  selectJsonLd,
  stripBlankNodePrefixes
} from '../utils/selective-disclosure.js';

const CIPHERSUITE = 'BLS12-381-SHA-256';

/** SHA-256 over a string or bytes (@noble v2 requires Uint8Array input). */
const sha256Of = (input: string | Uint8Array): Uint8Array =>
  sha256(typeof input === 'string' ? new TextEncoder().encode(input) : input);

export interface BBSProofOptions {
  verificationMethod: string;
  proofPurpose?: string;
  privateKey?: Uint8Array | string;
  publicKey?: Uint8Array | string;
  documentLoader?: (url: string) => Promise<any>;
  mandatoryPointers?: string[];
  challenge?: string;
  domain?: string;
  created?: string;
}

export interface BBSDeriveOptions {
  documentLoader?: (url: string) => Promise<any>;
  presentationHeader?: Uint8Array;
  selectivePointers: string[];
}

export interface BBSVerifyOptions {
  documentLoader?: (url: string) => Promise<any>;
  /**
   * DID expected to control the proof's verification method. When omitted,
   * the binding is checked against the document's `issuer` (credentials) or
   * `holder` (presentations); verification fails closed if neither is present.
   */
  expectedController?: string;
  /** When set, the proof's challenge must match exactly (anti-replay). */
  expectedChallenge?: string;
  /** When set, the proof's domain must match exactly. */
  expectedDomain?: string;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Constant-time-ish byte comparison for public key matching. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toUint8(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value as any);
}

/** Resolve a multibase-encoded or raw Bls12381G2 key to raw bytes. */
function resolveKey(key: Uint8Array | string | undefined, isPrivate: boolean): Uint8Array | undefined {
  if (key === undefined) return undefined;
  if (key instanceof Uint8Array) return key;
  const dec = isPrivate ? multikey.decodePrivateKey(key) : multikey.decodePublicKey(key);
  if (dec.type !== 'Bls12381G2') throw new Error('BBS+ requires Bls12381G2 key type');
  return dec.key;
}

/** Multibase base64url-no-pad decode (the 'u' prefix used by proof values). */
function decodeMultibaseB64url(s: string): Uint8Array {
  if (!s || s[0] !== 'u') throw new Error('Proof value must be multibase-base64url-no-pad-encoded (start with "u")');
  const raw = s.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 === 2 ? '==' : raw.length % 4 === 3 ? '=' : '';
  return new Uint8Array(Buffer.from(raw + pad, 'base64'));
}

export class BBSCryptosuiteManager {
  /**
   * 3.4.4 — generate a canonical proof configuration from proof options.
   */
  private static async baseProofConfiguration(
    options: BBSProofOptions & { type: string; cryptosuite: string; created: string },
    context: unknown
  ): Promise<string> {
    const proofConfig: Record<string, unknown> = {
      '@context': context,
      type: options.type,
      cryptosuite: options.cryptosuite,
      created: options.created,
      verificationMethod: options.verificationMethod,
      proofPurpose: options.proofPurpose || 'assertionMethod'
    };
    if (options.challenge) proofConfig.challenge = options.challenge;
    if (options.domain) proofConfig.domain = options.domain;
    return await canonize(proofConfig, { documentLoader: options.documentLoader });
  }

  /**
   * 3.4.2 — transform an unsecured document into mandatory / non-mandatory
   * N-Quad groups using an HMAC-shuffled blank-node label map.
   */
  private static async baseProofTransformation(
    unsecuredDocument: any,
    options: { mandatoryPointers: string[]; hmacKey: Uint8Array; documentLoader?: (url: string) => Promise<any> }
  ): Promise<{ mandatory: string[]; nonMandatory: string[] }> {
    const hmacFn = createHmac(options.hmacKey);
    const labelMapFactoryFunction = createShuffledIdLabelMapFunction(hmacFn);
    const { groups } = await canonicalizeAndGroup(
      unsecuredDocument,
      labelMapFactoryFunction,
      { mandatory: options.mandatoryPointers },
      { documentLoader: options.documentLoader! }
    );
    const mandatory = Array.from(groups.get('mandatory')!.matching.values());
    const nonMandatory = Array.from(groups.get('mandatory')!.nonMatching.values());
    return { mandatory, nonMandatory };
  }

  /**
   * 3.4.1 — create a BBS base proof for an unsecured document. Signs every
   * non-mandatory statement individually so a holder can later selectively
   * disclose them via {@link deriveProof}.
   */
  static async createProof(document: any, options: BBSProofOptions): Promise<DataIntegrityProof> {
    const mandatoryPointers = options.mandatoryPointers || [];

    const privateKey = resolveKey(options.privateKey, true);
    if (!privateKey) throw new Error('Private key required for BBS+ proof creation');
    let publicKey = resolveKey(options.publicKey, false);
    if (!publicKey) {
      publicKey = toUint8(await bbs.secretKeyToPublicKey({ secretKey: privateKey, ciphersuite: CIPHERSUITE }));
    }

    const created = options.created || new Date().toISOString();
    const docCopy = { ...document };
    delete docCopy.proof;

    // proofHash over the canonicalized proof configuration
    const canonicalProofConfig = await BBSCryptosuiteManager.baseProofConfiguration(
      { ...options, type: 'DataIntegrityProof', cryptosuite: 'bbs-2023', created },
      docCopy['@context']
    );
    const proofHash = sha256Of(canonicalProofConfig);

    // transform + mandatoryHash
    const hmacKey = randomBytes(32);
    const { mandatory, nonMandatory } = await BBSCryptosuiteManager.baseProofTransformation(docCopy, {
      mandatoryPointers,
      hmacKey,
      documentLoader: options.documentLoader
    });
    const mandatoryHash = hashMandatoryNQuads(mandatory, sha256Of);

    // bbsHeader = proofHash || mandatoryHash; messages = non-mandatory statements
    const bbsHeader = concatBytes(proofHash, mandatoryHash);
    const bbsMessages = nonMandatory.map(nq => new TextEncoder().encode(nq));

    const bbsSignature = toUint8(await bbs.sign({
      ciphersuite: CIPHERSUITE,
      secretKey: privateKey,
      publicKey,
      header: bbsHeader,
      messages: bbsMessages
    }));

    const proofValue = BBSCryptosuiteUtils.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      publicKey,
      hmacKey,
      mandatoryPointers,
      'baseline'
    );

    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      created,
      verificationMethod: options.verificationMethod,
      proofPurpose: options.proofPurpose || 'assertionMethod',
      proofValue,
      ...(options.challenge && { challenge: options.challenge }),
      ...(options.domain && { domain: options.domain })
    };
  }

  /**
   * 3.3.3 — produce the disclosure data (BBS proof + label map + indexes +
   * reveal document) used to build a derived selective-disclosure proof.
   */
  private static async createDisclosureData(
    document: any,
    proof: DataIntegrityProof,
    selectivePointers: string[],
    options: { documentLoader?: (url: string) => Promise<any> },
    presentationHeader: Uint8Array
  ): Promise<{
    bbsProof: Uint8Array;
    labelMap: { [key: string]: string };
    mandatoryIndexes: number[];
    selectiveIndexes: number[];
    revealDocument: any;
  }> {
    const parsed = BBSCryptosuiteUtils.parseBaseProofValue(proof.proofValue);
    const hmacFn = createHmac(parsed.hmacKey);
    const labelMapFactoryFunction = createShuffledIdLabelMapFunction(hmacFn);

    const combinedPointers = [...parsed.mandatoryPointers, ...selectivePointers];
    // With no mandatory and no selective pointers, selectJsonLd() returns null
    // and the revealed document would drop its @context, yielding a proof whose
    // recomputed proofHash can never match. Fail loudly instead.
    if (combinedPointers.length === 0) {
      throw new Error('BBS+ derive requires at least one mandatory or selective pointer');
    }
    const groupDefinitions = {
      mandatory: parsed.mandatoryPointers,
      selective: selectivePointers,
      combined: combinedPointers
    };

    const { proof: _docProof, ...restDocument } = document;
    const { groups, labelMap } = await canonicalizeAndGroup(
      restDocument,
      labelMapFactoryFunction,
      groupDefinitions,
      { documentLoader: options.documentLoader! }
    );

    const selectiveMatch = groups.get('selective')!.matching;
    const combinedMatch = groups.get('combined')!.matching;
    const mandatoryMatch = groups.get('mandatory')!.matching;
    const mandatoryNonMatch = groups.get('mandatory')!.nonMatching;
    const combinedIndexes = Array.from(combinedMatch.keys());
    const nonMandatoryIndexes = Array.from(mandatoryNonMatch.keys());

    // mandatory indexes relative to the combined (revealed) group
    const mandatoryIndexes: number[] = [];
    for (const key of mandatoryMatch.keys()) {
      const relativeIndex = combinedIndexes.indexOf(key);
      if (relativeIndex !== -1) mandatoryIndexes.push(relativeIndex);
    }

    // selective indexes relative to the non-mandatory (BBS message) group
    const selectiveIndexes: number[] = [];
    for (const absoluteIndex of mandatoryNonMatch.keys()) {
      if (selectiveMatch.has(absoluteIndex)) {
        selectiveIndexes.push(nonMandatoryIndexes.indexOf(absoluteIndex));
      }
    }

    const bbsMessages = [...mandatoryNonMatch.values()].map(str => new TextEncoder().encode(str));

    const parsedBaseProof = BBSCryptosuiteUtils.parseBaseProofValue(proof.proofValue);
    const bbsProof = toUint8(await bbs.deriveProof({
      ciphersuite: CIPHERSUITE,
      publicKey: parsedBaseProof.publicKey,
      signature: parsedBaseProof.bbsSignature,
      header: parsedBaseProof.bbsHeader,
      presentationHeader,
      messages: bbsMessages,
      disclosedMessageIndexes: selectiveIndexes
    }));

    const revealDocument = selectJsonLd(combinedPointers, document);

    // Map the verifier's canonical bnode ids onto the holder's shuffled labels.
    // N-Quads input: canonicalize directly (the SDK `canonize` only accepts
    // JSON-LD input, so call jsonld with an explicit inputFormat here).
    const canonicalIdMap = new Map<string, string>();
    await jsonld.canonize(groups.get('combined')!.deskolemizedNQuads.join(''), {
      documentLoader: options.documentLoader,
      algorithm: 'URDNA2015',
      inputFormat: 'application/n-quads',
      format: 'application/n-quads',
      safe: true,
      canonicalIdMap
    } as any);
    const strippedIdMap = stripBlankNodePrefixes(canonicalIdMap);

    const verifierLabelMap = new Map<string, string>();
    for (const [inputLabel, verifierLabel] of strippedIdMap) {
      verifierLabelMap.set(verifierLabel, labelMap.get(inputLabel)!);
    }

    return {
      bbsProof,
      labelMap: Object.fromEntries(verifierLabelMap.entries()),
      mandatoryIndexes,
      selectiveIndexes,
      revealDocument
    };
  }

  /**
   * 3.4.6 — derive a selective-disclosure proof from a BBS base proof. Returns
   * the revealed document (without proof) and the new derived proof.
   */
  static async deriveProof(
    document: any,
    proof: DataIntegrityProof,
    options: BBSDeriveOptions
  ): Promise<{ document: any; proof: DataIntegrityProof }> {
    if (proof.cryptosuite !== 'bbs-2023') {
      throw new Error(`Cannot derive from cryptosuite: ${proof.cryptosuite}`);
    }
    const presentationHeader = options.presentationHeader || new Uint8Array(0);
    const disclosure = await BBSCryptosuiteManager.createDisclosureData(
      document,
      proof,
      options.selectivePointers,
      { documentLoader: options.documentLoader },
      presentationHeader
    );

    const proofValue = BBSCryptosuiteUtils.serializeDerivedProofValue(
      disclosure.bbsProof,
      disclosure.labelMap,
      disclosure.mandatoryIndexes,
      disclosure.selectiveIndexes,
      presentationHeader,
      'baseline'
    );

    // Carry challenge/domain through unchanged: createVerifyData re-derives the
    // proofHash from the derived proof's options, and it must match the base
    // proof's options (which fed the signed bbsHeader) or verification fails.
    const derivedProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      created: proof.created,
      verificationMethod: proof.verificationMethod,
      proofPurpose: proof.proofPurpose,
      proofValue,
      ...((proof as any).challenge && { challenge: (proof as any).challenge }),
      ...((proof as any).domain && { domain: (proof as any).domain })
    };

    const revealDocument = { ...disclosure.revealDocument };
    delete revealDocument.proof;
    return { document: revealDocument, proof: derivedProof };
  }

  /**
   * 3.3.8 — reconstruct the BBS verification inputs from a derived proof.
   */
  private static async createVerifyData(
    document: any,
    proof: DataIntegrityProof,
    options: { documentLoader?: (url: string) => Promise<any> }
  ): Promise<{
    bbsProof: Uint8Array;
    proofHash: Uint8Array;
    mandatoryHash: Uint8Array;
    selectiveIndexes: number[];
    presentationHeader: Uint8Array;
    nonMandatory: Uint8Array[];
  }> {
    const proofOptions: any = { ...proof };
    delete proofOptions.proofValue;
    const proofHash = sha256Of(await canonize(
      { '@context': document['@context'], ...proofOptions },
      { documentLoader: options.documentLoader }
    ));

    const parsed = BBSCryptosuiteUtils.parseDerivedProofValue(proof.proofValue);
    const labelMapFactoryFunction = createLabelMapFunction(new Map(Object.entries(parsed.labelMap)));
    const { nquads } = await labelReplacementCanonicalizeJsonLd(
      document,
      labelMapFactoryFunction,
      { documentLoader: options.documentLoader }
    );

    const mandatory: string[] = [];
    const nonMandatory: string[] = [];
    nquads.forEach((nq, index) => {
      if (parsed.mandatoryIndexes.includes(index)) mandatory.push(nq);
      else nonMandatory.push(nq);
    });

    const mandatoryHash = hashMandatoryNQuads(mandatory, sha256Of);

    return {
      bbsProof: toUint8(parsed.bbsProof),
      proofHash,
      mandatoryHash,
      selectiveIndexes: parsed.selectiveIndexes,
      presentationHeader: toUint8(parsed.presentationHeader),
      nonMandatory: nonMandatory.map(nq => new TextEncoder().encode(nq))
    };
  }

  /**
   * Resolve the Bls12381G2 public key bytes from a verification method.
   * Verification keys MUST come from the resolved DID document, never from the
   * attacker-controlled proof.
   */
  private static async resolveVerificationKey(
    verificationMethod: string,
    documentLoader?: (url: string) => Promise<any>
  ): Promise<Uint8Array> {
    if (!documentLoader) {
      throw new Error('documentLoader is required to resolve the verification method public key');
    }
    const vmDoc = await documentLoader(verificationMethod);
    const publicKeyMultibase = vmDoc?.document?.publicKeyMultibase;
    if (!publicKeyMultibase) {
      throw new Error('Verification method does not contain a publicKeyMultibase');
    }
    const dec = multikey.decodePublicKey(publicKeyMultibase);
    if (dec.type !== 'Bls12381G2') {
      throw new Error('Verification method key is not Bls12381G2');
    }
    return dec.key;
  }

  /**
   * Bind the proof's verification method to the DID that must control it: the
   * credential `issuer` (or presentation `holder`), or an explicitly supplied
   * `expectedController`. The signature is verified against whatever key
   * `proof.verificationMethod` resolves to, so without this check an attacker
   * can sign a credential naming a trusted issuer with their own key and have
   * it verify — full issuer impersonation (issue #315). Mirrors
   * Verifier.checkVerificationMethodController; fails closed when no expected
   * subject can be determined. Returns an error message, or null if bound.
   */
  private static checkProofBinding(
    unsecuredDocument: any,
    proof: DataIntegrityProof,
    expectedController?: string
  ): string | null {
    const verificationMethod = (proof as { verificationMethod?: unknown })?.verificationMethod;
    if (typeof verificationMethod !== 'string' || verificationMethod.length === 0) {
      return 'Proof is missing a verificationMethod';
    }
    let expected = expectedController;
    let subjectLabel = 'expected controller';
    if (expected === undefined) {
      const issuer = unsecuredDocument?.issuer;
      const holder = unsecuredDocument?.holder;
      if (issuer !== undefined && issuer !== null) {
        expected = typeof issuer === 'string' ? issuer : (issuer as { id?: string })?.id;
        subjectLabel = 'issuer';
      } else if (holder !== undefined && holder !== null) {
        expected = typeof holder === 'string' ? holder : (holder as { id?: string })?.id;
        subjectLabel = 'holder';
      }
    }
    if (!expected) {
      return 'Document has no issuer or holder to bind the proof to (pass expectedController to verify non-credential documents)';
    }
    const vmDid = verificationMethod.split('#')[0];
    // Compare on DID identity: `expected` may be a full verification-method URL
    // (with a #fragment) when supplied as expectedController, so strip its
    // fragment too before comparing.
    const expectedDid = expected.split('#')[0];
    if (vmDid !== expectedDid) {
      return `Proof verificationMethod (${vmDid}) does not match ${subjectLabel} (${expected})`;
    }
    return null;
  }

  /**
   * Enforce verifier-supplied challenge/domain expectations against the proof
   * (anti-replay: a derived proof observed once must not be replayable to a
   * verifier that issued a different challenge). Returns an error message, or
   * null when all supplied expectations match.
   */
  private static checkProofExpectations(
    proof: DataIntegrityProof,
    options: BBSVerifyOptions
  ): string | null {
    const proofRecord = proof as unknown as { challenge?: string; domain?: string };
    if (options.expectedChallenge !== undefined && proofRecord.challenge !== options.expectedChallenge) {
      return 'Proof challenge mismatch (possible replay)';
    }
    if (options.expectedDomain !== undefined && proofRecord.domain !== options.expectedDomain) {
      return 'Proof domain mismatch';
    }
    return null;
  }

  /**
   * 3.4.7 — verify a derived (selective-disclosure) proof.
   */
  static async verifyDerivedProof(
    securedDocument: any,
    options: BBSVerifyOptions = {}
  ): Promise<{ verified: boolean; verifiedDocument: any; errors?: string[] }> {
    try {
      const { proof, ...unsecuredDocument } = securedDocument;

      const bindingError = BBSCryptosuiteManager.checkProofBinding(
        unsecuredDocument,
        proof,
        options.expectedController
      );
      if (bindingError) {
        return { verified: false, verifiedDocument: null, errors: [bindingError] };
      }
      const expectationError = BBSCryptosuiteManager.checkProofExpectations(proof, options);
      if (expectationError) {
        return { verified: false, verifiedDocument: null, errors: [expectationError] };
      }

      const publicKey = await BBSCryptosuiteManager.resolveVerificationKey(
        proof.verificationMethod,
        options.documentLoader
      );
      const { bbsProof, proofHash, mandatoryHash, selectiveIndexes, presentationHeader, nonMandatory } =
        await BBSCryptosuiteManager.createVerifyData(unsecuredDocument, proof, options);

      const bbsHeader = concatBytes(proofHash, mandatoryHash);
      const verified = await bbs.verifyProof({
        ciphersuite: CIPHERSUITE,
        publicKey,
        proof: bbsProof,
        header: bbsHeader,
        presentationHeader,
        disclosedMessages: nonMandatory,
        disclosedMessageIndexes: selectiveIndexes
      });

      return verified
        ? { verified: true, verifiedDocument: unsecuredDocument }
        : { verified: false, verifiedDocument: null, errors: ['BBS+ derived proof verification failed'] };
    } catch (e: any) {
      // Surface the underlying error: swallowing it makes internal failures
      // (e.g. canonicalization bugs) indistinguishable from a bad signature.
      return {
        verified: false,
        verifiedDocument: null,
        errors: [e?.message ?? 'Unknown BBS+ derived proof verification error']
      };
    }
  }

  /**
   * Verify a BBS proof, dispatching to base- or derived-proof verification based
   * on the proof value header. Returns a {@link VerificationResult}.
   *
   * `document` is the unsecured document (proof removed); `proof` is supplied
   * separately, mirroring EdDSACryptosuiteManager.
   */
  static async verifyProof(
    document: any,
    proof: DataIntegrityProof,
    options: BBSVerifyOptions = {}
  ): Promise<VerificationResult> {
    try {
      if (proof.cryptosuite !== 'bbs-2023') {
        return { verified: false, errors: [`Expected bbs-2023 cryptosuite, got ${proof.cryptosuite}`] };
      }

      // Accept either an unsecured document or a secured one (proof attached):
      // an embedded proof must never be canonicalized into the verified data.
      const { proof: _docProof, ...unsecuredDocument } = document ?? {};

      const bindingError = BBSCryptosuiteManager.checkProofBinding(
        unsecuredDocument,
        proof,
        options.expectedController
      );
      if (bindingError) {
        return { verified: false, errors: [bindingError] };
      }
      const expectationError = BBSCryptosuiteManager.checkProofExpectations(proof, options);
      if (expectationError) {
        return { verified: false, errors: [expectationError] };
      }

      const decoded = decodeMultibaseB64url(proof.proofValue);
      // W3C vc-di-bbs CBOR headers (0xd9 0x5d <tag>): base proofs use 0x02
      // (baseline) / 0x04 / 0x06 / 0x08; derived (disclosure) proofs use 0x03
      // (baseline) / 0x05 / 0x07. Match the tag explicitly rather than by parity.
      const BASE_PROOF_TAGS = [0x02, 0x04, 0x06, 0x08];
      const isBaseProof = decoded[0] === 0xd9 && decoded[1] === 0x5d && BASE_PROOF_TAGS.includes(decoded[2]);

      let publicKey: Uint8Array;
      try {
        publicKey = await BBSCryptosuiteManager.resolveVerificationKey(proof.verificationMethod, options.documentLoader);
      } catch (e: any) {
        return { verified: false, errors: [e?.message ?? 'Failed to resolve verification method'] };
      }

      if (!isBaseProof) {
        const result = await BBSCryptosuiteManager.verifyDerivedProof(
          { ...unsecuredDocument, proof },
          options
        );
        return result.verified
          ? { verified: true }
          : { verified: false, errors: result.errors ?? ['BBS+ derived proof verification failed'] };
      }

      // Base proof: bind the embedded public key to the resolved DID key before
      // any signature check, rejecting key substitution.
      const parsed = BBSCryptosuiteUtils.parseBaseProofValue(proof.proofValue);
      if (parsed.publicKey && !bytesEqual(toUint8(parsed.publicKey), publicKey)) {
        return { verified: false, errors: ['Proof public key does not match verification method'] };
      }

      const proofOptions: any = { ...proof };
      delete proofOptions.proofValue;
      const proofHash = sha256Of(await canonize(
        { '@context': unsecuredDocument['@context'], ...proofOptions },
        { documentLoader: options.documentLoader }
      ));

      const { mandatory, nonMandatory } = await BBSCryptosuiteManager.baseProofTransformation(unsecuredDocument, {
        mandatoryPointers: parsed.mandatoryPointers,
        hmacKey: toUint8(parsed.hmacKey),
        documentLoader: options.documentLoader
      });
      const mandatoryHash = hashMandatoryNQuads(mandatory, sha256Of);
      const bbsHeader = concatBytes(proofHash, mandatoryHash);
      const messages = nonMandatory.map(nq => new TextEncoder().encode(nq));

      const verified = await bbs.verifySignature({
        ciphersuite: CIPHERSUITE,
        publicKey,
        signature: toUint8(parsed.bbsSignature),
        header: bbsHeader,
        messages
      });

      return verified
        ? { verified: true }
        : { verified: false, errors: ['BBS+ signature verification failed'] };
    } catch (e: any) {
      return { verified: false, errors: [e?.message ?? 'Unknown BBS+ verification error'] };
    }
  }
}
