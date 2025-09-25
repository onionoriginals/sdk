import type { ILinkedDataProof } from "../../common/interfaces";

export interface ProofJSON {
  type: string;
  proofPurpose: string;
  verificationMethod: string;
  created: string;
  challenge?: string;
  domain?: string;
}
export class LinkedDataProof implements ILinkedDataProof {
  public type: string;
  public proofPurpose: string;
  public created: string;
  public verificationMethod: string;
  public challenge?: string;
  public domain?: string;

  constructor(
    type: string,
    proofPurpose: string,
    verificationMethod: string,
    challenge?: string,
    domain?: string,
    created?: string
  ) {
    this.type = type;
    this.proofPurpose = proofPurpose;
    this.verificationMethod = verificationMethod;
    this.challenge = challenge;
    this.domain = domain;
    this.created = created ?? this.generateTimestamp();
  }

  private generateTimestamp(): string {
    const date = new Date().toISOString();
    return date.slice(0, -5) + 'Z';
  }

  public validate(maxTimestampDelta: number | null = null): boolean {
    if (maxTimestampDelta !== null && maxTimestampDelta !== Infinity) {
      const expected = new Date().getTime();
      const delta = maxTimestampDelta * 1000;
      const created = new Date(this.created).getTime();
      
      if (isNaN(created) || created < expected - delta || created > expected + delta) {
        console.error("The proof's created timestamp is out of range.");
        return false;
      }
    }
    return true;
  }

  public toJSON(): ProofJSON {
    const json: ProofJSON = {
      type: this.type,
      proofPurpose: this.proofPurpose,
      verificationMethod: this.verificationMethod,
      created: this.created
    };

    if (this.challenge) {
      json.challenge = this.challenge;
    }

    if (this.domain) {
      json.domain = this.domain;
    }

    return json;
  }
}