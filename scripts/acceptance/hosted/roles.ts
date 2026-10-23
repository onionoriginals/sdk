/** Small helpers for reading DID logs in the hosted acceptance phases. */
export interface LogEntry {
  versionId: string;
  parameters?: { updateKeys?: string[]; portable?: boolean };
  state: unknown;
}

export const parseJsonl = (text: string): LogEntry[] =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry);

/** The did:key of a Multikey public key, as didwebvh-ts lists update keys. */
export const didKeyOf = (publicKeyMultibase: string) => `did:key:${publicKeyMultibase}`;
