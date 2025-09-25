import type { CredentialTemplate } from './types';
import jsonata from 'jsonata';

export async function validateCredentialTemplate(template: CredentialTemplate): Promise<void> {
  if (template.type !== 'jsonata') {
    throw new Error('Unsupported template type');
  }

  try {
    // Validate that the template is valid JSONata
    jsonata(template.template);
  } catch (error) {
    throw new Error(`Invalid JSONata template: ${(error as Error).message}`);
  }
} 