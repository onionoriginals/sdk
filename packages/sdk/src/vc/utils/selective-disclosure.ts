/**
 * Selective disclosure helpers for the Data Integrity BBS / ECDSA cryptosuites.
 *
 * Ported from aviarytech/di-wings (src/lib/vcs/v2/utils/selective-disclosure.ts)
 * and adapted to the Originals SDK: jose's base64url is replaced with a local
 * helper and Node's `crypto.randomUUID` is used for skolemization nonces.
 *
 * Algorithm step numbers reference the W3C VC Data Integrity ECDSA/BBS specs.
 */
import jsonld from 'jsonld';
import crypto from 'crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Specification default recommended URN scheme to use for skolemization
const CUSTOM_URN_SCHEME = 'custom-scheme';

/** base64url-no-pad encoding (replaces jose's base64url.encode). */
function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

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
 * Strips blank node prefixes from a label map.
 */
export function stripBlankNodePrefixes(map: Map<string, string>): Map<string, string> {
  let checked = false;
  const stripped = new Map<string, string>();
  for (const [key, value] of map) {
    if (!checked) {
      checked = true;
      if (!key.startsWith('_:')) {
        return map;
      }
    }
    stripped.set(key.slice(2), value.startsWith('_:') ? value.slice(2) : value);
  }
  return stripped;
}

export function createHmac(key: Uint8Array): (input: Uint8Array) => Uint8Array {
  return function hmacFunc(input: Uint8Array) {
    return hmac(sha256, key, input);
  };
}

/**
 * 3.2.1 createShuffledIdLabelMapFunction — creates a label map factory function
 * that uses an HMAC to shuffle canonical blank node identifiers.
 */
export const createShuffledIdLabelMapFunction = (
  HMAC: (input: Uint8Array) => Uint8Array
): ((labelMap: Map<string, string>) => Map<string, string>) => {
  return (canonicalIdMap: Map<string, string>): Map<string, string> => {
    const bnodeIdMap: Map<string, string> = new Map();

    const encoder = new TextEncoder();
    for (const [input, c14nLabel] of canonicalIdMap) {
      const digest = HMAC(encoder.encode(c14nLabel));
      const b64urlDigest = `u${base64urlEncode(digest)}`;
      bnodeIdMap.set(input, b64urlDigest);
    }

    const hmacIds = Array.from(bnodeIdMap.values()).sort();
    const bnodeKeys = Array.from(bnodeIdMap.keys());

    for (const key of bnodeKeys) {
      const index = hmacIds.indexOf(bnodeIdMap.get(key)!);
      bnodeIdMap.set(key, 'b' + index);
    }

    return bnodeIdMap;
  };
};

/**
 * 3.4.1 labelReplacementCanonicalizeNQuads — canonicalizes N-Quads and replaces
 * blank node identifiers using a label map factory.
 */
export const labelReplacementCanonicalizeNQuads = async (
  labelMapFactoryFunction: (labelMap: Map<string, string>) => Map<string, string>,
  deskolemizedNQuads: string[],
  options?: { documentLoader?: (url: string) => Promise<{ document: unknown }> }
): Promise<{
  nquads: string[];
  labelMap: Map<string, string>;
}> => {
  try {
    const canonicalIdMap = new Map<string, string>();
    const canonicalizedDataset = await jsonld.canonize(deskolemizedNQuads.join('\n'), {
      documentLoader: options?.documentLoader,
      inputFormat: 'application/n-quads',
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      safe: true,
      canonicalIdMap
    } as any);

    const canonicalIdMapStripped = stripBlankNodePrefixes(canonicalIdMap);
    const labelMap = labelMapFactoryFunction(canonicalIdMapStripped);
    const c14nMap = stripBlankNodePrefixes(labelMap);

    const c14nToNewLabelMap = new Map<string, string>();
    for (const [input, newLabel] of labelMap) {
      c14nToNewLabelMap.set(canonicalIdMapStripped.get(input)!, newLabel);
    }

    // Only relabel blank nodes in term position (line start or after whitespace);
    // this avoids rewriting "_:..."-looking text inside quoted literal values.
    // Leave any label not in the canonical map untouched rather than emitting
    // "_:undefined".
    const replacer = (_m: string, pre: string, label: string) =>
      pre + '_:' + (c14nToNewLabelMap.get(label) ?? label);

    const canonicalNQuads = (canonicalizedDataset as string)
      .split('\n')
      .slice(0, -1)
      .map((e: string) => e.replace(/(^|\s)_:([^\s]+)/g, replacer) + '\n')
      .sort();

    return {
      nquads: canonicalNQuads,
      labelMap: c14nMap
    };
  } catch (err: any) {
    throw new Error(`Failed to canonicalize N-Quads: ${err.message}`);
  }
};

