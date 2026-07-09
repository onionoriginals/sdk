import { verifyToken, TurnkeyWebVHSigner, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { createDID } from 'didwebvh-ts';
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
      const result = await createDID({
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
      return json({ message: e instanceof Error ? e.message : 'DID creation failed' }, 500);
    }
  };

  return { createDid };
}
