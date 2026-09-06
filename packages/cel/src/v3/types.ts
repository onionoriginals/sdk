import type { JsonObject } from "./values.js";
export type Algorithm = "Ed25519" | "P-256" | "P-384";
export type Cryptosuite = "eddsa-jcs-2022" | "ecdsa-jcs-2019";
export interface Resource {
  id: string;
  mediaType: string;
  digestMultibase: string;
  url?: string[];
}
export interface ResourceUpdate extends Resource {
  previousDigestMultibase: string;
}
interface Profile {
  profile: "originals/cel/3";
}
export type Operation =
  | {
      type: "create";
      data: Profile & {
        controller: string;
        createdAt: string;
        nonce: string;
        resources: Resource[];
        name?: string;
        metadata?: JsonObject;
      };
    }
  | {
      type: "update";
      data: Profile & {
        name?: string;
        metadata?: JsonObject;
        resources?: ResourceUpdate[];
      };
    }
  | {
      type: "rotateKey";
      data: Profile & { newController: string; rotatedAt: string };
    }
  | {
      type: "deactivate";
      data: Profile & { deactivatedAt: string; reason?: string };
    }
  | {
      type: "migrate";
      data: Profile & {
        from: string;
        to: string;
        layer: "webvh" | "btco";
        migratedAt: string;
      };
    };
export interface CelEvent {
  operation: Operation;
  previousEvent?: string;
}
export interface ControllerProof {
  type: "DataIntegrityProof";
  cryptosuite: Cryptosuite;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  proofValue: string;
  created?: string;
}
export interface CelEntry {
  event: CelEvent;
  proof: ControllerProof | ControllerProof[];
}
export interface CelDocument {
  log: CelEntry[];
}