/**
 * 3.4.6 deskolemizeNQuads — replaces all custom-scheme URNs in an array of
 * N-Quad statements with blank node identifiers.
 */
export const deskolemizeNQuads = (inputNQuads: string[], urnScheme: string): string[] => {
  const deskolemizedNQuads: string[] = [];

  for (const nquad of inputNQuads) {
    if (!nquad.includes(`<urn:${urnScheme}:`)) {
      deskolemizedNQuads.push(nquad);
    } else {
      const regex = new RegExp(`(<urn:${urnScheme}:([^>]+)>)`, 'g');
      deskolemizedNQuads.push(nquad.replace(regex, '_:$2'));
    }
  }

  return deskolemizedNQuads;
};

/**
 * 3.4.7 skolemizeExpandedJsonLd — replaces all blank node identifiers in an
 * expanded JSON-LD document with custom-scheme URNs.
 */
export function skolemizeExpandedJsonLd(
  expanded: Record<string, unknown>[],
  options: { urnScheme?: string; randomString?: string; count?: number }
): any[] {
  const localOptions = {
    urnScheme: options.urnScheme || CUSTOM_URN_SCHEME,
    randomString: options.randomString || crypto.randomUUID(),
    count: options.count || 0
  };

  const generateId = (blankNodeId?: string): string => {
    if (blankNodeId) {
      return `urn:${localOptions.urnScheme}:${blankNodeId}`;
    }
    const id = `urn:${localOptions.urnScheme}:_${localOptions.randomString}_${localOptions.count}`;
    options.count = ++localOptions.count; // Update the parent options count
    return id;
  };

  const skolemizedExpandedDocument: unknown[] = [];

  for (const element of expanded) {
    if (typeof element !== 'object' || (element as any)['@value'] !== undefined) {
      skolemizedExpandedDocument.push(JSON.parse(JSON.stringify(element)));
      continue;
    }

    const skolemizedNode: Record<string, any> = {};

    for (const property of Object.keys(element)) {
      if (property === '@id') continue;

      const value = (element as any)[property];

      if (Array.isArray(value)) {
        skolemizedNode[property] = skolemizeExpandedJsonLd(value, localOptions);
      } else {
        skolemizedNode[property] = skolemizeExpandedJsonLd(
          [value as Record<string, unknown>],
          localOptions
        )[0];
      }
    }

    if ((element as any)['@id'] === undefined) {
      skolemizedNode['@id'] = generateId();
    } else if (typeof (element as any)['@id'] === 'string' && (element as any)['@id'].startsWith('_:')) {
      skolemizedNode['@id'] = generateId((element as any)['@id'].slice(2));
    } else {
      skolemizedNode['@id'] = (element as any)['@id'];
    }

    skolemizedExpandedDocument.push(skolemizedNode);
  }

  return skolemizedExpandedDocument;
}

/**
 * 3.4.8 skolemizeCompactJsonLd — replaces all blank node identifiers in a
 * compact JSON-LD document with custom-scheme URNs.
 */
export const skolemizeCompactJsonLd = async (
  document: Record<string, unknown>,
  urnScheme: string,
  options: { documentLoader: (url: string) => Promise<{ document: unknown }> }
): Promise<SkolemizationResult> => {
  try {
    const expanded = await jsonld.expand(document, { safe: true, documentLoader: options.documentLoader } as any);
    const skolemizedExpandedDocument = skolemizeExpandedJsonLd(
      expanded as Record<string, unknown>[],
      { urnScheme, randomString: crypto.randomUUID(), count: 0 }
    );
    const skolemizedCompactDocument = await jsonld.compact(
      skolemizedExpandedDocument,
      document['@context'] as any,
      { safe: true, documentLoader: options.documentLoader } as any
    );

    return {
      skolemizedExpandedDocument,
      skolemizedCompactDocument: skolemizedCompactDocument as Record<string, unknown>
    };
  } catch (err: any) {
    throw new Error(`Failed to skolemize compact JSON-LD: ${err.message}`);
  }
};

