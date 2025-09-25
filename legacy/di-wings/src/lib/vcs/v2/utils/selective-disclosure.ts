import { multibase } from "../../../crypto/utils/encoding";
import * as jsonld from 'jsonld';
import crypto from 'crypto';
import * as rdfCanonize from 'rdf-canonize';
import { wrapError } from "./error-utils";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from '@noble/hashes/sha256';
import { base64url } from "jose";

// Specification default recommended URN scheme to use for skolemization
const CUSTOM_URN_SCHEME = 'custom-scheme';

export type GroupDefinitions = {
  [key: string]: string[];
};

export type SelectionResult = {
  nquads: string[];
  deskolemizedNQuads: string[];
};

export type GroupResult = {
  matching: Map<number, string>;
  nonMatching: Map<number, string>;
  deskolemizedNQuads: string[];
};

export type CanonicalizeAndGroupResult = {
  groups: Map<string, GroupResult>;
  skolemizedExpandedDocument: any;
  skolemizedCompactDocument: any;
  deskolemizedNQuads: string[];
  labelMap: Map<string, string>;
  nquads: string[];
};

export interface SkolemizationResult {
  skolemizedExpandedDocument: any[];
  skolemizedCompactDocument: Record<string, unknown>;
}

/**
 * Type guard to verify if a value is a Record<string, unknown>
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips blank node prefixes from a label map
 * 
 * @param map - The label map to strip blank node prefixes from
 * @returns The label map with blank node prefixes stripped
 */
export function stripBlankNodePrefixes (map: Map<string, string>) {
  let checked = false
  const stripped = new Map()
  for (const [key, value] of map) {
    if (!checked) {
      checked = true
      if (!key.startsWith('_:')) {
        return map
      }
    }
    stripped.set(key.slice(2), value.startsWith('_:') ? value.slice(2) : value)
  }
  return stripped
}

export function createHmac (key: Uint8Array) {
  return function hmacFunc (input: Uint8Array) {
    return hmac(sha256, key, input)
  }
}

/**
 * https://www.w3.org/TR/vc-di-bbs/#createshuffledidlabelmapfunction
 * Data Integrity BBS Cryptosuites v1.0 
 * 3.2.1 - creates a label map factory function that uses an HMAC to shuffle canonical blank node identifiers.
 * 
 * @param hmacKey - The HMAC key to use for shuffling
 * @param HMAC - The HMAC function to use for shuffling
 * @returns A function that takes a label map and returns a shuffled label map
 */
