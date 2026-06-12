/**
 * CEL Event Canonicalization
 *
 * Provides a single, correct serialization for CEL event hashing and signing.
 *
 * WARNING: The pattern `JSON.stringify(x, Object.keys(x).sort())` is NOT
 * equivalent to JCS and must NOT be used here. When the second argument to
 * JSON.stringify is an array it acts as a property allowlist applied at every
 * nesting level — any key not present in the top-level key list is silently
 * dropped from nested objects. This means nested data fields, resource
 * metadata, and even `proofValue` inside a `proof` array are omitted from the
 * hash input, defeating the security properties of the hash chain.
 * Always use `canonicalizeEvent` instead.
 */

/**
 * Canonicalizes a value to JCS-style JSON (lexicographically sorted keys at
 * every nesting level) and returns UTF-8 bytes. This is the single
 * serialization used for CEL event hashing and signing.
 *
 * @param data - The value to canonicalize (any JSON-serializable type)
 * @returns UTF-8 encoded bytes of the canonical JSON representation
 */
export function canonicalizeEvent(data: unknown): Uint8Array {
  // JCS uses JSON with lexicographically sorted keys at every nesting level.
  // The replacer function recurses into every object (but leaves arrays and
  // primitives untouched), so no key at any depth is ever dropped.
  const json = JSON.stringify(data, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = value[key];
        return sorted;
      }, {});
    }
    return value;
  });
  return new TextEncoder().encode(json);
}
