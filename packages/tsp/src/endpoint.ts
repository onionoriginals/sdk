import type { LocalVid, OpenedMessage } from './message.js';
import { keysFromRev3Vid, openTspMessage, sealTspPayload } from './message.js';
import type { Payload } from './cesr/packet.js';
import { postTspWire } from './http/client.js';
import { peerFromKeys, MemoryTspRouter } from './transport.js';

export type RelationshipState =
  | { status: 'unrelated' }
  | { status: 'uni'; inviteDigest: Uint8Array }
  | { status: 'bi'; inviteDigest: Uint8Array; replyDigest: Uint8Array };

export class TspEndpoint {
  readonly vid: LocalVid;
  private readonly router?: MemoryTspRouter;
  private readonly relationships = new Map<string, RelationshipState>();

  constructor(vid: LocalVid, router?: MemoryTspRouter) {
    this.vid = vid;
    this.router = router;
  }

  relationship(peerId: string): RelationshipState {
    return this.relationships.get(peerId) ?? { status: 'unrelated' };
  }

  async sendRaw(peer: LocalVid, payload: Payload, options?: { confidential?: boolean }): Promise<Uint8Array> {
    const wire = await sealTspPayload(this.vid, peer, payload, options);
    this.router?.post(peer.id, wire);
    return wire;
  }

  async sendApplication(peer: LocalVid, data: Uint8Array): Promise<Uint8Array> {
    return this.sendRaw(peer, { type: 'generic', data }, { confidential: true });
  }

  async sendApplicationHttp(
    peer: LocalVid,
    data: Uint8Array,
    options?: { fetch?: typeof fetch },
  ): Promise<Uint8Array> {
    const transport = peer.transport;
    if (!transport) throw new Error('peer has no TSP transport URL');
    const wire = await this.sendApplication(peer, data);
    await postTspWire(transport, wire, { fetch: options?.fetch });
    return wire;
  }

  async sendRelationshipInvite(peer: LocalVid, nonce?: Uint8Array): Promise<Uint8Array> {
    const n = nonce ?? crypto.getRandomValues(new Uint8Array(16));
    const payload: Payload = {
      type: 'rfi',
      requestDigest: { kind: 'sha256', bytes: new Uint8Array(32) },
      nonce: n,
      replyPath: [],
      referral: null,
    };
    const wire = await this.sendRaw(peer, payload, { confidential: true });
    return wire;
  }

  async sendRelationshipAccept(
    peer: LocalVid,
    invite: Extract<Payload, { type: 'rfi' }>,
  ): Promise<Uint8Array> {
    const payload: Payload = {
      type: 'rfa',
      requestDigest: invite.requestDigest,
      replyDigest: { kind: 'sha256', bytes: new Uint8Array(32) },
    };
    const wire = await this.sendRaw(peer, payload, { confidential: true });
    this.relationships.set(peer.id, {
      status: 'bi',
      inviteDigest: invite.requestDigest.bytes,
      replyDigest: (payload as { replyDigest: { bytes: Uint8Array } }).replyDigest.bytes,
    });
    return wire;
  }

  async receiveNext(
    peer: LocalVid,
    wire: Uint8Array,
  ): Promise<OpenedMessage> {
    const opened = await openTspMessage(wire, peer, this.vid);
    if (opened.payload.type === 'rfi') {
      this.relationships.set(peer.id, {
        status: 'uni',
        inviteDigest: opened.payload.requestDigest.bytes,
      });
    }
    if (opened.payload.type === 'rfa') {
      this.relationships.set(peer.id, {
        status: 'bi',
        inviteDigest: opened.payload.requestDigest.bytes,
        replyDigest: opened.payload.replyDigest.bytes,
      });
    }
    return opened;
  }

  drainInbox(): Uint8Array[] {
    return this.router?.drain(this.vid.id) ?? [];
  }
}

export { keysFromRev3Vid, peerFromKeys, MemoryTspRouter };