/**
 * 3.4.9 toDeskolemizedNQuads — converts a skolemized JSON-LD document to an
 * array of deskolemized N-Quads.
 */
export const toDeskolemizedNQuads = async (
  skolemizedDocument: Record<string, unknown>,
  options?: { documentLoader?: (url: string) => Promise<{ document: unknown }> }
): Promise<string[]> => {
  try {
    const skolemizedDataset = await jsonld.toRDF(skolemizedDocument, {
      format: 'application/n-quads',
      safe: true,
      ...options
    } as any);

    if (typeof skolemizedDataset !== 'string') {
      throw new Error('JSON-LD to RDF conversion did not return a string');
    }

    const skolemizedNQuads = skolemizedDataset
      .split('\n')
      .slice(0, -1)
      .map(nq => nq + '\n');

    return deskolemizeNQuads(skolemizedNQuads, CUSTOM_URN_SCHEME);
  } catch (err: any) {
    throw new Error(`Failed to convert to deskolemized N-Quads: ${err.message}`);
  }
};

/**
 * 3.4.10 jsonPointerToPaths — converts a JSON Pointer to an array of paths.
 */
export function jsonPointerToPaths(pointer: string): string[] {
  const paths: string[] = [];
  const splitPath = pointer.split('/').slice(1);

  for (const path of splitPath) {
    if (!path.includes('~')) {
      const parsed = parseInt(path, 10);
      paths.push(isNaN(parsed) ? path : parsed.toString());
    } else {
      paths.push(path.replace(/~1/g, '/').replace(/~0/g, '~'));
    }
  }

  return paths;
}

/**
 * 3.4.11 createInitialSelection — creates an initial selection from a JSON-LD object.
 */
export function createInitialSelection(source: Record<string, unknown>): Record<string, unknown> {
  const selection: Record<string, unknown> = {};

  const id = source['@id'] || source['id'];
  if (id && typeof id === 'string' && !id.startsWith('_:')) {
    if (source['@id']) {
      selection['@id'] = source['@id'];
    } else if (source['id']) {
      selection['id'] = source['id'];
    }
  }

  if (source['@type']) {
    selection['@type'] = source['@type'];
  } else if (source['type']) {
    selection['type'] = source['type'];
  }

  return selection;
}

/**
 * 3.4.12 selectPaths — selects a portion of a compact JSON-LD document using
 * paths parsed from a JSON Pointer.
 */
export function selectPaths(
  document: any,
  paths: string[],
  selectionDocument: any,
  arrays: any[]
): void {
  let parentValue = document;
  let value = parentValue;
  let selectedParent = selectionDocument;
  let selectedValue = selectedParent;

  for (const path of paths) {
    selectedParent = selectedValue;
    parentValue = value;

    value = parentValue[path];
    if (value === undefined) {
      throw new Error('PROOF_GENERATION_ERROR: JSON pointer does not match the given document');
    }

    selectedValue = selectedParent[path];

    if (selectedValue === undefined) {
      if (Array.isArray(value)) {
        selectedValue = [];
        arrays.push(selectedValue);
      } else {
        selectedValue = createInitialSelection(value);
      }
      selectedParent[path] = selectedValue;
    }
  }

  if (typeof value !== 'object' || value === null) {
    selectedValue = value;
  } else if (Array.isArray(value)) {
    selectedValue = [...value];
  } else {
    selectedValue = {
      ...selectedValue,
      ...JSON.parse(JSON.stringify(value))
    };
  }

  const lastPath = paths[paths.length - 1];
  selectedParent[lastPath] = selectedValue;
}

/**
 * 3.4.13 selectJsonLd — selects portions of a JSON-LD document using JSON Pointers.
 */
export function selectJsonLd(
  pointers: string[],
  document: Record<string, unknown>
): Record<string, unknown> | null {
  if (pointers.length === 0) {
    return null;
  }

  const arrays: any[] = [];
  const selectionDocument = createInitialSelection(document);
  selectionDocument['@context'] = document['@context'];

  for (const pointer of pointers) {
    const paths = jsonPointerToPaths(pointer);
    selectPaths(document, paths, selectionDocument, arrays);
  }

  for (const array of arrays) {
    const dense = array.filter((item: any) => item !== undefined);
    array.length = 0;
    array.push(...dense);
  }

  return selectionDocument;
}

