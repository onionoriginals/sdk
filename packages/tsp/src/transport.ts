import type { LocalVid } from './message.js';

export type TspMemoryBus = {
  post: (toDid: string, wire: Uint8Array) => void;
};

export function createPairedInbox(bus: TspMemoryBus, localDid: string): {
  deliver: (wire: Uint8Array) => void;
  drain: () => Uint8Array[];
} {
  const queue: Uint8Array[] = [];
  const prior = bus.post;
  bus.post = (toDid, wire) => {
    if (toDid === localDid) queue.push(wire);
    prior(toDid, wire);
  };
  return {
    deliver: (wire) => queue.push(wire),
    drain: () => queue.splice(0, queue.length),
  };
}

export class MemoryTspRouter {
  private readonly inboxes = new Map<string, Uint8Array[]>();

  post(toDid: string, wire: Uint8Array): void {
    let box = this.inboxes.get(toDid);
    if (!box) {
      box = [];
      this.inboxes.set(toDid, box);
    }
    box.push(wire);
  }

  drain(did: string): Uint8Array[] {
    const box = this.inboxes.get(did) ?? [];
    this.inboxes.set(did, []);
    return box;
  }
}

export function peerFromKeys(
  keys: Pick<LocalVid, 'id' | 'signingPublicKey' | 'encryptionPublicKey' | 'transport'>,
): LocalVid {
  return {
    ...keys,
    signingPrivateKey: new Uint8Array(0),
    encryptionPrivateKey: new Uint8Array(0),
  };
}