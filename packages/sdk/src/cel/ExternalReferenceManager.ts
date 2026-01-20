/**
 * External Reference Manager
 * 
 * Creates and verifies external resource references as specified in the CEL specification.
 * External references point to data outside the event log (e.g., large media files)
 * and include a cryptographic hash for content verification.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { ExternalReference } from './types';
import { computeDigestMultibase, verifyDigestMultibase } from './hash';

/**
 * Creates an external reference for content.
 * 
 * Computes a CEL-compliant digestMultibase hash from the content bytes
 * and creates an ExternalReference with the provided metadata.
 * 
 * @param content - The raw bytes of the content to reference
 * @param mediaType - The MIME type of the content (e.g., "image/png")
 * @param urls - Optional array of URLs where the content can be retrieved
 * @returns An ExternalReference object with the computed digest
 * 
 * @example
 * ```typescript
 * const imageBytes = await fs.readFile('./image.png');
 * const ref = createExternalReference(
 *   imageBytes,
 *   'image/png',
 *   ['https://example.com/image.png']
 * );
 * // Returns: { digestMultibase: "uLCA...", mediaType: "image/png", url: ["https://example.com/image.png"] }
 * ```
 */
export function createExternalReference(
  content: Uint8Array,
  mediaType: string,
  urls?: string[]
): ExternalReference {
  // Compute the CEL-compliant hash of the content
  const digestMultibase = computeDigestMultibase(content);
  
  // Build the reference object
  const ref: ExternalReference = {
    digestMultibase,
    mediaType,
  };
  
  // Only include urls if provided and non-empty
  if (urls && urls.length > 0) {
    ref.url = urls;
  }
  
  return ref;
}

/**
 * Verifies that content matches an external reference.
 * 
 * Computes the hash of the provided content and compares it
 * against the digestMultibase in the reference.
 * 
 * @param ref - The external reference to verify against
 * @param content - The raw bytes of the content to verify
 * @returns True if the content hash matches the reference digest, false otherwise
 * 
 * @example
 * ```typescript
 * const imageBytes = await fs.readFile('./image.png');
 * const ref = createExternalReference(imageBytes, 'image/png');
 * 
 * // Verify the content
 * const isValid = verifyExternalReference(ref, imageBytes); // true
 * 
 * // Modified content will fail verification
 * const modified = new Uint8Array([...imageBytes, 0]);
 * const isValid2 = verifyExternalReference(ref, modified); // false
 * ```
 */
export function verifyExternalReference(
  ref: ExternalReference,
  content: Uint8Array
): boolean {
  // Use the hash verification function to check content against digest
  return verifyDigestMultibase(content, ref.digestMultibase);
}