/**
 * 3.4.14 relabelBlankNodes — replaces blank node identifiers in N-Quads using a label map.
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
      relabeled = relabeled.replace(new RegExp(`\\b${oldBNode}\\b`, 'g'), newBNode);
    }
    return relabeled;
  });
}

/**
 * 3.4.15 selectCanonicalNQuads — selects a portion of a skolemized compact
 * JSON-LD document using JSON Pointers.
 */
export const selectCanonicalNQuads = async (
  pointers: string[],
  labelMap: Map<string, string>,
  document: Record<string, unknown>,
  options?: { documentLoader?: (url: string) => Promise<{ document: unknown }> }
): Promise<SelectionResult> => {
  try {
    const selectionDocument = selectJsonLd(pointers, document);
    if (selectionDocument === null) {
      return { nquads: [], deskolemizedNQuads: [] };
    }

    const deskolemizedNQuads = await toDeskolemizedNQuads(selectionDocument, options);
    const nquads = relabelBlankNodes(labelMap, deskolemizedNQuads);

    return { nquads, deskolemizedNQuads };
  } catch (err: any) {
    throw new Error(`Failed to select canonical N-Quads: ${err.message}`);
  }
};

/**
 * 3.4.16 canonicalizeAndGroup — canonicalizes a document and groups N-Quads
 * based on JSON pointers.
 */
export const canonicalizeAndGroup = async (
  document: any,
  labelMapFactoryFunction: (labelMap: Map<string, string>) => Map<string, string>,
  groupDefinitions: GroupDefinitions,
  options: { documentLoader: (url: string) => Promise<{ document: unknown }> }
): Promise<CanonicalizeAndGroupResult> => {
  const { skolemizedExpandedDocument, skolemizedCompactDocument } =
    await skolemizeCompactJsonLd(document, CUSTOM_URN_SCHEME, options);
  const deskolemizedNQuads = await toDeskolemizedNQuads(skolemizedCompactDocument, options);

  let { nquads, labelMap } =
    await labelReplacementCanonicalizeNQuads(labelMapFactoryFunction, deskolemizedNQuads, options);

  labelMap = stripBlankNodePrefixes(labelMap);
  const selections = new Map<string, SelectionResult>();
  for (const [name, pointers] of Object.entries(groupDefinitions)) {
    selections.set(name, await selectCanonicalNQuads(
      pointers,
      labelMap,
      skolemizedCompactDocument,
      options
    ));
  }

  const groups: Map<string, GroupResult> = new Map();
  for (const [name, selectionResult] of selections.entries()) {
    const matching = new Map<number, string>();
    const nonMatching = new Map<number, string>();
    const selectedNQuads = selectionResult.nquads;
    const selectedDeskolemizedNQuads = selectionResult.deskolemizedNQuads;

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
 * 3.4.17 hashMandatoryNQuads — hashes the mandatory N-Quads using a hash function.
 */
export const hashMandatoryNQuads = (
  nquads: string[],
  hash: (val: string) => Uint8Array
): Uint8Array => {
  return hash(nquads.join(''));
};

/**
 * 3.4.2 labelReplacementCanonicalizeJsonLd — canonicalizes a JSON-LD document
 * and replaces blank node identifiers.
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
    const rdf = await jsonld.toRDF(document, {
      format: 'application/n-quads',
      ...options
    } as any);

    if (typeof rdf !== 'string') {
      throw new Error('RDF canonization did not return a string');
    }

    const nquads = rdf
      .trim()
      .split('\n')
      .filter(nquad => nquad.length > 0);

    return await labelReplacementCanonicalizeNQuads(labelMapFactoryFunction, nquads, options);
  } catch (err: any) {
    throw new Error(`Failed to canonicalize JSON-LD: ${err.message}`);
  }
};

/**
 * 3.4.3 createLabelMapFunction — creates a label map factory function that uses
 * an input label map to replace canonical blank node identifiers.
 */
export const createLabelMapFunction = (
  labelMap: Map<string, string>
): ((canonicalIdMap: Map<string, string>) => Map<string, string>) => {
  return (canonicalIdMap: Map<string, string>): Map<string, string> => {
    const bnodeIdMap = new Map<string, string>();
    canonicalIdMap.forEach((value, key) => {
      const newLabel = labelMap.get(value);
      if (newLabel !== undefined) {
        bnodeIdMap.set(key, newLabel);
      }
    });
    return bnodeIdMap;
  };
};
