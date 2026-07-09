import { verifyToken, TurnkeyWebVHSigner, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { OriginalsSDK } from '@originals/sdk';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { getEd25519Account } from './turnkey';

export function createDidRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { createDid: Handler } {
  const createDid: Handler = async (req) => {
    const token = extractToken(req);
    if (!token) return json({ message: 'Not authenticated' }, 401);

    let subOrgId: string;
    try {
      subOrgId = verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return json({ message: 'Invalid or expired token' }, 401);
    }

    const domain = process.env.WEBVH_DOMAIN;
    if (!domain) return json({ message: 'WEBVH_DOMAIN is not set' }, 500);

    try {
      const { address, publicKeyMultibase, verificationMethodId, signingOrganizationId } =
        await getEd25519Account(deps.turnkey, subOrgId);

      // Parent Turnkey API key signs for the sub-org (proven in boop production).
      const signer = new TurnkeyWebVHSigner(
        signingOrganizationId,
        address, // keyId = signWith
        publicKeyMultibase,
        deps.turnkey,
        verificationMethodId
      );

      const slug = `user-${subOrgId.slice(0, 16)}`;
      // createDIDOriginal (not raw createDID): it normalizes did:key-prefixed
      // updateKeys to bare multikeys (didwebvh-ts 2.8 self-verification requires
      // bare form) and accepts an ExternalSigner without a cast.
      const result = await OriginalsSDK.createDIDOriginal({
        type: 'did',
        domain,
        signer,
        verifier: signer,
        updateKeys: [verificationMethodId],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase },
          { id: '#key-1', type: 'Multikey', controller: '', publicKeyMultibase },
        ],
        paths: [slug],
        portable: false,
        authentication: ['#key-0'],
        assertionMethod: ['#key-1'],
      });

      return json({ did: result.did, didDocument: result.doc, didLog: result.log });
    } catch (e) {
      console.error('[did] create failed:', e); // log cause; don't leak upstream/didwebvh errors to clients
      return json({ message: 'DID creation failed' }, 500);
    }
  };

  return { createDid };
}
