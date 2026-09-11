/**
 * Previous-format (pre-CEL-3) canonicalization primitives.
 *
 * `canonicalizeEvent` and its derivatives rebuild each nested object into a
 * plain `{}` (`Object.prototype`-based) literal and assign into it by
 * bracket notation. An event whose data carries a genuine *own* `__proto__`
 * member (produced by `JSON.parse`, which — unlike assignment — creates a
 * real own property for that key) silently loses it: `sorted["__proto__"] =
 * value["__proto__"]` sets the object's prototype instead of defining a data
 * property, so the member never reaches the final `JSON.stringify`. Two
 * events that differ only in such a member canonicalize to identical bytes
 * and therefore hash and sign identically — see issue #599.
 *
 * These functions are kept byte-for-byte unchanged and reachable only from
 * this explicit compatibility subpath, not the package root: previous-format
 * signed history was produced against these exact preimages, and rewriting
 * them here would invalidate every already-signed event log rather than fix
 * anything. New code must use `@originals/cel/v3`, whose `canonicalizeValue`
 * copies into a null-prototype object (`Object.create(null)`) before
 * serializing, so an own `__proto__` member is a real key and is never lost.
 */
export {
  canonicalizeEvent,
  witnessSigningBytes,
  canonicalizeEntryForChain,
  committedFields,
  celProofSigningInput,
} from './canonicalize.js';
