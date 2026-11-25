import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { CipherSuite } from '@hpke/core';
import { DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/dhkem-x25519';

export const HPKE_INFO = new TextEncoder().encode('YTSP-');

const ENCAP_SIZE = 32;
const TAG_SIZE = 16;

function suite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

/** HPKE-Base seal: wire ciphertext is CONCAT(enc, ct+tag). */
export async function hpkeSeal(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const cs = suite();
  const pk = await cs.kem.deserializePublicKey(recipientPublicKey);
  const sender = await cs.createSenderContext({ recipientPublicKey: pk, info: HPKE_INFO });
  const sealed = await sender.seal(plaintext, aad);
  const enc = new Uint8Array(await sender.enc as ArrayBuffer);
  const sealedBytes = new Uint8Array(sealed);
  const out = new Uint8Array(enc.length + sealedBytes.length);
  out.set(enc, 0);
  out.set(sealedBytes, enc.length);
  return out;
}

export async function hpkeOpen(
  recipientPrivateKey: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length < ENCAP_SIZE + TAG_SIZE) {
    throw new Error('ciphertext too short');
  }
  const enc = ciphertext.subarray(0, ENCAP_SIZE);
  const ct = ciphertext.subarray(ENCAP_SIZE);
  const cs = suite();
  const sk = await cs.kem.deserializePrivateKey(recipientPrivateKey);
  const recipient = await cs.createRecipientContext({
    recipientKey: sk,
    enc,
    info: HPKE_INFO,
  });
  return new Uint8Array(await recipient.open(ct, aad));
}