import { RegtestProvider } from '@originals/sdk';
import type { OrdinalLookup } from './bitcoin';

/** An Esplora-shaped read surface over the local indexed Core/ord pair. */
export function regtestIndexer(provider: RegtestProvider) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const path = new URL(req.url).pathname;
    try {
      const address = path.match(/^\/address\/([^/]+)\/utxo$/)?.[1];
      if (address) return Response.json(await provider.getAddressUtxos(decodeURIComponent(address)));
      const txid = path.match(/^\/tx\/([a-f0-9]{64})\/hex$/)?.[1];
      if (txid) return new Response(await provider.getRawTransaction(txid));
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
  };
}

/** No memoization: an invalidated block can change an output's inscriptions. */
export function regtestOrdinalLookup(provider: RegtestProvider): OrdinalLookup {
  return {
    async outpointInscriptions(output) { return (await provider.getOutputDetails(`${output.txid}:${output.vout}`)).inscriptions; },
  };
}
