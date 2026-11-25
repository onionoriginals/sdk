/**
 * Deliver an Originals transfer handoff (P9.18) as a confidential TSP_GEN payload.
 * PROVISIONAL: direct-mode transport; callers supply a shared {@link MemoryTspRouter}.
 */
import {
  MemoryTspRouter,
  TspEndpoint,
  assertDidDocumentMultikeyOnly,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
  type LocalVid,
} from '@originals/tsp';

export const HANDOFF_TSP_MEDIA = 'application/vnd.originals.handoff+zip';

export type DeliverHandoffViaTspOptions = {
  handoffZip: Uint8Array;
  sender: LocalVid;
  receiverDid: Record<string, unknown>;
  router: MemoryTspRouter;
};

export type ReceivedHandoffViaTsp = {
  handoffZip: Uint8Array;
  senderDid: string;
};

/**
 * After relationship establishment, seal the handoff ZIP as TSP_GEN to the receiver.
 */
export async function deliverHandoffViaTsp(options: DeliverHandoffViaTspOptions): Promise<Uint8Array> {
  const senderEp = new TspEndpoint(options.sender, options.router);
  const receiverPeer = peerFromKeys(peerVidFromDidDocument(options.receiverDid));
  return senderEp.sendApplication(receiverPeer, options.handoffZip);
}

export async function receiveHandoffFromInbox(
  receiver: LocalVid,
  senderDid: Record<string, unknown>,
  router: MemoryTspRouter,
): Promise<ReceivedHandoffViaTsp> {
  const ep = new TspEndpoint(receiver, router);
  const [wire] = ep.drainInbox();
  if (!wire) throw new Error('no TSP message in inbox');
  const sender = peerFromKeys(peerVidFromDidDocument(senderDid));
  const msg = await ep.receiveNext(sender, wire);
  return {
    handoffZip: msg.applicationData ?? new Uint8Array(0),
    senderDid: msg.senderId,
  };
}

/** Merge TSPTransport + keyAgreement into WebVH document fields (Multikey only). */
export function tspFieldsForWebVH(vid: LocalVid): {
  verificationMethods: Array<Record<string, unknown>>;
  service: Array<Record<string, unknown>>;
  authentication: string[];
  keyAgreement: string[];
} {
  const doc = didDocumentForLocalVid(vid);
  assertDidDocumentMultikeyOnly(doc);
  return {
    verificationMethods: (doc.verificationMethod ?? []) as Array<Record<string, unknown>>,
    authentication: (doc.authentication ?? []) as string[],
    keyAgreement: (doc.keyAgreement ?? []) as string[],
    service: (doc.service ?? []) as Array<Record<string, unknown>>,
  };
}

export function assertSdkDidDocumentHasNoJwk(doc: Record<string, unknown>): void {
  assertDidDocumentMultikeyOnly(doc);
}