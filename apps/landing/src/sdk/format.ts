/** Truncate a DID for display: keep the method + a tail for recognition. */
export function short(did: string, head = 24, tail = 6): string {
  return did.length <= head + tail + 1
    ? did
    : `${did.slice(0, head)}…${did.slice(-tail)}`;
}
