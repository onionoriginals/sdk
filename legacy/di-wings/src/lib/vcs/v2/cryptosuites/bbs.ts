import { canonize, multibase, MULTICODEC_BLS12381_G2_PRIV_HEADER, multikey, type DocumentLoader, type VerificationResult } from "../../../crypto";
import { ProblemDetailsError } from "../errors";
import type { DataIntegrityProof, ProofOptions } from "../proofs/data-integrity";
import { sha256 } from '@noble/hashes/sha256'; // 3rd-party sha256() of type utils.CHash
import { concatBytes, randomBytes } from '@noble/hashes/utils'; // 3rd-party utilities
import * as jsonld from 'jsonld';
import { createShuffledIdLabelMapFunction, canonicalizeAndGroup, hashMandatoryNQuads, selectJsonLd, createLabelMapFunction, labelReplacementCanonicalizeJsonLd, createHmac, stripBlankNodePrefixes } from "../utils/selective-disclosure";
import * as cbor from 'cbor-js';
import { Multikey } from "../../../crypto/keypairs/Multikey";
import * as bbs from '@digitalbazaar/bbs-signatures';

import { wrapError } from "../utils/error-utils";
import type { VerifiableCredential } from "../types";
import { getPublicKeyFromVerificationMethod } from "../common/verification-method";
interface ParsedBaseProof {
  bbsSignature: Uint8Array;
  bbsHeader: Uint8Array;
  publicKey: Uint8Array;
  hmacKey: Uint8Array;
  mandatoryPointers: string[];
  featureOption: string;
  pid?: string;
  signer_blind?: string;
}

interface AdditionalFeatureOptions {
  holderSecret?: string;
  proverBlind?: string;
  verifier_id?: string;
  pid?: string;
}

interface DisclosureData {
  bbsProof: Uint8Array;
  labelMap: { [key: string]: string };
  mandatoryIndexes: number[];
  selectiveIndexes: number[];
  presentationHeader: Uint8Array;
  revealDocument: any;
  pseudonym?: string;
  lengthBBSMessages?: number;
}

interface DerivedProofValue {
  bbsProof: Uint8Array;
  labelMap: { [key: string]: string };
  mandatoryIndexes: number[];
  selectiveIndexes: number[];
  presentationHeader: Uint8Array;
  featureOption: string;
  pseudonym?: string;
  lengthBBSMessages?: number;
}

interface VerifyData {
  bbsProof: Uint8Array;
  proofHash: Uint8Array;
  mandatoryHash: Uint8Array;
  selectiveIndexes: number[];
  presentationHeader: Uint8Array;
  nonMandatory: Uint8Array[];
  featureOption: string;
  pseudonym?: string;
  lengthBBSMessages?: number;
}

interface TransformationOptions {
  type: string;
  cryptosuite: string;
  verificationMethod: string;
  mandatoryPointers?: string[];
  documentLoader?: (url: string) => Promise<any>;
}

interface HashData {
  proofHash: string;
  mandatoryHash: string;
  [key: string]: any;
}

export class BBSCryptosuiteManager {
  public static name = 'bbs-2023';
  private readonly keypair: Multikey;

  constructor(keypair: Multikey) {
    this.keypair = keypair;
  }

  /**
   * Compares two byte arrays
   * 
   * @param a - The first byte array
   * @param b - The second byte array
   * @returns boolean
   */
  private static compareBytes(a: Uint8Array, b: number[]): boolean {
    if (a.length !== b.length) return false;
    return b.every((byte, i) => a[i] === byte);
  }

  /**
   * Gets the public key from the keypair
   * 
   * @returns Uint8Array
   */
  private getPublicKey(): Uint8Array {
    return this.keypair.publicKey;
  }

  /**
   * Signs messages using the BBS signature scheme
   * 
   * @param header - The header to use for signing
   * @param messages - The messages to sign
   * @returns Uint8Array
   */
  private async sign(header: Uint8Array, messages: Uint8Array[]): Promise<Uint8Array> {
    return await bbs.sign({
      ciphersuite: 'BLS12-381-SHA-256',
      secretKey: this.keypair.privateKey,
      publicKey: this.keypair.publicKey,
      header,
      messages
    });
  }

  /**
   * Performs blind signing for anonymous holder binding
   * 
   * @param header - The header to use for signing
   * @param messages - The messages to sign
   * @param commitment - The commitment to use for signing
   * @param signer_blind - The signer blind to use for signing
   * @returns Promise<Uint8Array>
   */
  private async blindSign(header: Uint8Array, messages: Uint8Array[], commitment: Uint8Array, signer_blind: Uint8Array): Promise<Uint8Array> {
    console.error('blindSign not implemented yet');
    return new Uint8Array(0);
    // return await bbs.BlindSign({
    //   ciphersuite: 'BLS12-381-SHA-256',
    //   SK: this.keypair.privateKey,
    //   PK: this.keypair.publicKey,
    //   commitment_with_proof: commitment,
    //   header,
    //   messages,
    //   signer_blind
    // })
  }

  /**
   * Generates a cryptographically random PID
   * 
   * @returns string
   */
  private generatePid(): Uint8Array {
    return Buffer.from(randomBytes(32));
  }

  /**
   * Signs with PID for pseudonym issuer pid feature
   * 
   * @param header - The header to use for signing
   * @param messages - The messages to sign
   * @param pid - The PID to use for signing
   * @returns Uint8Array
   */
  private async signWithPid(header: Uint8Array, messages: Uint8Array[], pid: Uint8Array): Promise<Uint8Array> {
    console.error('signWithPid not implemented yet');
    return new Uint8Array(0);
  }

  /**
   * Signs with hidden PID for pseudonym hidden pid feature
   * 
   * @param header - The header to use for signing
   * @param messages - The messages to sign
   * @param commitment - The commitment to use for signing
   * @returns Promise<{ signature: Uint8Array, signer_blind: Uint8Array }>
   */
  private async signWithHiddenPid(header: Uint8Array, messages: Uint8Array[], commitment: Uint8Array): Promise<Uint8Array> {
    console.error('signWithHiddenPid not implemented yet');
    return new Uint8Array(0);
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#serializebaseproofvalue
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.1 - serializes the components of a bbs-2023 base proof value.
   * 
   * params:
   * @param bbsSignature - Uint8Array
   * @param bbsHeader - Uint8Array
   * @param publicKey - Uint8Array
   * @param hmacKey - Uint8Array
   * @param mandatoryPointers - string[]
   * @param featureOption - string
   * @param pid - string
   * @param signer_blind - Uint8Array
   * @returns string
   */
  static serializeBaseProofValue(
    bbsSignature: Uint8Array,
    bbsHeader: Uint8Array,
    publicKey: Uint8Array,
    hmacKey: Uint8Array,
    mandatoryPointers: string[],
    featureOption: string,
    pid?: Uint8Array,
    signer_blind?: Uint8Array
  ): string {
    let proofValue: Uint8Array;
    let components: (string | Uint8Array | string[])[];

    // Step 1-2: Initialize proofValue based on featureOption
    switch (featureOption) {
      case "baseline":
        // Step 2.1: Initialize proofValue with header bytes
        proofValue = new Uint8Array([0xd9, 0x5d, 0x02]);
        // Step 2.2: Initialize components array
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers];
        break;

      case "anonymous_holder_binding":
        // Step 3.1: Initialize proofValue with header bytes
        proofValue = new Uint8Array([0xd9, 0x5d, 0x04]);
        // Step 3.2: Initialize components array
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers, signer_blind!];
        break;

      case "pseudonym_issuer_pid":
        // Step 4.1: Initialize proofValue with header bytes
        proofValue = new Uint8Array([0xd9, 0x5d, 0x06]);
        // Step 4.2: Initialize components array
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers, pid!];
        break;

