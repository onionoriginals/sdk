import jsonld from 'jsonld';

export async function canonize(input: any, { documentLoader }: any): Promise<string> {
  return await jsonld.canonize(input, {
    algorithm: 'URDNA2015',
    format: 'application/n-quads',
    documentLoader,
    // Error on terms not defined in the supplied contexts instead of silently
    // dropping them from the signed dataset (see issue #167).
    safe: true,
    useNative: false,
    rdfDirection: 'i18n-datatype'
  } as any);
}

export async function canonizeProof(proof: any, { documentLoader }: any): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { jws: _jws, signatureValue: _signatureValue, proofValue: _proofValue, ...rest } = proof;
  return await canonize(rest, { documentLoader });
}

