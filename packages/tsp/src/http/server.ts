import { cesrToBinary } from '../cesr/binary.js';
import { decodeEnvelope } from '../cesr/packet.js';
import type { TspEndpoint } from '../endpoint.js';
import type { LocalVid, OpenedMessage } from '../message.js';
import { openTspMessage } from '../message.js';

const TSP_CONTENT_TYPE = 'application/tsp+cesr';

export type SenderLookup = (
  senderDid: string,
) => Promise<Pick<LocalVid, 'signingPublicKey' | 'encryptionPublicKey'> | null> | Pick<LocalVid, 'signingPublicKey' | 'encryptionPublicKey'> | null;

export type TspHttpHandlerOptions = {
  local: LocalVid;
  lookupSender: SenderLookup;
  /** When set, records RFI/RFA/RFD relationship state on the receiving endpoint. */
  endpoint?: TspEndpoint;
  onMessage?: (message: OpenedMessage) => void | Promise<void>;
};

/** Bundle handler options with relationship state tracking for an inbox-hosted endpoint. */
export function tspInboxHandlerOptions(
  endpoint: TspEndpoint,
  local: LocalVid,
  lookupSender: SenderLookup,
  onMessage?: (message: OpenedMessage) => void | Promise<void>,
): TspHttpHandlerOptions {
  return { local, lookupSender, endpoint, onMessage };
}

function envelopeSenderId(wire: Uint8Array): string {
  const decoded = decodeEnvelope(cesrToBinary(wire));
  return new TextDecoder().decode(decoded.envelope.sender);
}

/**
 * Minimal TSP receive handler: POST body is a UTF-8 CESR wire message;
 * responds 204 on success, 400 when verification fails (per TSP silent discard, surfaced for HTTP ops).
 */
export function createTspHttpHandler(options: TspHttpHandlerOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const ct = req.headers.get('content-type') ?? '';
    if (ct && !ct.startsWith(TSP_CONTENT_TYPE) && !ct.startsWith('application/octet-stream')) {
      return new Response('Unsupported Media Type', { status: 415 });
    }
    const wire = new Uint8Array(await req.arrayBuffer());
    if (wire.length === 0) {
      return new Response('Empty body', { status: 400 });
    }
    try {
      const senderDid = envelopeSenderId(wire);
      const senderKeys = await options.lookupSender(senderDid);
      if (!senderKeys) {
        return new Response(null, { status: 400 });
      }
      const opened = await openTspMessage(
        wire,
        { id: senderDid, signingPublicKey: senderKeys.signingPublicKey },
        options.local,
      );
      options.endpoint?.recordInbound(senderDid, opened);
      await options.onMessage?.(opened);
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 400 });
    }
  };
}