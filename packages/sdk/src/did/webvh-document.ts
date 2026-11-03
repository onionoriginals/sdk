/**
 * DID document construction for didwebvh-ts >= 3.
 *
 * didwebvh-ts 3 takes the complete DID document from the caller
 * (`didDocument`) instead of assembling one from `verificationMethods`,
 * `authentication`, `services`, `alsoKnownAs` and friends, as 2.x did. The
 * SDK keeps its option-shaped API, so this module rebuilds the document with
 * the 2.8.0 rules, unchanged:
 *
 * - `@context` defaults to the DID and Multikey contexts;
 * - `id` and the top-level `controller` are the DID being written;
 * - a verification method without `id` gets `<DID>#<last 8 chars of its key>`,
 *   and one without `controller` is controlled by the DID;
 * - relationship arrays are derived from each method's `purpose` (no purpose
 *   means `authentication`), then explicit `authentication`,
 *   `assertionMethod` and `keyAgreement` options replace them;
 * - `secretKeyMultibase` is stripped, with a warning, before publication.
 *
 * The DID is not known before creation (its SCID hashes the first entry), so
 * the document names it with the library's `{DID}` placeholder, which
 * didwebvh-ts replaces with the final DID.
 */

import { StructuredError } from '../utils/telemetry.js';

/** Placeholder didwebvh-ts 3 substitutes with the DID being written. */
export const WEBVH_DID_PLACEHOLDER = '{DID}';

const DEFAULT_CONTEXT = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];

type Relationship =
  | 'authentication'
  | 'assertionMethod'
  | 'keyAgreement'
  | 'capabilityDelegation'
  | 'capabilityInvocation';

/** A verification method as the SDK accepts it on create and update. */
export interface WebVHVerificationMethodInput {
  id?: string;
  type: string;
  controller?: string;
  publicKeyMultibase?: string;
  secretKeyMultibase?: string;
  purpose?: Relationship;
}

/** The option-shaped document fields the SDK's create and update APIs take. */
export interface WebVHDocumentFields {
  verificationMethods?: WebVHVerificationMethodInput[];
  context?: unknown;
  alsoKnownAs?: string[];
  services?: unknown[];
  /** Relationship entries: references, or embedded verification methods. */
  authentication?: unknown[];
  assertionMethod?: unknown[];
  keyAgreement?: unknown[];
  /** Update only: replaces the top-level `controller`. */
  controller?: string;
}

type Document = Record<string, unknown>;

function stripSecretKeys(vms: WebVHVerificationMethodInput[]): WebVHVerificationMethodInput[] {
  return vms.map((vm) => {
    if (vm.secretKeyMultibase === undefined) return vm;
    console.warn(
      'Warning: Removing secretKeyMultibase from verification method - secret keys should not be stored in DID documents'
    );
    const { secretKeyMultibase: _secret, ...safe } = vm;
    return safe;
  });
}

function randomFragment(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** didwebvh-ts 2.8.0 `normalizeVMs`, with the DID as a placeholder. */
function normalizeVerificationMethods(
  input: WebVHVerificationMethodInput[]
): { verificationMethod: WebVHVerificationMethodInput[] } & Record<Relationship, string[]> {
  const vms = stripSecretKeys(input);
  vms.forEach((vm, i) => {
    // didwebvh-ts 3 requires an explicit, non-empty controller on every
    // published method (2.8.0 published an empty string verbatim, #804).
    // Omit it to have the DID control the method.
    if (vm.controller !== undefined && (typeof vm.controller !== 'string' || vm.controller.trim() === '')) {
      throw new StructuredError(
        'WEBVH_VERIFICATION_METHOD_CONTROLLER_INVALID',
        `verificationMethods[${i}].controller must be a non-empty DID, or omitted so the DID being written controls it`
      );
    }
  });
  // Assign each id once so a generated fallback is the same in the
  // verification method and in every relationship that names it.
  const ids = vms.map(
    (vm) => vm.id ?? `${WEBVH_DID_PLACEHOLDER}#${vm.publicKeyMultibase?.slice(-8) || randomFragment()}`
  );
  const relationship = (match: (vm: WebVHVerificationMethodInput) => boolean): string[] =>
    vms.flatMap((vm, i) => (match(vm) ? [ids[i]] : []));
  return {
    verificationMethod: vms.map((vm, i) => ({
      ...vm,
      id: ids[i],
      controller: vm.controller ?? WEBVH_DID_PLACEHOLDER,
    })),
    authentication: relationship((vm) => !vm.purpose || vm.purpose === 'authentication'),
    assertionMethod: relationship((vm) => vm.purpose === 'assertionMethod'),
    keyAgreement: relationship((vm) => vm.purpose === 'keyAgreement'),
    capabilityDelegation: relationship((vm) => vm.purpose === 'capabilityDelegation'),
    capabilityInvocation: relationship((vm) => vm.purpose === 'capabilityInvocation'),
  };
}

function applyOverrides(doc: Document, fields: WebVHDocumentFields): void {
  if (fields.services !== undefined) doc.service = fields.services;
  if (fields.authentication !== undefined) doc.authentication = fields.authentication;
  if (fields.assertionMethod !== undefined) doc.assertionMethod = fields.assertionMethod;
  if (fields.keyAgreement !== undefined) doc.keyAgreement = fields.keyAgreement;
  if (fields.alsoKnownAs !== undefined) doc.alsoKnownAs = fields.alsoKnownAs;
}

/**
 * The complete genesis document for didwebvh-ts 3 `createDID`. As in 2.8.0,
 * a caller-supplied `controller` is ignored on create: the controller is the
 * DID being minted.
 */
export function buildWebVHCreateDocument(fields: WebVHDocumentFields): Document {
  if (!fields.verificationMethods || fields.verificationMethods.length === 0) {
    throw new Error('verificationMethods must be provided when didDocument is not supplied');
  }
  const doc: Document = {
    '@context': fields.context || DEFAULT_CONTEXT,
    id: WEBVH_DID_PLACEHOLDER,
    controller: WEBVH_DID_PLACEHOLDER,
    ...normalizeVerificationMethods(fields.verificationMethods),
  };
  applyOverrides(doc, fields);
  return doc;
}

const DOCUMENT_FIELDS: (keyof WebVHDocumentFields)[] = [
  'verificationMethods',
  'context',
  'alsoKnownAs',
  'services',
  'authentication',
  'assertionMethod',
  'keyAgreement',
  'controller',
];

/**
 * The complete next document for didwebvh-ts 3 `updateDID`, merged onto the
 * previous state with the 2.8.0 rules: supplying `verificationMethods`
 * replaces the methods and all five relationship arrays, and every other
 * supplied field replaces its property.
 *
 * Returns `undefined` when no document field is supplied, so didwebvh-ts
 * carries the previous state forward itself (and rewrites self-references on
 * a move of a portable DID).
 */
export function buildWebVHUpdateDocument(
  previousState: Document,
  fields: WebVHDocumentFields
): Document | undefined {
  if (!DOCUMENT_FIELDS.some((key) => fields[key] !== undefined)) return undefined;
  const doc: Document = structuredClone(previousState);
  doc['@context'] = fields.context || previousState['@context'];
  doc.id = WEBVH_DID_PLACEHOLDER;
  doc.controller = fields.controller ?? WEBVH_DID_PLACEHOLDER;
  if (fields.verificationMethods !== undefined) {
    Object.assign(doc, normalizeVerificationMethods(fields.verificationMethods));
  }
  applyOverrides(doc, fields);
  return doc;
}
