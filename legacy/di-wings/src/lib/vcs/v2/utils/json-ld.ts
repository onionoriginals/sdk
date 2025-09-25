import jsonld from 'jsonld';

export async function expandJsonLd(doc: any, documentLoader: any): Promise<any> {
  try {
    return await jsonld.expand(doc, { documentLoader });
  } catch (error) {
    console.error('Error in expandJsonLd:', error);
    throw new Error(`Failed to expand JSON-LD: ${(error as Error).message}`);
  }
}

export async function compactJsonLd(document: any, context: any): Promise<any> {
  try {
    return await jsonld.compact(document, context);
  } catch (error) {
    throw new Error(`Failed to compact JSON-LD: ${(error as Error).message}`);
  }
}
