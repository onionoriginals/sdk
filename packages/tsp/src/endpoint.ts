import type { LocalVid, OpenedMessage } from './message.js';
import {
  computeRelationshipDigest,
  keysFromRev3Vid,
  openTspMessage,
  sealTspPayload,
  vidIdBytes,
} from './message.js';
import { encodeEnvelopePrefix } from './cesr/packet.js';
import { bytesFromNumberStream } from './cesr/encode.js';
import type { Digest, Payload } from './cesr/packet.js';
import { postTspWire } from './http/client.js';
import { peerFromKeys, MemoryTspRouter } from './transport.js';

export type RelationshipState =
  | { status: 'unrelated' }
  | { status: 'uni'; inviteDigest: Uint8Array }
  | { status: 'bi'; inviteDigest: Uint8Array; replyDigest: Uint8Array };

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]!);
}

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

  private requireBilateral(peerId: string): void {
    if (this.relationship(peerId).status !== 'bi') {
      throw new Error('bilateral TSP relationship required');
    }
  }

  /** Apply inbound control payloads (RFI / RFA / RFD) after HTTP or in-memory delivery. */
  recordInbound(senderId: string, opened: OpenedMessage): void {
    this.applyInboundPayload(senderId, opened.payload);
  }

  private applyInboundPayload(peerId: string, payload: Payload): void {
    if (payload.type === 'rfi') {
      this.relationships.set(peerId, {
        status: 'uni',
        inviteDigest: payload.requestDigest.bytes,
      });
    }
    if (payload.type === 'rfa') {
      this.relationships.set(peerId, {
        status: 'bi',
        inviteDigest: payload.requestDigest.bytes,
        replyDigest: payload.replyDigest.bytes,
      });
    }
    if (payload.type === 'rfd') {
      const state = this.relationships.get(peerId);
      if (state?.status === 'bi' && digestsEqual(state.replyDigest, payload.reply.bytes)) {
        this.relationships.delete(peerId);
      } else if (state?.status === 'uni') {
        this.relationships.delete(peerId);
      }
    }
  }

  async sendRaw(peer: LocalVid, payload: Payload, options?: { confidential?: boolean }): Promise<Uint8Array> {
    const wire = await sealTspPayload(this.vid, peer, payload, options);
    this.router?.post(peer.id, wire);
    return wire;
  }

  async sendApplication(peer: LocalVid, data: Uint8Array): Promise<Uint8Array> {
    this.requireBilateral(peer.id);
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

  async requestRelationshipHttp(peer: LocalVid, options?: { fetch?: typeof fetch }): Promise<Uint8Array> {
    const transport = peer.transport;
    if (!transport) throw new Error('peer has no TSP transport URL');
    const wire = await this.sendRelationshipInvite(peer);
    await postTspWire(transport, wire, { fetch: options?.fetch });
    return wire;
  }

  private pendingInvite(peerId: string): Extract<Payload, { type: 'rfi' }> {
    const state = this.relationship(peerId);
    if (state.status !== 'uni') throw new Error('no pending invite for peer');
    return {
      type: 'rfi',
      requestDigest: { kind: 'sha256', bytes: state.inviteDigest },
      nonce: new Uint8Array(16),
      replyPath: [],
      referral: null,
    };
  }

  async sendRelationshipAccept(
    peer: LocalVid,
    invite: Extract<Payload, { type: 'rfi' }>,
  ): Promise<Uint8Array> {
    const draft: Payload = {
      type: 'rfa',
      requestDigest: invite.requestDigest,
      replyDigest: { kind: 'sha256', bytes: new Uint8Array(32) },
    };
    const stream: number[] = [];
    encodeEnvelopePrefix(vidIdBytes(this.vid.id), vidIdBytes(peer.id), stream);
    const prefix = bytesFromNumberStream(stream);
    const replyDigest = computeRelationshipDigest(draft, vidIdBytes(this.vid.id), prefix);
    const wire = await this.sendRaw(peer, draft, { confidential: true });
    this.relationships.set(peer.id, {
      status: 'bi',
      inviteDigest: invite.requestDigest.bytes,
      replyDigest: replyDigest.bytes,
    });
    return wire;
  }

  async acceptRelationshipHttp(
    peer: LocalVid,
    invite?: Extract<Payload, { type: 'rfi' }>,
    options?: { fetch?: typeof fetch },
  ): Promise<Uint8Array> {
    const transport = peer.transport;
    if (!transport) throw new Error('peer has no TSP transport URL');
    const inv = invite ?? this.pendingInvite(peer.id);
    const wire = await this.sendRelationshipAccept(peer, inv);
    await postTspWire(transport, wire, { fetch: options?.fetch });
    return wire;
  }

  async sendRelationshipCancel(peer: LocalVid, replyDigest: Digest): Promise<Uint8Array> {
    const payload: Payload = { type: 'rfd', reply: replyDigest };
    const wire = await this.sendRaw(peer, payload, { confidential: true });
    const state = this.relationships.get(peer.id);
    if (state?.status === 'bi' && digestsEqual(state.replyDigest, replyDigest.bytes)) {
      this.relationships.delete(peer.id);
    }
    return wire;
  }

  async cancelRelationshipHttp(
    peer: LocalVid,
    options?: { fetch?: typeof fetch },
  ): Promise<Uint8Array> {
    const transport = peer.transport;
    if (!transport) throw new Error('peer has no TSP transport URL');
    const state = this.relationship(peer.id);
    if (state.status !== 'bi') throw new Error('no active relationship to cancel');
    const wire = await this.sendRelationshipCancel(
      peer,
      { kind: 'sha256', bytes: state.replyDigest },
    );
    await postTspWire(transport, wire, { fetch: options?.fetch });
    return wire;
  }

  async receiveNext(
    peer: LocalVid,
    wire: Uint8Array,
  ): Promise<OpenedMessage> {
    const opened = await openTspMessage(wire, peer, this.vid);
    this.recordInbound(peer.id, opened);
    return opened;
  }

  drainInbox(): Uint8Array[] {
    return this.router?.drain(this.vid.id) ?? [];
  }
}

export { keysFromRev3Vid, peerFromKeys, MemoryTspRouter };