export const createShuffledIdLabelMapFunction = (
  HMAC: (key: Uint8Array, ...msgs: Uint8Array[]) => Uint8Array
): ((labelMap: Map<string, string>) => Map<string, string>) => {
  // Step 1: Create labelMapFactoryFunction with required input canonicalIdMap
  return (canonicalIdMap: Map<string, string>): Map<string, string> => {
    // Step 1.1: Generate new empty bnode identifier map
    const bnodeIdMap: Map<string, string> = new Map();

    // Step 1.2: For each map entry in canonicalIdMap
    const encoder = new TextEncoder();
    for(const [input, c14nLabel] of canonicalIdMap) {
      // Step 1.2.1: Perform HMAC operation on canonical identifier from value
      const digest = HMAC(encoder.encode(c14nLabel));
      
      // Step 1.2.2: Generate b64urlDigest initialized to "u" followed by base64url-no-pad encoded digest
      const b64urlDigest = `u${base64url.encode(digest)}`;
      
      // Step 1.2.3: Add new entry to bnodeIdMap using key and b64urlDigest
      bnodeIdMap.set(input, b64urlDigest);
    }
    
    // Step 1.3: Derive shuffled mapping from bnodeIdMap
    // Step 1.3.1: Set hmacIds to sorted array of values from bnodeIdMap
    const hmacIds = Array.from(bnodeIdMap.values()).sort();
    // Step 1.3.1: Set bnodeKeys to array of keys from bnodeIdMap
    const bnodeKeys = Array.from(bnodeIdMap.keys());

    // Step 1.3.2: For each key in bnodeKeys, replace value with index position
    for(const key of bnodeKeys) {
      const index = hmacIds.indexOf(bnodeIdMap.get(key)!);
      bnodeIdMap.set(key, 'b' + index);
    }

    // Step 1.4: Return bnodeIdMap
    return bnodeIdMap;
  };
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#labelreplacementcanonicalizenquads
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.1 - Canonicalizes N-Quads and replaces blank node identifiers using a label map factory
 * 
 * @param labelMapFactoryFunction - Function to generate new blank node identifiers
 * @param deskolemizedNQuads - Array of N-Quad strings to canonicalize
 * @param options - Optional canonicalization options
 * @returns Object containing labelMap and canonicalNQuads
 * @throws Error if canonicalization fails
 */
export const labelReplacementCanonicalizeNQuads = async (
  labelMapFactoryFunction: (labelMap: Map<string, string>) => Map<string, string>,
  deskolemizedNQuads: string[],
  options?: { documentLoader?: (url: string) => Promise<{document: unknown}> }
): Promise<{
  nquads: string[];
  labelMap: Map<string, string>;
}> => {
  try {
    // Step 1: Convert N-Quads to JSON-LD
    let canonicalIdMap = new Map();
    const canonicalizedDataset = await jsonld.canonize(deskolemizedNQuads.join('\n'), {
      documentLoader: options?.documentLoader,
      inputFormat: 'application/n-quads',
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      safe: true,
      canonicalIdMap
    });

    // Step 2: Generate new blank node identifiers using factory function
    const canonicalIdMapStripped = stripBlankNodePrefixes(canonicalIdMap);
    const labelMap = labelMapFactoryFunction(canonicalIdMapStripped);
    const c14nMap = stripBlankNodePrefixes(labelMap);

    // Step 3: Replace blank node identifiers in canonical dataset
    // const canonicalNQuads = relabelBlankNodes(c14nMap, deskolemizedNQuads)
    const c14nToNewLabelMap = new Map();
    for(const [input, newLabel] of labelMap) {
      c14nToNewLabelMap.set(canonicalIdMapStripped.get(input), newLabel);
    }


    const replacer = (m: string, s1: string, label: string) => '_:' + c14nToNewLabelMap.get(label);

    // FIXME: see if `relabelBlankNodes` can be reused
    // const canonicalNQuads = relabelBlankNodes(c14nMap, canonicalizedDataset);
    const canonicalNQuads = canonicalizedDataset.split('\n').slice(0, -1)
      .map((e: any) => e.replace(/(_:([^\s]+))/g, replacer) + '\n')
      .sort();
      // FIXME: sort should be by unicode code point, not utf-16 code unit

    // Step 4: Return result
    return {
      nquads: canonicalNQuads,
      labelMap: c14nMap
    };
  } catch (err: any) {
    throw new Error(`Failed to canonicalize N-Quads: ${err.message}`);
  }
};

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#deskolemizenquads
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.6 - Replaces all custom scheme URNs in an array of N-Quad statements with blank node identifiers
 * 
 * @param inputNQuads - Array of N-Quad strings containing URNs to deskolemize
 * @param urnScheme - The URN scheme to replace
 * @returns Array of N-Quad strings with URNs replaced by blank node identifiers
 */
export const deskolemizeNQuads = (inputNQuads: string[], urnScheme: string): string[] => {
  const deskolemizedNQuads: string[] = [];
    
  for (const nquad of inputNQuads) {
    // Replace URNs with blank node identifiers (_:identifier)
    // Fix: Remove the colon from the captured identifier
    if(!nquad.includes(`<urn:${urnScheme}:`)) {
      deskolemizedNQuads.push(nquad);
    } else {
      const regex = new RegExp(`(<urn:${urnScheme}:([^>]+)>)`, 'g');
      deskolemizedNQuads.push(nquad.replace(regex, '_:$2'));
    }
    // const deskolemized = nquad.replace(new RegExp(`(<urn:${urnScheme}:([^>]+)>)`, 'g'), '_:$2');
    // deskolemizedNQuads.push(deskolemized);
  }
  
  return deskolemizedNQuads;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#skolemizeexpandedjsonld
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.7 - Replaces all blank node identifiers in an expanded JSON-LD document with custom-scheme URNs.
 * 
 * @param expanded - The expanded JSON-LD document to skolemize
 * @param urnScheme - The custom URN scheme to use for skolemization
 * @param randomString - A random string to use for generating unique identifiers
 * @param count - A shared integer for generating unique identifiers
 * @returns A promise resolving to the skolemized expanded document
 */
export function skolemizeExpandedJsonLd(
  expanded: Record<string, unknown>[],
  options: { urnScheme?: string, randomString?: string, count?: number }
): any[] {

  const localOptions = {
    urnScheme: options.urnScheme || CUSTOM_URN_SCHEME,
    randomString: options.randomString || crypto.randomUUID(),
    count: options.count || 0
  };

  // Helper function to generate identifier
  const generateId = (blankNodeId?: string): string => {
    if (blankNodeId) {
      // If we have a blank node ID, preserve it in the URN
      return `urn:${localOptions.urnScheme}:${blankNodeId}`;
    }
    
    // Generate sequential ID
    const id = `urn:${localOptions.urnScheme}:_${localOptions.randomString}_${localOptions.count}`;
    options.count = ++localOptions.count; // Update the parent options count
    return id;
  };

  // 1) Initialize skolemizedExpandedDocument to an empty array
  const skolemizedExpandedDocument: unknown[] = [];

  // 2) For each element in expanded
  for (const element of expanded) {

    // 2.1) If either element is not an object or it contains the key @value, 
    // append a copy of element to skolemizedExpandedDocument and continue to the next element
    if (typeof element !== 'object' || element['@value'] !== undefined) {
      skolemizedExpandedDocument.push(JSON.parse(JSON.stringify(element)));
      continue;
    }

    // 2.2) Otherwise, initialize skolemizedNode to an object
    const skolemizedNode: Record<string, any> = {};

    // Process properties before handling @id to ensure consistent ordering
    for (const property of Object.keys(element)) {
      if (property === '@id') continue;
      
      const value = element[property];
      
      // 2.2.1) If value is an array
      if (Array.isArray(value)) {
        skolemizedNode[property] = skolemizeExpandedJsonLd(value, localOptions);
      } else {
        // 2.2.2) Otherwise process as single value
        skolemizedNode[property] = skolemizeExpandedJsonLd(
          [value as Record<string, unknown>], 
          localOptions
        )[0];
      }
    }

    // 2.3) Handle @id property
    if (element['@id'] === undefined) {
      skolemizedNode['@id'] = generateId();
    } else if (typeof element['@id'] === 'string' && element['@id'].startsWith('_:')) {
      skolemizedNode['@id'] = generateId(element['@id'].slice(2));
    } else {
      skolemizedNode['@id'] = element['@id'];
    }

    // 2.5) Append skolemizedNode to skolemizedExpandedDocument
    skolemizedExpandedDocument.push(skolemizedNode);
  }

  // 3) Return skolemizedExpandedDocument
  return skolemizedExpandedDocument;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#skolemizecompactjsonld
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.8 - Replaces all blank node identifiers in a compact JSON-LD document with custom-scheme URNs
 * 
 * @param document - The compact JSON-LD document to skolemize
 * @param urnScheme - The custom URN scheme to use for skolemization
 * @param options - Optional JSON-LD processing options
 * @returns A promise resolving to both expanded and compact skolemized documents
 * @throws Error if JSON-LD processing fails
 */
export const skolemizeCompactJsonLd = async (
  document: Record<string, unknown>,
  urnScheme: string,
  options: { documentLoader: (url: string) => Promise<{document: unknown}> }
): Promise<SkolemizationResult> => {
  try {
    // Step 1: Expand the document using JSON-LD Expansion Algorithm
    const expanded = await jsonld.expand(document, { safe: true, documentLoader: options.documentLoader });
    // Step 2: Skolemize the expanded document
    const skolemizedExpandedDocument = skolemizeExpandedJsonLd(
      expanded,
      { urnScheme, randomString: crypto.randomUUID(), count: 0 }
    );
    // Step 3: Compact the skolemized document
    const skolemizedCompactDocument = await jsonld.compact(
      skolemizedExpandedDocument,
      document['@context'],
      { safe: true, documentLoader: options.documentLoader }
    );
    
    // Step 4: Return both documents
    return {
      skolemizedExpandedDocument,
      skolemizedCompactDocument
    };
  } catch (err: any) {
    throw wrapError(
      err,
      'https://w3id.org/security#JSONLD_PROCESSING_ERROR',
      'Failed to skolemize compact JSON-LD'
    );
  }
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#todeskolemizednquads
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.9 - Converts a skolemized JSON-LD document to an array of deskolemized N-Quads
 * 
 * @param skolemizedDocument - The skolemized JSON-LD document to convert
 * @param options - Optional JSON-LD processing options (e.g., document loader)
 * @returns Promise resolving to array of deskolemized N-Quad strings
 * @throws Error if JSON-LD processing fails
 */
export const toDeskolemizedNQuads = async (
  skolemizedDocument: Record<string, unknown>,
  options?: { documentLoader?: (url: string) => Promise<{document: unknown}> }
): Promise<string[]> => {
  try {

    // Step 1: Convert skolemized document to N-Quads format
    const skolemizedDataset = await jsonld.toRDF(skolemizedDocument, {
      format: 'application/n-quads',
      safe: true,
      ...options
    });

    if (typeof skolemizedDataset !== 'string') {
      throw new Error('JSON-LD to RDF conversion did not return a string');
    }

    // Step 2: Split into array of individual N-Quads
    const skolemizedNQuads = skolemizedDataset
      .split('\n')
      .slice(0, -1)
      .map(nq => nq + '\n');

    // Step 3: Deskolemize N-Quads using the same URN scheme used for skolemization
    const deskolemizedNQuads = deskolemizeNQuads(skolemizedNQuads, CUSTOM_URN_SCHEME);

    // Step 4: Return result
    return deskolemizedNQuads;
  } catch (err: any) {
    console.error('Error in toDeskolemizedNQuads:', err);
    console.trace('err.message')
    throw new Error(`Failed to convert to deskolemized N-Quads: ${err.message}`);
  }
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#jsonpointertopaths
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.10 - Converts a JSON Pointer to an array of paths into a JSON tree
 * 
 * @param pointer - The JSON Pointer string to convert
 * @returns Array of path segments
 */
export function jsonPointerToPaths(pointer: string): string[] {
  // 1) Initialize paths to an empty array
  const paths: string[] = [];

  // 2) Initialize splitPath to an array by splitting pointer on the "/" character 
  // and skipping the first, empty, split element
  const splitPath = pointer.split('/').slice(1);

  // 3) For each path in splitPath
  for (const path of splitPath) {
    // 3.1) If path does not include "~", then add path to paths, 
    // converting it to an integer if it parses as one, leaving it as a string if it does not
    if (!path.includes('~')) {
      const parsed = parseInt(path, 10);
      paths.push(isNaN(parsed) ? path : parsed.toString());
    } else {
      // 3.2) Otherwise, unescape any JSON pointer escape sequences in path and add the result to paths
      paths.push(path.replace(/~1/g, '/').replace(/~0/g, '~'));
    }
  }

  // 4) Return paths
  return paths;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#createinitialsection
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.11 - Creates an initial selection based on a JSON-LD object
 * 
 * @param source - The source JSON-LD document
 * @returns A new JSON-LD document fragment
 */
export function createInitialSelection(source: Record<string, unknown>): Record<string, unknown> {
  // 1) Initialize selection to an empty object
  const selection: Record<string, unknown> = {};

  // 2) If source has an id that is not a blank node identifier, set selection.id to its value
  // Check both @id and id
  const id = source['@id'] || source['id'];
  if (id && typeof id === 'string' && !id.startsWith('_:')) {
    if (source['@id']) {
      selection['@id'] = source['@id'];
    } else if (source['id']) {
      selection['id'] = source['id'];
    }
  }

  // 3) If source.type is set, set selection.type to its value
  // Check both @type and type
  if (source['@type']) {
    selection['@type'] = source['@type'];
  } else if (source['type']) {
    selection['type'] = source['type'];
  }

  // 4) Return selection
  return selection;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#selectpaths
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.12 - Selects a portion of a compact JSON-LD document using paths parsed from a JSON Pointer
 * 
 * @param document - The source JSON-LD document
 * @param paths - Array of paths parsed from a JSON Pointer
 * @param selectionDocument - The target selection document to populate
 * @param arrays - Array for tracking selected sparse arrays
 */
export function selectPaths(
  document: any,
  paths: string[],
  selectionDocument: any,
  arrays: any[]
): void {
  // 1) Initialize parentValue to document
  let parentValue = document;

  // 2) Initialize value to parentValue
  let value = parentValue;

  // 3) Initialize selectedParent to selectionDocument
  let selectedParent = selectionDocument;

  // 4) Initialize selectedValue to selectedParent
  let selectedValue = selectedParent;

  // 5) For each path in paths
  for (const path of paths) {
    // 5.1) Set selectedParent to selectedValue
    selectedParent = selectedValue;

    // 5.2) Set parentValue to value
    parentValue = value;

    // 5.3) Set value to parentValue.path. If value is now undefined, 
    // an error MUST be raised and SHOULD convey an error type of PROOF_GENERATION_ERROR,
    // indicating that the JSON pointer does not match the given document
    value = parentValue[path];
    if (value === undefined) {
      throw new Error('PROOF_GENERATION_ERROR: JSON pointer does not match the given document');
    }

    // 5.4) Set selectedValue to selectedParent.path
    selectedValue = selectedParent[path];
    
    // 5.5) If selectedValue is now undefined
    if (selectedValue === undefined) {
      // 5.5.1) If value is an array, set selectedValue to an empty array and append selectedValue to arrays
      if (Array.isArray(value)) {
        selectedValue = [];
        arrays.push(selectedValue);
      } else {
        // 5.5.2) Otherwise, set selectedValue to an initial selection passing value as source
        selectedValue = createInitialSelection(value);
      }
      // 5.5.3) Set selectedParent.path to selectedValue
      selectedParent[path] = selectedValue;
    }
  }
  
  // 6) Note: With path traversal complete at the target value, the selected value will now be computed
  // 7) If value is a literal, set selectedValue to value
  if (typeof value !== 'object' || value === null) {
    selectedValue = value;
  }
  // 8) If value is an array, Set selectedValue to a copy of value
  else if (Array.isArray(value)) {
    
    selectedValue = [...value];
  }

  // 9) In all other cases, set selectedValue to an object that merges a shallow copy of selectedValue
  // with a deep copy of value
  else {
    selectedValue = {
      ...selectedValue,
      ...JSON.parse(JSON.stringify(value))
    };
  }

  // 10) Get the last path, lastPath, from paths
  const lastPath = paths[paths.length - 1];

  // 11) Set selectedParent.lastPath to selectedValue
  selectedParent[lastPath] = selectedValue;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#selectjsonld
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.13 - Selects portions of a JSON-LD document using JSON Pointers
 * 
 * @param pointers - Array of JSON Pointers to select
 * @param document - The JSON-LD document to select from
 * @returns Selected JSON-LD document
 */
export function selectJsonLd(
  pointers: string[],
  document: Record<string, unknown>
): Record<string, unknown> | null {
  // 1) If pointers is empty, return null. This indicates nothing has been selected from the original document.
  if (pointers.length === 0) {
    return null;
  }

  // 2) Initialize arrays to an empty array. This variable will be used to track selected sparse arrays 
  // to make them dense after all pointers have been processed.
  const arrays: any[] = [];

  // 3) Initialize selectionDocument to an initial selection passing document as source
  const selectionDocument = createInitialSelection(document);

  // 4) Set the value of the @context property in selectionDocument to a copy of the value of the @context property in document
  selectionDocument['@context'] = document['@context'];

  // 5) For each pointer in pointers, walk the document from root to the pointer target value, building the selectionDocument
  for (const pointer of pointers) {
    // 5.1) Parse the pointer into an array of paths, paths, using the algorithm in Section 3.4.10 jsonPointerToPaths
    const paths = jsonPointerToPaths(pointer);
    // 5.2) Use the algorithm in Section 3.4.12 selectPaths, passing document, paths, selectionDocument, and arrays
    selectPaths(document, paths, selectionDocument, arrays);
  }

  // 6) For each array in arrays
  for (const array of arrays) {
    // 6.1) Make array dense by removing any undefined elements between elements that are defined
    const dense = array.filter((item: any) => item !== undefined);
    array.length = 0;
    array.push(...dense);
  }
  // 7) Return selectionDocument
  return selectionDocument;
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#relabelblanknodes
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.14 - Replaces blank node identifiers in N-Quads using a label map
 * 
 * @param labelMap - Map of original to new blank node identifiers
 * @param nquads - Array of N-Quad strings to relabel
 * @returns Array of relabeled N-Quad strings
 */
export function relabelBlankNodes(
  labelMap: Map<string, string>,
  nquads: string[]
): string[] {
    return nquads.map(nquad => {
      let relabeled = nquad;
      for (const [oldId, newId] of labelMap.entries()) {
        const oldBNode = `_:${oldId}`;
        const newBNode = `_:${newId}`;
        relabeled = relabeled.replace(
          new RegExp(`\\b${oldBNode}\\b`, 'g'),
          newBNode
        );
      }
      return relabeled;
    });
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#selectcanonicalnquads
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.15 - Selects a portion of a skolemized compact JSON-LD document using JSON Pointers.
 * 
 * @param pointers - Array of JSON Pointers to select
 * @param labelMap - Map of blank node identifiers
 * @param document - Skolemized compact JSON-LD document
 * @param options - Optional JSON-LD processing options
 * @returns Object containing selection results
 */
export const selectCanonicalNQuads = async (
  pointers: string[],
  labelMap: Map<string, string>,
  document: Record<string, unknown>,
  options?: { documentLoader?: (url: string) => Promise<{document: unknown}> }
): Promise<SelectionResult> => {
  try {
    
    // Step 1: Select portions of the document using JSON Pointers
    const selectionDocument = selectJsonLd(pointers, document);
    if (selectionDocument === null) {
      return {
        nquads: [],
        deskolemizedNQuads: []
      }
    }
    
    
    // Step 2: Convert selection to deskolemized N-Quads
    const deskolemizedNQuads = await toDeskolemizedNQuads(
      selectionDocument,
      options
    );
    
    // Step 3: Relabel blank nodes using the provided label map
    const nquads = relabelBlankNodes(labelMap, deskolemizedNQuads);

    return {
      nquads,
      deskolemizedNQuads
    };
  } catch (err: any) {
    throw new Error(`Failed to select canonical N-Quads: ${err.message}`);
  }
};

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#canonicalizeandgroup
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.16 - Canonicalizes a document and groups N-Quads based on JSON pointers.
 * 
 * @param document - The document to canonicalize and group
 * @param labelMapFactoryFunction - A function that creates a label map factory
 * @param groupDefinitions - The group definitions to use for grouping
 * @param options - Optional JSON-LD processing options
 * @returns Promise<CanonicalizeAndGroupResult> - A promise resolving to the canonicalized and grouped result
 * @throws Error if JSON-LD processing fails
 */
export const canonicalizeAndGroup = async (
  document: any,
  labelMapFactoryFunction: (labelMap: Map<string, string>) => Map<string, string>,
  groupDefinitions: GroupDefinitions,
  options: { documentLoader: (url: string) => Promise<{document: unknown}> }
): Promise<CanonicalizeAndGroupResult> => {
  // Step 1: Skolemize the document
  const { skolemizedExpandedDocument, skolemizedCompactDocument } = 
    await skolemizeCompactJsonLd(document, CUSTOM_URN_SCHEME, options);
    // Step 2: Convert to deskolemized N-Quads
  const deskolemizedNQuads = 
    await toDeskolemizedNQuads(skolemizedCompactDocument, options);
  
    // Step 3: Canonicalize N-Quads with label replacement
  let { nquads, labelMap } = 
    await labelReplacementCanonicalizeNQuads(labelMapFactoryFunction, deskolemizedNQuads, options);
  // SORT HERE?
  // nquads = nquads.slice(0, -1).sort();

  labelMap = stripBlankNodePrefixes(labelMap);
  // Step 4-5: Process selections for each group
  const selections = new Map<string, SelectionResult>();
  for (const [name, pointers] of Object.entries(groupDefinitions)) {
    
    selections.set(name, await selectCanonicalNQuads(
      pointers,
      labelMap,
      skolemizedCompactDocument,
      options
    ));
  }

  // Step 6-7: Create groups
  const groups: Map<string, GroupResult> = new Map();
  for (const [name, selectionResult] of selections.entries()) {
    const matching = new Map<number, string>();
    const nonMatching = new Map<number, string>();
    const selectedNQuads = selectionResult.nquads;
    const selectedDeskolemizedNQuads = selectionResult.deskolemizedNQuads;

    // Process each N-Quad
    nquads.forEach((nq, index) => {
      if (selectedNQuads.includes(nq)) {
        matching.set(index, nq);
      } else {
        nonMatching.set(index, nq);
      }
    });

    groups.set(name, {
      matching,
      nonMatching,
      deskolemizedNQuads: selectedDeskolemizedNQuads
    });
  }
  // Step 8: Return result
  return {
    groups,
    skolemizedExpandedDocument,
    skolemizedCompactDocument,
    deskolemizedNQuads,
    labelMap,
    nquads
  };
};

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#hashmandatorynquads
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.17 - Hashes the mandatory N-Quads using a hash function
 * 
 * @param nquads - The N-Quads to hash
 * @param hash - The hashing function to use
 * @returns The hash of the N-Quads
 */
export const hashMandatoryNQuads = (nquads: string[], hash: (val: string) => Uint8Array): Uint8Array => {
  return hash(nquads.join(''));
}

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#labelreplacementcanonicalizejsonld
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.2 - Canonicalizes a JSON-LD document and replaces blank node identifiers
 * 
 * @param document - The JSON-LD document to canonicalize
 * @param labelMapFactoryFunction - Function to generate new blank node identifiers
 * @param options - Optional JSON-LD processing options
 * @returns Promise resolving to canonicalized N-Quads and label map
 * @throws Error if canonicalization fails
 */
export const labelReplacementCanonicalizeJsonLd = async (
  document: any,
  labelMapFactoryFunction: (labelMap: Map<string, string>) => Map<string, string>,
  options?: { documentLoader?: (url: string) => Promise<any> }
): Promise<{
  nquads: string[];
  labelMap: Map<string, string>;
}> => {
  try {
    // 1) Deserialize the JSON-LD document to RDF, rdf, using the Deserialize JSON-LD to RDF algorithm
    const rdf = await jsonld.toRDF(document, {
      format: 'application/n-quads',
      ...options
    });

    if (typeof rdf !== 'string') {
      throw new Error('RDF canonization did not return a string');
    }

    // 2) Serialize rdf to an array of N-Quad strings, nquads
    const nquads = rdf
      .trim()
      .split('\n')
      .filter(nquad => nquad.length > 0);

    // 3) Return the result of calling labelReplacementCanonicalizeNQuads,
    // passing nquads, labelMapFactoryFunction, and any custom options
    return await labelReplacementCanonicalizeNQuads(
      labelMapFactoryFunction,
      nquads,
      options
    );

  } catch (err: any) {
    throw new Error(`Failed to canonicalize JSON-LD: ${err.message}`);
  }
};

/**
 * https://www.w3.org/TR/vc-di-ecdsa/#createlabelmapfunction
 * Data Integrity ECDSA Cryptosuites v1.0
 * 3.4.3 - Creates a label map factory function that uses an input label map to replace canonical blank node identifiers
 * 
 * @param labelMap - Map of original to new blank node identifiers
 * @returns Function that takes a canonical ID map and returns a new blank node identifier map
 */
export const createLabelMapFunction = (
  labelMap: Map<string, string>
): ((canonicalIdMap: Map<string, string>) => Map<string, string>) => {
  return (canonicalIdMap: Map<string, string>): Map<string, string> => {
    // Step 1: Generate a new empty bnode identifier map
    const bnodeIdMap = new Map<string, string>();
    // Step 2: For each map entry in canonicalIdMap
    canonicalIdMap.forEach((value, key) => {
      // Step 2.1: Use the canonical identifier from the value as a key in labelMap
      const newLabel = labelMap.get(value);
      
      // Step 2.2: Add a new entry to bnodeIdMap using the key from entry and newLabel
      if (newLabel !== undefined) {
        bnodeIdMap.set(key, newLabel);
      }
    });
    
    // Step 3: Return bnodeIdMap
    return bnodeIdMap;
  };
};