      case "pseudonym_hidden_pid":
        // Step 5.1: Initialize proofValue with header bytes
        proofValue = new Uint8Array([0xd9, 0x5d, 0x08]);
        // Step 5.2: Initialize components array
        components = [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers, signer_blind!];
        break;

      default:
        throw new Error(`Unsupported feature option: ${featureOption}`);
    }
    // Step 6: CBOR-encode components without MUST NOT tagging
    const encodedComponents = cbor.encode(components);

    // Append the encoded components to proofValue
    proofValue = concatBytes(proofValue, new Uint8Array(encodedComponents));

    // Step 7-8: Convert to baseProof string with multibase-base64url-no-pad encoding
    return multibase.encode(proofValue, 'base64url');
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#parsebaseproofvalue
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.2 - Parses the components of a bbs-2023 selective disclosure base proof value.
   * 
   * @param proofValue - The proof value string to parse
   * @returns ParsedBaseProof containing the parsed components
   * @throws Error if parsing fails or proof value is invalid
   */
  private static parseBaseProofValue(proofValue: string): ParsedBaseProof {
    try {
      // 1) If the proofValue string does not start with 'u' (U+0075 LATIN SMALL LETTER U),
      // indicating that it is a multibase-base64url-no-pad-encoded value, 
      // an error MUST be raised and SHOULD convey an error type of PROOF_VERIFICATION_ERROR
      if (!proofValue.startsWith('u')) {
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid proof value encoding',
          'Proof value must be multibase-base64url-no-pad-encoded (start with "u")',
          -16
        );
      }

      // 2) Initialize decodedProofValue to the result of base64url-no-pad-decoding
      // the substring that follows the leading 'u' in proofValue
      const decodedProofValue = multibase.decode(proofValue);

      // 3) Check that the BBS base proof starts with an allowed header value
      // and set the featureOption variable accordingly
      let featureOption: string;
      const header = decodedProofValue.slice(0, 3);

      // Compare header bytes and set featureOption
      if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x02])) {
        featureOption = 'baseline';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x04])) {
        featureOption = 'anonymous_holder_binding';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x06])) {
        featureOption = 'pseudonym_issuer_pid';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x08])) {
        featureOption = 'pseudonym_hidden_pid';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x03])) {
        featureOption = 'base_proof';
      } else {
        // 3.5) If decodedProofValue starts with any other three byte sequence,
        // an error MUST be raised and SHOULD convey an error type of PROOF_VERIFICATION_ERROR
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid proof header',
          'Proof value must start with a valid BBS header sequence',
          -16
        );
      }
      // 4) Initialize components to an array that is the result of CBOR-decoding
      // the bytes that follow the three-byte BBS base proof header
      const components = cbor.decode(decodedProofValue.slice(3).buffer);
      if (!components || components.length === 0) {
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid proof header',
          'Proof value must contain valid CBOR data',
          -16
        );  
      }
      // 5) Based on the value of featureOption, return an object based on components
      switch (featureOption) {
        case 'baseline':
          // 5.1) If featureOption equals "baseline"
          return {
            bbsSignature: components[0],
            bbsHeader: components[1],
            publicKey: components[2],
            hmacKey: components[3],
            mandatoryPointers: components[4],
            featureOption
          };

        case 'anonymous_holder_binding':
          // 5.2) If featureOption equals "anonymous_holder_binding"
          return {
            bbsSignature: components[0],
            bbsHeader: components[1],
            publicKey: components[2],
            hmacKey: components[3],
            mandatoryPointers: components[4],
            signer_blind: components[5],
            featureOption
          };

        case 'pseudonym_issuer_pid':
          // 5.3) If featureOption equals "pseudonym_issuer_pid"
          return {
            bbsSignature: components[0],
            bbsHeader: components[1],
            publicKey: components[2],
            hmacKey: components[3],
            mandatoryPointers: components[4],
            pid: components[5],
            featureOption
          };

        case 'pseudonym_hidden_pid':
          // 5.4) If featureOption equals "pseudonym_hidden_pid"
          return {
            bbsSignature: components[0],
            bbsHeader: components[1],
            publicKey: components[2],
            hmacKey: components[3],
            mandatoryPointers: components[4],
            signer_blind: components[5],
            featureOption
          };

        default:
          throw new Error(`Unsupported feature option: ${featureOption}`);
      }
    } catch (err: any) {
      if (err instanceof ProblemDetailsError) {
        throw err;
      }
      console.trace(err)
      throw new ProblemDetailsError(
        'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
        'Failed to parse base proof value',
        err.message,
        -16
      );
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#createdisclosuredata
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.3 - Creates data to be used to generate a derived proof.
   * 
   * @param document - The JSON-LD document to create disclosure data for
   * @param proof - The BBS base proof to derive from
   * @param selectivePointers - Array of JSON pointers indicating statements to selectively disclose
   * @param featureOption - The feature option being used (baseline, anonymous_holder_binding, etc)
   * @param options - Additional options including document loader
   * @param presentationHeader - Optional BBS presentation header
   * @param additionalFeatureOptions - Additional options required by specific features
   * @returns DisclosureData containing the data needed for derived proof generation
   * @throws Error if data creation fails or required parameters are missing
   */
  private static async createDisclosureData(
    document: any,
    proof: DataIntegrityProof,
    selectivePointers: string[],
    featureOption: string,
    options: { documentLoader?: (url: string) => Promise<any> },
    presentationHeader: Uint8Array = new Uint8Array(0),
    additionalFeatureOptions: AdditionalFeatureOptions = {}
  ): Promise<DisclosureData> {
    try {
      // 1) Initialize bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers, pid, and signer_blind
      // to the values of the associated properties in the object returned when calling parseBaseProofValue
      const parsedProof = BBSCryptosuiteManager.parseBaseProofValue(proof.proofValue);

      // 2) Initialize hmac to an HMAC API using hmacKey
      // The HMAC uses the same hash algorithm used in the signature algorithm, i.e., SHA-256
      const hmacFn = createHmac(parsedProof.hmacKey);

      // 3) Initialize labelMapFactoryFunction to the result of calling createShuffledIdLabelMapFunction
      const labelMapFactoryFunction = createShuffledIdLabelMapFunction(hmacFn);

      // 4) Initialize combinedPointers to the concatenation of mandatoryPointers and selectivePointers
      const combinedPointers = [...parsedProof.mandatoryPointers, ...selectivePointers];

      // 5) Initialize groupDefinitions to a map with the following entries:
      const groupDefinitions = {
        "mandatory": parsedProof.mandatoryPointers,
        "selective": selectivePointers,
        "combined": combinedPointers
      };
      // 6) Initialize groups and labelMap to the result of calling canonicalizeAndGroup
      const { proof: docProof, ...restDocument } = document;
      const { groups, labelMap } = await canonicalizeAndGroup(
        restDocument,
        labelMapFactoryFunction,
        groupDefinitions,
        { documentLoader: options.documentLoader! }
      );

      // 7) Compute mandatory indexes
      const selectiveMatch = groups.get('selective')!.matching;
      const combinedMatch = groups.get('combined')!.matching;
      const mandatoryMatch = groups.get('mandatory')!.matching;
      const mandatoryNonMatch = groups.get('mandatory')!.nonMatching;
      const combinedIndexes = Array.from(combinedMatch.keys());
      const nonMandatoryIndexes = Array.from(mandatoryNonMatch.keys());
      
      // 7.1) Initialize mandatoryIndexes to an empty array
      const mandatoryIndexes: number[] = [];
      let relativeIndex = 0;
      // For each key in mandatoryMatch, find its index in combinedIndexes
      for (const key of mandatoryMatch.keys()) {
        const relativeIndex = combinedIndexes.indexOf(key);
        if (relativeIndex !== -1) {
          mandatoryIndexes.push(relativeIndex);
        }
      }

      // 8) Compute selective indexes
      // 8.1) Initialize selectiveIndexes to an empty array
      relativeIndex = 0;
      const selectiveIndexes = [];
      for(const absoluteIndex of mandatoryNonMatch.keys()) {
        if(selectiveMatch.has(absoluteIndex)) {
          selectiveIndexes.push(nonMandatoryIndexes.indexOf(absoluteIndex));
        }
      }
      

      // 9) Initialize bbsMessages to array of byte arrays containing values in nonMandatory array
      const bbsMessages = [...mandatoryNonMatch.values()].map(str => 
        new TextEncoder().encode(str)
      );

      // 10) Set bbsProof based on featureOption
      let bbsProof: Uint8Array;
      let pseudonym: string | undefined;
      switch (featureOption) {
        case 'baseline':
          
          // const gens = await prepareGenerators(20, API_ID_BBS_SHA); // Default SHA-256 hash
          // const msg_scalars = await messages_to_scalars(bbsMessages, API_ID_BBS_SHA);
          // bbsProof = await proofGen(
          //   parsedProof.publicKey, parsedProof.bbsSignature, parsedProof.bbsHeader,
          //   presentationHeader, msg_scalars, selectiveIndexes, gens, API_ID_BBS_SHA
          // );
          
          bbsProof = await bbs.deriveProof({
            ciphersuite: 'BLS12-381-SHA-256',
            publicKey: parsedProof.publicKey,
            signature: parsedProof.bbsSignature,
            header: parsedProof.bbsHeader,
            presentationHeader,
            messages: bbsMessages,
            disclosedMessageIndexes: selectiveIndexes
          });
          break;

        case 'anonymous_holder_binding':
          throw new Error('Anonymous holder binding is not supported');
          // if (!additionalFeatureOptions.holderSecret || !additionalFeatureOptions.proverBlind) {
          //   throw new ProblemDetailsError(
          //     'https://w3id.org/security#PROOF_GENERATION_ERROR',
          //     'Missing required parameters',
          //     'holderSecret and proverBlind are required for anonymous_holder_binding',
          //     -16
          //   );
          // }
          // bbsProof = await bbs.BlindProofGen({
          //   PK: parsedProof.publicKey,
          //   signature: parsedProof.bbsSignature,
          //   header: parsedProof.bbsHeader,
          //   ph: presentationHeader,
          //   messages: bbsMessages,
          //   disclosed_indexes: selectiveIndexes,
          //   holder_secret: additionalFeatureOptions.holderSecret,
          //   prover_blind: additionalFeatureOptions.proverBlind
          // });
          break;

        case 'pseudonym_issuer_pid':
        case 'pseudonym_hidden_pid':
          if (!additionalFeatureOptions.verifier_id) {
            throw new ProblemDetailsError(
              'https://w3id.org/security#PROOF_GENERATION_ERROR',
              'Missing required parameter',
              'verifier_id is required for pseudonym features',
              -16
            );
          }
          // pseudonym = await bbs.CalculatePseudonym({
          //   verifier_id: additionalFeatureOptions.verifier_id,
          //   pid: parsedProof.pid!
          // });
          if (featureOption === 'pseudonym_issuer_pid') {
            throw new Error('Pseudonym issuer pid is not supported');
            // bbsProof = await bbs.SignerProvidedPIDProofGeneration({
            //   PK: parsedProof.publicKey,
            //   signature: parsedProof.bbsSignature,
            //   header: parsedProof.bbsHeader,
            //   ph: presentationHeader,
            //   messages: bbsMessages,
            //   disclosed_indexes: selectiveIndexes,
            //   pseudonym
            // });
          } else {
            throw new Error('Pseudonym hidden pid is not supported');
            // if (!additionalFeatureOptions.proverBlind) {
            //   throw new ProblemDetailsError(
            //     'https://w3id.org/security#PROOF_GENERATION_ERROR',
            //     'Missing required parameter',
            //     'proverBlind is required for pseudonym_hidden_pid',
            //     -16
            //   );
            // }
            // bbsProof = await bbs.HiddenPIDProofGenerationWithPseudonym({
            //   PK: parsedProof.publicKey,
            //   signature: parsedProof.bbsSignature,
            //   header: parsedProof.bbsHeader,
            //   ph: presentationHeader,
            //   messages: bbsMessages,
            //   disclosed_indexes: selectiveIndexes,
            //   commitment_with_proof: parsedProof.signer_blind!,
            //   pid: parsedProof.pid!,
            //   prover_blind: additionalFeatureOptions.proverBlind,
            //   pseudonym
            // });
          }
          break;

        default:
          throw new Error(`Unsupported feature option: ${featureOption}`);
      }

      // 11) If featureOption equals "anonymous_holder_binding" or "pseudonym_hidden_pid", set the lengthBBSMessages parameter to the length of the bbsMessages array. If featureOption equals "pseudonym_issuer_pid" set the lengthBBSMessages parameter to the length of the bbsMessages array + 1.
      let lengthBBSMessages: number | null = null;
      // if (featureOption === 'anonymous_holder_binding' || featureOption === 'pseudonym_hidden_pid') {
      //   lengthBBSMessages = bbsMessages.length;
      // } else if (featureOption === 'pseudonym_issuer_pid') {
      //   lengthBBSMessages = bbsMessages.length + 1;
      // }

      // 12) Initialize revealDocument using selectJsonLd algorithm
      const revealDocument = selectJsonLd(combinedPointers, document);

      // 13) Run the RDF Dataset Canonicalization Algorithm [RDF-CANON] on the joined combinedGroup.deskolemizedNQuads, passing any custom options, and get the canonical bnode identifier map, canonicalIdMap
      let canonicalIdMap: Map<string, string> = new Map();
      await jsonld.canonize(groups.get('combined')!.deskolemizedNQuads.join(''), {
        documentLoader: options.documentLoader!,
        algorithm: 'URDNA2015',
        inputFormat: 'application/n-quads',
        format: 'application/n-quads',
        canonicalIdMap
      });
      canonicalIdMap = stripBlankNodePrefixes(canonicalIdMap);
      
      // 14) Initialize verifierLabelMap to an empty map.
      const verifierLabelMap: Map<string, string> = new Map();

      // 15) For each key (inputLabel) and value (verifierLabel) in `canonicalIdMap`:
      for (const [inputLabel, verifierLabel] of canonicalIdMap) {
        // 15.1) Add an entry to verifierLabelMap, using verifierLabel as the key, and the value associated with inputLabel as a key in labelMap as the value.
        verifierLabelMap.set(verifierLabel, labelMap.get(inputLabel)!);
      }

      return {
        bbsProof,
        labelMap: Object.fromEntries(verifierLabelMap.entries()),
        mandatoryIndexes,
        selectiveIndexes,
        presentationHeader,
        revealDocument,
        ...(lengthBBSMessages ? { lengthBBSMessages } : {}),
        pseudonym
      };

    } catch (err: any) {
      throw wrapError(
        err,
        'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
        'Failed to create disclosure data',
        'Error creating disclosure data for selective disclosure'
      );
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#compresslabelmap
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.4 - Compresses a label map according to the BBS cryptosuite specification
   * 
   * @param labelMap - Array of label mappings to compress
   * @returns Object containing compressed label mappings
   * @throws Error if compression fails or input is invalid
   */
  private static compressLabelMap(labelMap: { [key: string]: string }): { [key: string]: string } {
    try {
      // 1) Initialize map to an empty map
      const map: { [key: string]: string } = {};

      // 2) For each entry (k, v) in labelMap
      for (const [k, v] of Object.entries(labelMap)) {
        // 2.1) Add an entry to map with:
        // - key that is base-10 integer parsed from characters following "c14n" prefix in k
        // - value that is base-10 integer parsed from characters following "b" prefix in v
        const c14nMatch = k.match(/^c14n(\d+)$/);
        const bMatch = v.match(/^b(\d+)$/);

        if (!c14nMatch || !bMatch) {
          throw new Error(`Invalid label map entry: ${k} -> ${v}`);
        }

        const key = parseInt(c14nMatch[1], 10);
        const value = parseInt(bMatch[1], 10);

        map[key] = value.toString();
      }

      // 3) Return map as compressed label map
      return map;

    } catch (err: any) {
      throw new Error(`Failed to compress label map: ${err.message}`);
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#decompresslabelmap
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.5 - Decompresses a label map according to the BBS cryptosuite specification.
   * 
   * @param compressedLabelMap - Object containing compressed label mappings as key-value pairs
   * @returns Array of strings representing the decompressed label map
   * @throws Error if decompression fails or input is invalid
   */
  private static decompressLabelMap(compressedLabelMap: { [key: string]: string }): { [key: string]: string } {
    try {
      // 1) Initialize map to an empty map
      const map: { [key: string]: string } = {};

      // 2) For each entry (k, v) in compressedLabelMap
      for (const [k, v] of Object.entries(compressedLabelMap)) {
        // 2.1) Add an entry to map, with:
        // - key that adds the prefix "c14n" to k
        // - value that adds a prefix of "b" to v
        map[`c14n${k}`] = `b${v}`;
      }

      // 3) Return map as decompressed label map
      return map;

    } catch (err: any) {
      throw new Error(`Failed to decompress label map: ${err.message}`);
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#serializederivedproofvalue
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.6 - Serializes a derived proof value according to the BBS cryptosuite specification
   * 
   * @param bbsProof - The BBS proof to serialize
   * @param labelMap - Array of label mappings
   * @param mandatoryIndexes - Array of mandatory statement indexes
   * @param selectiveIndexes - Array of selectively disclosed statement indexes
   * @param presentationHeader - Optional BBS presentation header
   * @param featureOption - The feature option being used (baseline, anonymous_holder_binding, etc)
   * @param pseudonym - Optional pseudonym value for pseudonym features
   * @param lengthBBSMessages - Optional length of BBS messages for certain features
   * @returns Uint8Array containing the serialized derived proof value
   * @throws Error if serialization fails or feature option is unsupported
   */
  public static serializeDerivedProofValue(
    bbsProof: Uint8Array,
    labelMap: { [key: string]: string },
    mandatoryIndexes: number[],
    selectiveIndexes: number[],
    presentationHeader: Uint8Array,
    featureOption: string,
    pseudonym?: string,
    lengthBBSMessages?: number
  ): string {
    try {
      // 1) Initialize compressedLabelMap to the result of calling compressLabelMap
      const compressedLabelMap = BBSCryptosuiteManager.compressLabelMap(labelMap);

      // 2) Initialize components array based on featureOption
      let proofValue: Uint8Array;
      let components: (Uint8Array | string | string[] | number | number[] | { [key: string]: string })[];

      switch (featureOption) {
        case 'baseline':
          // 2.1.1) Initialize proofValue with disclosure proof header bytes
          proofValue = new Uint8Array([0xd9, 0x5d, 0x03]);
          // 2.1.2) Initialize components array
          components = [
            bbsProof,
            compressedLabelMap,
            mandatoryIndexes,
            selectiveIndexes,
            presentationHeader
          ];
          break;

        case 'anonymous_holder_binding':
          if (!lengthBBSMessages) {
            throw new ProblemDetailsError('https://w3id.org/security#PROOF_GENERATION_ERROR', 'Missing required parameter', 'The lengthBBSMessages is required for anonymous_holder_binding', -16);
          }
          // 2.2.1) Initialize proofValue with disclosure proof header bytes
          proofValue = new Uint8Array([0xd9, 0x5d, 0x05]);
          // 2.2.2) Initialize components array
          components = [
            bbsProof,
            compressedLabelMap,
            mandatoryIndexes,
            selectiveIndexes,
            presentationHeader,
            lengthBBSMessages!
          ];
          break;

        case 'pseudonym_issuer_pid':
        case 'pseudonym_hidden_pid':
          if (!pseudonym) {
            throw new ProblemDetailsError('https://w3id.org/security#PROOF_GENERATION_ERROR', 'Missing required parameter', 'The pseudonym is required for pseudonym features', -16);
          }
          if (!lengthBBSMessages) {
            throw new ProblemDetailsError('https://w3id.org/security#PROOF_GENERATION_ERROR', 'Missing required parameter', 'The lengthBBSMessages is required for anonymous_holder_binding', -16);
          }
          // 2.3.1) Initialize proofValue with disclosure proof header bytes
          proofValue = new Uint8Array([0xd9, 0x5d, 0x07]);
          // 2.3.2) Initialize components array
          components = [
            bbsProof,
            compressedLabelMap,
            mandatoryIndexes,
            selectiveIndexes,
            presentationHeader,
            pseudonym!,
            lengthBBSMessages!
          ];
          break;

        default:
          throw new Error(`Unsupported feature option: ${featureOption}`);
      }

      // 3) CBOR-encode components without tagging
      const encodedComponents = cbor.encode(components);
      // Append the encoded components to proofValue
      proofValue = concatBytes(proofValue, new Uint8Array(encodedComponents));

      // 4) Return the derived proof as a string with the multibase-base64url-no-pad-encoding of proofValue
      return multibase.encode(proofValue, 'base64url');
    } catch (err: any) {
      throw new Error(`Failed to serialize derived proof value: ${err.message}`);
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#parsederivedproofvalue
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.7 - Parses the components of the derived proof value.
   * 
   * @param proofValue - The derived proof value string to parse
   * @returns DerivedProofValue containing the parsed components
   * @throws Error if parsing fails or proof value is invalid
   */
  private static parseDerivedProofValue(proofValue: string): DerivedProofValue {
    try {
      // 1) If the proofValue string does not start with 'u' (U+0075, LATIN SMALL LETTER U),
      // indicating that it is a multibase-base64url-no-pad-encoded value,
      // an error MUST be raised and SHOULD convey an error type of PROOF_VERIFICATION_ERROR
      if (!proofValue.startsWith('u')) {
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid proof value encoding',
          'Proof value must be multibase-base64url-no-pad-encoded (start with "u")',
          -16
        );
      }

      // 2) Initialize decodedProofValue to the result of base64url-no-pad-decoding
      // the substring that follows the leading 'u' in proofValue
      const decodedProofValue = multibase.decode(proofValue);

      // 3) Check that the BBS disclosure proof starts with an allowed header value
      // and set the featureOption variable accordingly
      let featureOption: string;
      const header = decodedProofValue.slice(0, 3);

      // Compare header bytes and set featureOption
      if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x03])) {
        featureOption = 'baseline';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x05])) {
        featureOption = 'anonymous_holder_binding';
      } else if (BBSCryptosuiteManager.compareBytes(header, [0xd9, 0x5d, 0x07])) {
        featureOption = 'pseudonym';
      } else {
        console.trace(header, [0xd9, 0x5d, 0x03])
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid proof header',
          'Proof value must start with a valid BBS disclosure proof header sequence',
          -16
        );
      }

      // 4) Initialize components to an array that is the result of CBOR-decoding
      // the bytes that follow the three-byte BBS disclosure proof header.
      // If the result is not an array of five, six, or seven elements — a byte array,
      // a map of integers to integers, two arrays of integers, and one or two byte arrays;
      // an error MUST be raised and SHOULD convey an error type of PROOF_VERIFICATION_ERROR
      const components = cbor.decode(decodedProofValue.slice(3).buffer);

      if (!Array.isArray(components) || 
          components.length < 5 || 
          components.length > 7 ||
          !(components[0] instanceof Uint8Array) || // bbsProof
          typeof components[1] !== 'object' || // labelMap
          !Array.isArray(components[2]) || // mandatoryIndexes
          !Array.isArray(components[3]) || // selectiveIndexes
          !(components[4] instanceof Uint8Array) // presentationHeader
      ) {
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          'Invalid components structure',
          'Components must be an array of 5-7 elements with specific types',
          -16
        );
      }

      // 5) Replace the second element in components using the result of calling decompressLabelMap
      const decompressedLabelMap = BBSCryptosuiteManager.decompressLabelMap(components[1]);

      // 6) Return derived proof value object with properties set to the five, six, or seven elements
      const result: DerivedProofValue = {
        bbsProof: components[0],
        labelMap: decompressedLabelMap,
        mandatoryIndexes: components[2],
        selectiveIndexes: components[3],
        presentationHeader: components[4],
        featureOption
      };

      // Add optional properties based on featureOption
      if (featureOption === 'anonymous_holder_binding') {
        result.lengthBBSMessages = components[5];
      } else if (featureOption === 'pseudonym') {
        result.pseudonym = components[5];
        result.lengthBBSMessages = components[6];
      }

      return result;

    } catch (err: any) {
      throw wrapError(
        err,
        'https://w3id.org/security#PROOF_VERIFICATION_ERROR', 
        'Failed to parse derived proof value',
        'Error parsing the derived proof value'
      );
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#createverifydata
   * Data Integrity BBS Cryptosuite v1.0
   * 3.3.8 - Creates the data needed to perform verification of a BBS-protected verifiable credential.
   * 
   * @param document - The JSON-LD document to verify
   * @param proof - The BBS disclosure proof to verify
   * @param options - Additional options including document loader
   * @returns VerifyData containing the data needed for verification
   * @throws Error if data creation fails or required parameters are missing
   */
static async createVerifyData(
    document: any,
    proof: DataIntegrityProof,
    options: { documentLoader?: (url: string) => Promise<any> }
  ): Promise<VerifyData> {
    try {
      // 1) Initialize proofHash to the result of performing RDF Dataset Canonicalization
      // on the proof options, i.e., the proof portion of the document with the proofValue removed
      const proofOptions: any = { ...proof };
      delete proofOptions.proofValue;
      const proofHash = sha256(await canonize({
        '@context': document['@context'],
        ...proofOptions
      }, { documentLoader: options.documentLoader }));

      // 2) Initialize bbsProof, labelMap, mandatoryIndexes, selectiveIndexes, presentationHeader,
      // featureOption, and possibly pseudonym and/or lengthBBSMessages to the values associated
      // with their property names in the object returned when calling parseDerivedProofValue
      const parsedProof = BBSCryptosuiteManager.parseDerivedProofValue(proof.proofValue);
      
      // 3) Initialize labelMapFactoryFunction to the result of calling the createLabelMapFunction algorithm
      const labelMapFactoryFunction = createLabelMapFunction(new Map(Object.entries(parsedProof.labelMap)));

      // 4) Initialize nquads to the result of calling the "labelReplacementCanonicalize" algorithm
      const nquads = await labelReplacementCanonicalizeJsonLd(
        document,
        labelMapFactoryFunction,
        { documentLoader: options.documentLoader! }
      );

      // 5) Initialize mandatory to an empty array
      const mandatory: string[] = [];

      // 6) Initialize nonMandatory to an empty array
      const nonMandatory: string[] = [];

      // 7) For each entry (index, nq) in nquads, separate the N-Quads into mandatory and non-mandatory categories
      for (const [index, nq] of nquads.nquads.entries()) {
        // 7.1) If mandatoryIndexes includes index, add nq to mandatory
        if (parsedProof.mandatoryIndexes.includes(index)) {
          mandatory.push(nq);
        } else {
          // 7.2) Otherwise, add nq to nonMandatory
          nonMandatory.push(nq);
        }
      }

      // 8) Initialize mandatoryHash to the result of calling hashMandatory primitive, passing mandatory
      const mandatoryHash = hashMandatoryNQuads(mandatory, sha256);

      // 9) Return an object with properties matching baseSignature, proofHash, nonMandatory,
      // mandatoryHash, selectiveIndexes, featureOption, and possibly pseudonym and/or lengthBBSMessages
      return {
        bbsProof: parsedProof.bbsProof,
        proofHash,
        mandatoryHash,
        selectiveIndexes: parsedProof.selectiveIndexes,
        presentationHeader: parsedProof.presentationHeader,
        nonMandatory: nonMandatory.map(nq => new TextEncoder().encode(nq)),
        featureOption: parsedProof.featureOption,
        ...(parsedProof.pseudonym && { pseudonym: parsedProof.pseudonym }),
        ...(parsedProof.lengthBBSMessages && { lengthBBSMessages: parsedProof.lengthBBSMessages })
      };
    } catch (err: any) {
      throw wrapError(
        err,
        'https://w3id.org/security#PROOF_VERIFICATION_ERROR', 
        'Failed to create verify data',
        'Error creating verify data',
        -16
      );
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#create-base-proof-bbs-2023
   * Data Integrity BBS Cryptosuite v1.0
   * 3.4.1 - Creates a data integrity proof given an unsecured data document.
   * 
   * @param unsecuredDocument - The unsecured data document to create a proof for
   * @param options - Proof options containing type, cryptosuite, verificationMethod etc
   * @param mandatoryPointers - Array of JSON pointers indicating mandatory statements
   * @param featureOption - Optional feature to use (baseline, anonymous_holder_binding, etc)
   * @param commitment_with_proof - Optional commitment with proof required for certain features
   * @returns Promise<DataIntegrityProof> The created proof
   * @throws Error if proof creation fails
   */
  public async createBaseProof(
    unsecuredDocument: any,
    options: ProofOptions,
    mandatoryPointers: string[] = [],
    featureOption: string = 'baseline',
    commitment_with_proof?: Uint8Array
  ): Promise<DataIntegrityProof> {
    try {
      // 1) Let proof be a clone of the proof options
      const {documentLoader, ...proof} = { ...options, proofValue: '' };
      
      // 2) Let proofConfig be the result of running Base Proof Configuration
      const proofConfig = await BBSCryptosuiteManager.baseProofConfiguration(
        options,
        unsecuredDocument['@context']
      );
    
      // 3) Let transformedData be the result of running Base Proof Transformation
      const transformedData = await BBSCryptosuiteManager.baseProofTransformation(
        unsecuredDocument,
        {
          type: options.type,
          cryptosuite: options.cryptosuite,
          verificationMethod: options.verificationMethod,
          mandatoryPointers,
          documentLoader
        }
      );
      // 4) Let hashData be the result of running Base Proof Hashing
      const hashData = BBSCryptosuiteManager.baseProofHashing(transformedData, proofConfig);
      
      // 5) Let proofBytes be the result of running Base Proof Serialization
      const proofBytes = await this.baseProofSerialization(
        hashData,
        featureOption,
        commitment_with_proof
      );
      // 6) Set proof.proofValue to the base64url-no-pad multibase encoding of proofBytes
      proof.proofValue = multibase.encode(proofBytes, 'base64url');
      
      // 7) Return proof
      return proof;
    } catch (err: any) {
      throw new Error(`Failed to create base proof: ${err.message}`);
    }
  }

  static async createProof(document: any, options: ProofOptions): Promise<DataIntegrityProof> {
    const {mandatoryPointers, featureOption, commitment_with_proof, privateKey, ...proofOptions} = options;
    if (!privateKey) {
      throw new Error('Private key is required');
    }
    const suite = new BBSCryptosuiteManager(
      Multikey.fromSecretKey(
        multikey.encode(MULTICODEC_BLS12381_G2_PRIV_HEADER, privateKey)
      )
    );
    return await suite.createBaseProof(document, proofOptions, mandatoryPointers, featureOption, commitment_with_proof);
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#base-proof-transformation-bbs-2023
   * Data Integrity BBS Cryptosuites v1.0
   * 3.4.2 - Transforms an unsecured input document into a transformed document ready 
   * to be provided as input to the hashing algorithm.
   * 
   * @param unsecuredDocument - The unsecured data document to transform
   * @param options - Transformation options containing type, cryptosuite, verificationMethod and optional mandatoryPointers
   * @returns Transformed document containing mandatory and non-mandatory statements
   * @throws Error if transformation fails or options are invalid
   */
  public static async baseProofTransformation(
    unsecuredDocument: any, 
    options: TransformationOptions
  ): Promise<{ mandatory: string[], nonMandatory: string[], hmacKey: Uint8Array, mandatoryPointers: string[] }> {
    try {
      // Validate required options
      if (!options.type || !options.cryptosuite || !options.verificationMethod) {
        throw new Error('Missing required transformation options');
      }

      // Initialize mandatoryPointers if not provided
      const mandatoryPointers = options.mandatoryPointers || [];

      // Generate HMAC key
      const hmacKey = randomBytes(32);
      
      // Create HMAC function
      const hmacFn = createHmac(hmacKey);

      // Create label map factory function
      const labelMapFactoryFunction = createShuffledIdLabelMapFunction(hmacFn);

      // Set up group definitions with proper paths
      const groupDefinitions = {
        mandatory: mandatoryPointers
      };

      // Transform document using canonicalization and grouping
      const { groups } = await canonicalizeAndGroup(
        unsecuredDocument, 
        labelMapFactoryFunction,
        groupDefinitions,
        { documentLoader: options.documentLoader! }
      );

      // Get the mandatory and non-mandatory statements
      const mandatory = Array.from(groups.get('mandatory')!.matching.values());
      const nonMandatory = Array.from(groups.get('mandatory')!.nonMatching.values());

      return {
        mandatory,
        nonMandatory,
        hmacKey,
        mandatoryPointers
      };

    } catch (err: any) {
      throw new Error(`Failed to transform document: ${err.message}`);
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#baseproofhashing
   * Data Integrity BBS Cryptosuites v1.0
   * 3.4.3 - Cryptographically hashes a transformed data document and proof configuration
   * into cryptographic hash data that is ready to be provided as input to baseProofSerialization.
   * 
   * @param transformedDocument - The transformed document containing mandatory and non-mandatory statements
   * @param canonicalProofConfig - The canonical proof configuration
   * @returns HashData containing proofHash and mandatoryHash
   * @throws Error if hashing fails
   */
  public static baseProofHashing(transformedDocument: any, canonicalProofConfig: string): HashData {
    try {
      // Step 1: Initialize proofHash by canonicalizing and hashing proof config
      const proofHash = sha256(canonicalProofConfig);

      // Step 2: Initialize mandatoryHash by hashing mandatory statements
      const mandatoryHash = hashMandatoryNQuads(transformedDocument.mandatory, sha256)

      // Step 3: Initialize hashData as deep copy of transformedDocument
      const hashData: HashData = JSON.parse(JSON.stringify(transformedDocument));
      
      // Step 4: Add proofHash and mandatoryHash to hashData
      hashData.proofHash = Buffer.from(proofHash).toString('hex');
      hashData.mandatoryHash = Buffer.from(mandatoryHash).toString('hex');

      return hashData;
    } catch (err: any) {
      throw new Error(`Failed to create hash data: ${err.message}`);
    }
  }

  /** 
   * 3.4.4 - generates a proof configuration from a set of proof options that is used as input to baseProofHashing.
   * 
   * params:
   * @param options - ProofOptions
   * @param context - string[]
   * @returns Promise<string>
   */
  public static async baseProofConfiguration(options: ProofOptions, context: string[]): Promise<string> {
    const { documentLoader, ...proofConfig } = options;
    if (proofConfig.type !== 'DataIntegrityProof') {
      throw new ProblemDetailsError('https://w3id.org/security#PROOF_GENERATION_ERROR', 'Invalid proof type', 'The proof type must be "DataIntegrityProof"', -16);
    }
    if (proofConfig.cryptosuite !== 'bbs-2023') {
      throw new ProblemDetailsError('https://w3id.org/security#PROOF_GENERATION_ERROR', 'Invalid cryptosuite', 'The cryptosuite must be "bbs-2023"', -16);
    }
    if (proofConfig.created) {
      // XML Schema datetime format: YYYY-MM-DDThh:mm:ss.sssZ
      const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
      if (!dateRegex.test(proofConfig.created)) {
        throw new ProblemDetailsError(
          'https://w3id.org/security#PROOF_GENERATION_ERROR',
          'Invalid created date',
          'The created date must be a valid XML Schema datetime',
          -16
        );
      }
    }
    // Explicitly add @context to the type
    (proofConfig as any)['@context'] = context;
    const canonicalProofConfig = await canonize(proofConfig, { documentLoader });
    return canonicalProofConfig;
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#base-proof-serialization
   * Data Integrity BBS Cryptosuite v1.0
   * 3.4.5 - Creates a base proof by processing hash data according to feature options
   * 
   * @param hashData - Hash data containing proofHash, mandatoryPointers, mandatoryHash, etc
   * @param featureOption - The feature option to use (baseline, anonymous_holder_binding, etc)
   * @param commitment_with_proof - Optional commitment with proof for certain feature options
   * @param keypair - The keypair to use for signing
   * @returns Uint8Array containing the proof value as digital proof
   * @throws Error if required parameters are missing or signing fails
   */
  public async baseProofSerialization(
    hashData: HashData,
    featureOption: string,
    commitment_with_proof?: Uint8Array,
  ): Promise<Uint8Array> {
    // 1) Initialize values from hashData
    const { 
      proofHash, 
      mandatoryPointers, 
      mandatoryHash, 
      nonMandatory, 
      hmacKey 
    } = hashData;

    // 2) Initialize bbsHeader to the concatenation of proofHash and mandatoryHash in that order
    const bbsHeader = concatBytes(
      Buffer.from(proofHash, 'hex'),
      Buffer.from(mandatoryHash, 'hex')
    );

    // 3) Initialize bbsMessages to an array of byte arrays containing the values in the nonMandatory array
    // of strings encoded using UTF-8 character encoding
    const bbsMessages = nonMandatory.map((msg: string) => 
      new TextEncoder().encode(msg)
    );

    let bbsSignature: Uint8Array;
    let signer_blind = this.generatePid();
    const pid = this.generatePid();

    // 4) Compute bbsSignature based on featureOption
    switch (featureOption) {
      case 'baseline':
        // 4.1) If featureOption equals "baseline", compute bbsSignature using Sign procedure
        bbsSignature = await this.sign(bbsHeader, bbsMessages);
        break;

      case 'anonymous_holder_binding':
        // 4.2) If featureOption equals "anonymous_holder_binding"
        if (!commitment_with_proof) {
          throw new ProblemDetailsError(
            'https://w3id.org/security#PROOF_GENERATION_ERROR',
            'Missing commitment_with_proof',
            'commitment_with_proof is required for anonymous_holder_binding',
            -16
          );
        }
        bbsSignature = await this.blindSign(bbsHeader, bbsMessages, commitment_with_proof, signer_blind);

        break;

      case 'pseudonym_issuer_pid':
        // 4.3) If featureOption equals "pseudonym_issuer_pid"
        bbsSignature = await this.signWithPid(bbsHeader, bbsMessages, pid);
        break;

      case 'pseudonym_hidden_pid':
        // 4.4) If featureOption equals "pseudonym_hidden_pid"
        if (!commitment_with_proof) {
          throw new ProblemDetailsError(
            'https://w3id.org/security#PROOF_GENERATION_ERROR',
            'Missing commitment_with_proof',
            'commitment_with_proof is required for pseudonym_hidden_pid',
            -16
          );
        }
        bbsSignature = await this.signWithHiddenPid(bbsHeader, bbsMessages, commitment_with_proof);
        break;

      default:
        throw new Error(`Unsupported feature option: ${featureOption}`);
    }

    // 5) Initialize proofValue by calling serializeBaseProofValue
    const proofValue = BBSCryptosuiteManager.serializeBaseProofValue(
      bbsSignature,
      bbsHeader,
      this.getPublicKey(),
      hmacKey,
      mandatoryPointers,
      featureOption,
      featureOption === 'pseudonym_issuer_pid' ? pid : undefined,
      signer_blind
    );

    // 6) Return proofValue as digital proof
    return multibase.decode(proofValue);
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#add-derived-proof-bbs-2023
   * Data Integrity BBS Cryptosuites v1.0
   * 3.4.6 - Creates a selective disclosure derived proof from a BBS base proof
   * 
   * @param document - The JSON-LD document to create a derived proof for
   * @param proof - The BBS base proof to derive from
   * @param selectivePointers - Array of JSON pointers indicating statements to selectively disclose
   * @param featureOption - The feature option to use (baseline, anonymous_holder_binding, etc)
   * @param options - Additional options including document loader
   * @param presentationHeader - Optional BBS presentation header
   * @param holderSecret - Required for anonymous_holder_binding
   * @param proverBlind - Required for anonymous_holder_binding and pseudonym_hidden_pid
   * @param verifier_id - Required for pseudonym features
   * @param pid - Required for pseudonym_hidden_pid
   * @returns The document with derived proof
   * @throws Error if proof creation fails or required parameters are missing
   */
  public static async addDerivedProof(
    document: any,
    proof: DataIntegrityProof,
    selectivePointers: string[],
    featureOption: string = 'baseline',
    options: { documentLoader?: DocumentLoader } = {},
    presentationHeader: Uint8Array = new Uint8Array(0),
    holderSecret?: string,
    proverBlind?: string, 
    verifier_id?: string,
    pid?: string
  ): Promise<VerifiableCredential> {
    try {
      // 1. Initialize bbsProof, labelMap, mandatoryIndexes, selectiveIndexes, and revealDocument
      const disclosureData = await BBSCryptosuiteManager.createDisclosureData(
        document,
        proof,
        selectivePointers,
        featureOption,
        options,
        presentationHeader,
        { holderSecret, proverBlind, verifier_id, pid }
      );

      // 2. Initialize newProof to a shallow copy of proof
      const newProof = { ...proof };

      // 3. Replace proofValue in newProof with result from serializeDerivedProofValue
      newProof.proofValue = BBSCryptosuiteManager.serializeDerivedProofValue(
        disclosureData.bbsProof,
        disclosureData.labelMap,
        disclosureData.mandatoryIndexes,
        disclosureData.selectiveIndexes,
        disclosureData.presentationHeader,
        featureOption,
        disclosureData.pseudonym
      );

      // 4. Set the "proof" property in revealDocument to newProof
      disclosureData.revealDocument.proof = newProof;

      // 5. Return revealDocument as the selectively revealed document
      return disclosureData.revealDocument;
    } catch (err: any) {
      throw wrapError(
        err,
        'https://w3id.org/security#PROOF_GENERATION_ERROR',
        'Failed to create derived proof',
        'Error generating the derived proof'
      );
    }
  }

  /**
   * https://www.w3.org/TR/vc-di-bbs/#verify-derived-proof-bbs-2023
   * Data Integrity BBS Cryptosuite v1.0
   * 3.4.7 - Verifies a derived proof according to the BBS cryptosuite specification
   * 
   * @param document - The document containing the derived proof to verify
   * @param proof - The derived proof to verify
   * @param options - Additional options including document loader
   * @returns Promise<{ verified: boolean, verifiedDocument: any | null }> 
   */
  public static async verifyDerivedProof(
    securedDocument: any,
    options: { documentLoader?: DocumentLoader } = {}
  ): Promise<{ verified: boolean, verifiedDocument: any }> {
    try {
      // 1) Let publicKeyBytes be the result of retrieving the public key bytes associated with the
      // proof.verificationMethod value
      const publicKeyBytes = await getPublicKeyFromVerificationMethod(
        securedDocument.proof.verificationMethod,
        options.documentLoader
      );

      // 2) Let unsecuredDocument be a copy of securedDocument with the proof removed
      const { proof, ...unsecuredDocument } = securedDocument;

      // 3) Let bbsProof, proofHash, mandatoryHash, selectiveIndexes, presentationHeader, nonMandatory,
      // featureOption, and possibly pseudonym and/or lengthBBSMessages be the values associated with
      // their property names in the object returned when calling createVerifyData
      const {
        bbsProof, 
        proofHash, 
        mandatoryHash, 
        selectiveIndexes,
        presentationHeader, 
        nonMandatory, 
        featureOption, 
        pseudonym, 
        lengthBBSMessages
      } = await BBSCryptosuiteManager.createVerifyData(
        unsecuredDocument,
        proof,
        options
      );

      // 4) Initialize verified to false
      let verified = false;

      // 5) Initialize bbsHeader to the concatenation of proofHash and mandatoryHash in that order
      const bbsHeader = concatBytes(proofHash, mandatoryHash);

      // 6) Set verified to the result of applying the verification algorithm below,
      // depending on the featureOption value
      switch (featureOption) {
        case 'baseline':
          verified = await bbs.verifyProof({
            ciphersuite: 'BLS12-381-SHA-256',
            publicKey: publicKeyBytes,
            proof: bbsProof,
            header: bbsHeader,
            presentationHeader: presentationHeader,
            disclosedMessages: nonMandatory,
            disclosedMessageIndexes: selectiveIndexes
          });
          break;

        case 'anonymous_holder_binding':
          throw new Error('Anonymous holder binding is not supported');
          // if (!lengthBBSMessages) {
          //   throw new ProblemDetailsError(
          //     'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          //     'Missing required parameter',
          //     'lengthBBSMessages is required for anonymous_holder_binding',
          //     -16
          //   );
          // }
          // verified = await bbs.BlindProofVerify({
          //   PK: publicKeyBytes,
          //   proof: bbsProof,
          //   header: bbsHeader,
          //   ph: presentationHeader,
          //   messages: nonMandatory,
          //   disclosed_indexes: selectiveIndexes,
          //   L: lengthBBSMessages
          // });
          break;

        case 'pseudonym':
          throw new Error('Pseudonym is not supported');
          // if (!pseudonym || !lengthBBSMessages) {
          //   throw new ProblemDetailsError(
          //     'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
          //     'Missing required parameters',
          //     'pseudonym and lengthBBSMessages are required for pseudonym features',
          //     -16
          //   );
          // }
          // verified = await bbs.ProofVerifyWithPseudonym({
          //   PK: publicKeyBytes,
          //   proof: bbsProof,
          //   header: bbsHeader,
          //   ph: presentationHeader,
          //   messages: nonMandatory,
          //   disclosed_indexes: selectiveIndexes,
          //   pseudonym: pseudonym,
          //   L: lengthBBSMessages
          // });
          break;

        default:
          throw new ProblemDetailsError(
            'https://w3id.org/security#PROOF_VERIFICATION_ERROR',
            'Unsupported feature option',
            `Feature option ${featureOption} is not supported`,
            -16
          );
      }

      // 7) Return a verification result with items:
      return {
        verified,
        verifiedDocument: verified ? unsecuredDocument : null
      };

    } catch (err: any) {
      console.error(err);
      return {
        verified: false,
        verifiedDocument: null
      }
    }
  }

  /**
   * Verifies a BBS proof according to the cryptosuite specification
   * 
   * @param document - The document containing the proof to verify
   * @param proof - The proof to verify
   * @param options - Optional verification options
   * @returns Promise<boolean> indicating if verification succeeded
   */
  public static async verifyProof(
    document: Record<string, unknown>,
    proof: DataIntegrityProof,
    options: { documentLoader?: DocumentLoader } = {}
  ): Promise<VerificationResult> {
    try {
      // Check if this is a base proof or derived proof based on the header bytes
      const {bbsHeader, bbsSignature, mandatoryPointers, publicKey} = BBSCryptosuiteManager.parseBaseProofValue(proof.proofValue);

      // Base proof headers start with 0xd9, 0x5d, followed by even numbers
      const isBaseProof = bbsHeader[0] === 0xd9 && 
                         bbsHeader[1] === 0x5d && 
                         (bbsHeader[2] & 1) === 0;

      if (isBaseProof) {
        // Verify base proof
        const publicKey = await getPublicKeyFromVerificationMethod(
          proof.verificationMethod,
          options.documentLoader
        );

        // Get the proof hash
        const proofOptions: any = { ...proof };
        delete proofOptions.proofValue;
        const proofHash = sha256(await canonize({
          '@context': document['@context'],
          ...proofOptions
        }, { documentLoader: options.documentLoader }));

        const { mandatory, nonMandatory } = await BBSCryptosuiteManager.baseProofTransformation(
          document,
          {
            type: proof.type,
            cryptosuite: proof.cryptosuite,
            verificationMethod: proof.verificationMethod,
            mandatoryPointers: mandatoryPointers,
            documentLoader: options.documentLoader
          }
        );

        // Hash mandatory statements
        const mandatoryHash = hashMandatoryNQuads(mandatory, sha256);

        // Concatenate hashes for header
        const bbsHeader = concatBytes(proofHash, mandatoryHash);
        // Convert non-mandatory statements to messages
        const messages = nonMandatory.map(nq => new TextEncoder().encode(nq));
        console.log({
          ciphersuite: 'BLS12-381-SHA-256',
          publicKey,
          signature: bbsSignature,
          header: bbsHeader,
          messages
        })

        // Verify the signature
        return await bbs.verifySignature({
          ciphersuite: 'BLS12-381-SHA-256',
          publicKey,
          signature: bbsSignature,
          header: bbsHeader,
          messages
        });

      } else {
        return await BBSCryptosuiteManager.verifyDerivedProof(document, options);
      }

    } catch (err: any) {
      console.error('Proof verification failed:', err);
      return {
        verified: false,
        errors: [err]
      };
    }
  }
}
