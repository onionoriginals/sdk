/**
 * The author's DID evidence as the engine hands it to the SDK, stamped with
 * when this page obtained it (P7.10): a result's `validAsOf` names that time
 * for the history it relied on. Evidence that changes is restamped; evidence
 * set again unchanged keeps the time it was first obtained.
 */
import type { AuthorDidEvidence } from '@originals/vh/originals';

export class StampedAuthorEvidence {
  private stamped: { evidence: AuthorDidEvidence; key: string; obtainedAt: string } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  set(evidence: AuthorDidEvidence): void {
    const key = JSON.stringify([evidence.did, evidence.log, evidence.witness ?? null]);
    if (this.stamped?.key === key) return;
    this.stamped = { evidence, key, obtainedAt: new Date(this.now()).toISOString() };
  }

  get(did: string): AuthorDidEvidence | undefined {
    const s = this.stamped;
    return s && s.evidence.did === did ? { ...s.evidence, obtainedAt: s.obtainedAt } : undefined;
  }
}
