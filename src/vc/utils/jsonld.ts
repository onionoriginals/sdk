import jsonld from 'jsonld';

export async function canonize(input: any, { documentLoader }: any): Promise<string> {
  return await jsonld.canonize(input, {
    algorithm: 'URDNA2015',
    format: 'application/n-quads',
    documentLoader,
    safe: false,
    useNative: false,
    rdfDirection: 'i18n-datatype'
  } as any);
}

export async function canonizeProof(proof: any, { documentLoader }: any): Promise<string> {
  const { jws, signatureValue, proofValue, ...rest } = proof;
  return await canonize(rest, { documentLoader });
}

