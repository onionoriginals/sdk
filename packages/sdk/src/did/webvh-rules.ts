/**
 * The did:webvh input rules the SDK's DID paths share: the domain, the path
 * segments, and the update keys. Moved here from DIDManager and
 * WebVHManager, which re-export them, so the browser entry
 * `@originals/sdk/did` can use them without reaching the managers' Node-only
 * persistence or the credential stack. Behaviour is unchanged.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { multikey } from '../crypto/Multikey.js';
import { StructuredError } from '../utils/telemetry.js';
import { canonicalWebVHPaths, canonicalizeWebVHDomain } from './webvh-names.js';

/**
 * Resolve the caller-supplied did:webvh domain, or throw. The SDK no longer
 * guesses one: #520 decided the *.originals.build networks are never stood up,
 * and a did:webvh domain is permanent once published — so an omitted domain
 * must fail loudly rather than mint a DID at a host nobody serves (#531). The
 * configured webvhNetwork tier deliberately does NOT supply a default here.
 *
 * A non-blank domain is canonicalized by `canonicalizeWebVHDomain`
 * (identity policy: a fully qualified DNS or punycode host, `URL#host` spelling), which
 * throws a `StructuredError` `INVALID_DOMAIN` otherwise.
 */
export function requireWebVHDomain(domain: string | undefined): string {
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    throw new StructuredError(
      'WEBVH_DOMAIN_REQUIRED',
      'A did:webvh domain is required: pass an explicit `domain` (e.g. "example.com" or ' +
      '"example.com:8443"). The SDK no longer defaults to a *.originals.build host — those ' +
      'networks are not served, and a did:webvh domain is permanent once published.'
    );
  }
  return canonicalizeWebVHDomain(domain, { identity: true });
}

/**
 * Validate and DID-encode caller-supplied decoded `paths` with the shared did:webvh rule,
 * as `StructuredError`s for the identity seams.
 */
export function requireWebVHPaths(paths: unknown): string[] {
  const result = canonicalWebVHPaths(paths);
  if (result.ok) return result.segments;
  if (result.reason === 'reserved')
    throw new StructuredError(
      'WEBVH_PATH_RESERVED',
      'The .well-known path segment is reserved: paths: [".well-known"] would host its log at /.well-known/did.jsonl, the same location as paths: []. Omit paths to publish there.'
    );
  const at = result.index === undefined ? '' : ` paths[${result.index}] is invalid;`;
  throw new StructuredError(
    'WEBVH_PATH_SEGMENT_INVALID',
    `Invalid path segment in DID paths:${at} supply an array of non-empty decoded segments, not "." or "..", with no "/", "\\", NUL, or leading/trailing whitespace.`
  );
}

/**
 * Compute the pre-rotation key hash for an update key.
 * Mirrors didwebvh-ts's internal `deriveNextKeyHash`:
 *   SHA-256(utf8(updateKey)) → prepend multihash header [0x12, 0x20] → base58btc encode (no multibase prefix).
 *
 * @param updateKey - The update key exactly as it will appear in `updateKeys`,
 *   i.e. a bare multikey string such as "z6Mk..." (didwebvh-ts >= 2.8 / did:webvh spec format)
 * @returns Base58btc-encoded multihash string suitable for use in `nextKeyHashes`
 */
export function computeNextKeyHash(updateKey: string): string {
  const data = new TextEncoder().encode(updateKey);
  const digest = sha256(data);
  // Multihash: 0x12 = sha2-256 code, 0x20 = 32 bytes (digest length)
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(digest, 2);
  return base58.encode(multihash);
}

/**
 * Normalize an update key to the bare multikey form required by
 * didwebvh-ts >= 2.8 (and the did:webvh spec): "z6Mk...".
 * Accepts legacy "did:key:z6Mk..." / "did:key:z6Mk...#z6Mk..." input and
 * strips the prefix and fragment.
 */
export function normalizeUpdateKey(key: string): string {
  if (key.startsWith('did:key:')) {
    return key.slice('did:key:'.length).split('#')[0];
  }
  return key;
}

/**
 * did:webvh log resolution in this SDK is Ed25519-only: DID-log proofs are
 * verified with Ed25519Verifier (see DIDManager.resolveDID), and per the
 * did:webvh spec each log entry must be signed by an updateKey. A DID whose
 * updateKeys are not Ed25519 would therefore sign successfully at create time
 * yet resolve to null everywhere — reject that up front.
 *
 * Note this deliberately checks ONLY updateKeys: a did:webvh document may
 * validly publish non-Ed25519 verification methods for other purposes
 * (e.g. X25519 keyAgreement) without affecting log resolvability.
 */
export function assertEd25519WebVHUpdateKeys(updateKeys: readonly string[] | undefined): void {
  for (const key of updateKeys ?? []) {
    let type: string;
    try {
      type = multikey.decodePublicKey(key).type;
    } catch (e) {
      // Caller-controlled input (createDIDWebVH's externalSigner path, and
      // every rotation/recovery entry) crossing the public SDK seam (#711):
      // needs a stable .code, not a raw Error.
      throw new StructuredError(
        'WEBVH_UPDATE_KEY_INVALID',
        `did:webvh updateKey is not a valid public multikey: ${key} (${(e as Error).message})`
      );
    }
    if (type !== 'Ed25519') {
      throw new StructuredError(
        'WEBVH_UPDATE_KEY_NOT_ED25519',
        `did:webvh only supports Ed25519 keys (resolution verifies DID logs with Ed25519); updateKey uses ${type}`
      );
    }
  }
}
