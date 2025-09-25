import { z } from "zod";
import { ValidationError } from '../errors';
import type { VerifiableCredential } from '../models/credential';

// Define a schema for language value objects
const languageValueSchema = z.object({
  '@value': z.string(),
  '@language': z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/), // Basic BCP47 validation
  '@direction': z.enum(['ltr', 'rtl']).optional(),
}).strict();

// Define a schema for string or language value
const stringOrLanguageValue = z.union([
  z.string(),
  languageValueSchema,
  z.array(languageValueSchema)
]);

// Define the schema for credentialStatus
const credentialStatusSchema = z.object({
  type: z.string(),
  // Allow additional properties
}).and(z.record(z.any()));

// Define the schema for termsOfUse
const termsOfUseSchema = z.object({
  type: z.string(),
  // Allow additional properties
}).and(z.record(z.any()));

// Define the schema for evidence
const evidenceSchema = z.object({
  type: z.string(),
  // Allow additional properties
}).and(z.record(z.any()));

// Define the schema for refreshService
const refreshServiceSchema = z.object({
  type: z.string(),
  // Allow additional properties
}).and(z.record(z.any()));

// Define the schema for credentialSchema
const credentialSchemaSchema = z.object({
  type: z.string(),
  id: z.string(),
  // Allow additional properties
}).and(z.record(z.any()));

// Define a schema for a non-empty object
const nonEmptyObjectSchema = z.record(z.any()).refine(
  (obj) => Object.keys(obj).length > 0,
  { message: "Object must not be empty" }
);

// Define a custom date-time validator
const dateTimeWithOffset = z.string().refine(
  (value) => {
    const regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    return regex.test(value);
  },
  {
    message: "Invalid date-time format. Expected format: YYYY-MM-DDTHH:mm:ss[.sss][Z|(+|-)HH:mm]"
  }
);

// Define the schema for relatedResource
const relatedResourceSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
}).and(
  z.union([
    z.object({ digestSRI: z.string() }),
    z.object({ digestMultibase: z.string() }),
    z.object({ digestSRI: z.string(), digestMultibase: z.string() })
  ])
).and(z.record(z.any()));

// Define the Zod schema for VerifiableCredential
export const verifiableCredentialSchema = z.object({
  '@context': z.array(z.union([z.string(), z.record(z.any())]))
    .min(1)
    .refine(
      context => Array.isArray(context) && 
                 context.length > 0 && 
                 context[0] === "https://www.w3.org/ns/credentials/v2",
      { 
        message: "The @context must be an array with 'https://www.w3.org/ns/credentials/v2' as the first item",
        path: ['@context']
      }
    ),
  id: z.string().optional(),
  type: z.array(z.string())
    .min(1)
    .refine(
      types => types.includes('VerifiableCredential'),
      { message: "The 'type' array must include 'VerifiableCredential'" }
    ),
  issuer: z.union([
    z.string(),
    z.object({
      id: z.string(),
      name: stringOrLanguageValue.optional(),
      description: stringOrLanguageValue.optional(),
    }).and(z.record(z.any()))
  ]),
  validFrom: dateTimeWithOffset.optional(),
  validUntil: dateTimeWithOffset.optional(),
  credentialSubject: z.union([
    nonEmptyObjectSchema,
    z.array(nonEmptyObjectSchema).min(1)
  ]),
  credentialStatus: credentialStatusSchema.optional(),
  termsOfUse: z.union([termsOfUseSchema, z.array(termsOfUseSchema)]).optional(),
  evidence: z.union([evidenceSchema, z.array(evidenceSchema)]).optional(),
  refreshService: z.union([refreshServiceSchema, z.array(refreshServiceSchema)]).optional(),
  credentialSchema: z.union([credentialSchemaSchema, z.array(credentialSchemaSchema)]).optional(),
  relatedResource: z.union([relatedResourceSchema, z.array(relatedResourceSchema)]).optional(),
  proof: z.union([z.array(z.object({
    type: z.string(),
    proofPurpose: z.string(),
    verificationMethod: z.string(),
    proofValue: z.string(),
  })), z.object({
    type: z.string(),
    proofPurpose: z.string(),
    verificationMethod: z.string(),
    proofValue: z.string(),
  })])
}).and(z.record(z.any()))
.refine(
  (credential) => {
    if (credential.validFrom && credential.validUntil) {
      const validFrom = new Date(credential.validFrom);
      const validUntil = new Date(credential.validUntil);
      return validUntil >= validFrom;
    }
    return true;
  },
  {
    message: "validUntil must be the same as or later than validFrom",
    path: ["validUntil"],
  }
);

export function validateCredential(verifiableCredential: VerifiableCredential): void {
  try {
    verifiableCredentialSchema.parse(verifiableCredential);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error as any);
    }
    throw error;
  }
}
