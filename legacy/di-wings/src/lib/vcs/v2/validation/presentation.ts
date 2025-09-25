import { z } from "zod";
import { ValidationError } from '../errors';
import type { Presentation, VerifiablePresentation } from '../models/presentation';
import { verifiableCredentialSchema } from './credential';

// Define the Zod schema for Presentation
const presentationSchema = z.object({
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
  type: z.array(z.string()).refine(types => types.includes('VerifiablePresentation')),
  holder: z.union([z.string(), z.object({ id: z.string() })]).optional(),
  verifiableCredential: z.array(verifiableCredentialSchema).optional(),
});

// Define the Zod schema for VerifiablePresentation
const verifiablePresentationSchema = presentationSchema.extend({
  proof: z.union([z.array(z.object({
    type: z.string(),
    created: z.string().datetime(),
    verificationMethod: z.string(),
    proofPurpose: z.string(),
    cryptosuite: z.string(),
    proofValue: z.string(),
  })), z.object({
    type: z.string(),
    created: z.string().datetime(),
    proofPurpose: z.string(),
    verificationMethod: z.string(),
    proofValue: z.string(),
    cryptosuite: z.string(),
  })])
});

export function validatePresentation(presentation: Presentation): void {
  try {
    presentationSchema.parse(presentation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error as any);
    }
    throw error;
  }
}

export function validateVerifiablePresentation(verifiablePresentation: VerifiablePresentation): void {
  try {
    verifiablePresentationSchema.parse(verifiablePresentation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(error as any);
    }
    throw error;
  }
}
