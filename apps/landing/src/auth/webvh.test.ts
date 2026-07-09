import { describe, test, expect } from 'bun:test';
import * as ed from '@noble/ed25519';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, buildUserWebVHDid } from './webvh';

async function makeSigner(): Promise<{ signer: BrowserWebVHSigner; priv: Uint8Array; pub: Uint8Array }> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(priv);
  const signer = new BrowserWebVHSigner(priv, ed25519PublicKeyMultibase(pub));
  return { signer, priv, pub };
}

describe('BrowserWebVHSigner — real Ed25519 did:webvh', () => {
  test('creates a valid did:webvh whose proof self-verifies for real', async () => {
    const { signer } = await makeSigner();
    const { did, didDocument, didLog } = await buildUserWebVHDid(signer, {
      domain: 'magby.originals.build',
      slug: 'user-abc0123456789a',
    });
    // Reaching here means createDIDOriginal ran didwebvh-ts's post-sign
    // self-verification and the Ed25519 proof over the log entry verified —
    // i.e. the signature is genuine, not a stub.
    expect(did.startsWith('did:webvh:')).toBe(true);
    expect(didDocument).toBeTruthy();
    expect(didLog).toBeTruthy();
  });

  test('verify() accepts a genuine signature and rejects a tampered one', async () => {
    const { signer, priv, pub } = await makeSigner();
    const msg = new TextEncoder().encode('originals-webvh');
    const sig = await ed.signAsync(msg, priv);
    expect(await signer.verify(sig, msg, pub)).toBe(true);
    const tampered = Uint8Array.from(sig);
    tampered[0] ^= 0xff;
    expect(await signer.verify(tampered, msg, pub)).toBe(false);
  });

  test('getVerificationMethodId is did:key of the bare multibase', async () => {
    const { signer } = await makeSigner();
    expect(signer.getPublicKeyMultibase().startsWith('z')).toBe(true);
    expect(signer.getVerificationMethodId()).toBe(`did:key:${signer.getPublicKeyMultibase()}`);
  });
});
