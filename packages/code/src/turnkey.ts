/**
 * `@originals/code/turnkey` (Node only): sign branch entries with an Ed25519
 * key held in Turnkey (plan 049 §6 milestone 1; PROVISIONAL K21). The dogfood
 * CI signs as an editor of the owner's branch this way; no private key is
 * ever in the repository, the workspace or the identity file.
 *
 * Signing goes through `@originals/auth`'s `turnkeySignBytes`, which signs
 * exactly the bytes given (`HASH_FUNCTION_NOT_APPLICABLE`). Each signature is
 * checked locally against the identity's public key before it is used, so a
 * wrong key reference fails at once, before any entry is committed.
 *
 * Credentials come from the environment:
 *   TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID
 *   TURNKEY_API_BASE_URL   optional, https://api.turnkey.com by default
 */
import { turnkeySignBytes } from "@originals/auth";
import { checkSignature, decodeMultikey, type ProofSigner } from "@originals/vh/crypto";
import type { EntrySigner } from "@originals/vh/log";
import { Turnkey } from "@turnkey/sdk-server";
import { codeError } from "./errors.js";
import { remoteEntrySigner, type RemoteIdentity } from "./remote-identity.js";

/** The environment variables the Turnkey signer reads (the CI secrets of the same names). */
export const TURNKEY_ENV = ["TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY", "TURNKEY_ORGANIZATION_ID"] as const;

export interface TurnkeyCredentials {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
  apiBaseUrl?: string;
}

/**
 * Turnkey credentials from the environment: null when none is set (signing
 * is unavailable, as on a fork's CI); an error when only some are, since a
 * half-configured signer is a mistake to report, not to skip.
 */
export function turnkeyCredentials(env: Record<string, string | undefined> = process.env): TurnkeyCredentials | null {
  const present = TURNKEY_ENV.filter((k) => !!env[k]);
  if (present.length === 0) return null;
  if (present.length !== TURNKEY_ENV.length) {
    codeError("incomplete-evidence", "TURNKEY_ENV", `Turnkey signing needs ${TURNKEY_ENV.join(", ")}; missing ${TURNKEY_ENV.filter((k) => !env[k]).join(", ")}`);
  }
  return {
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY!,
    organizationId: env.TURNKEY_ORGANIZATION_ID!,
    ...(env.TURNKEY_API_BASE_URL ? { apiBaseUrl: env.TURNKEY_API_BASE_URL } : {}),
  };
}

/** The part of a Turnkey client the signer uses (a real `Turnkey`, or a test double). */
export type TurnkeyClientLike = Pick<Turnkey, "apiClient">;

/**
 * A `ProofSigner` for the Turnkey-held key `signWith`, whose public key is
 * `publicKeyMultibase`. Every signature is verified against that key before
 * it is returned.
 */
export function turnkeyProofSigner(input: { client: TurnkeyClientLike; organizationId: string; signWith: string; publicKeyMultibase: string }): ProofSigner {
  const key = decodeMultikey(input.publicKeyMultibase);
  if (key.type !== "Ed25519") codeError("unsupported-profile", "IDENTITY_KEYS", "the Turnkey key must be Ed25519 (eddsa-jcs-2022, P5.12)");
  return {
    keyType: "Ed25519",
    publicKeyMultibase: input.publicKeyMultibase,
    async sign(hashData: Uint8Array): Promise<Uint8Array> {
      const signature = await turnkeySignBytes({ turnkeyClient: input.client as Turnkey, organizationId: input.organizationId, signWith: input.signWith }, hashData);
      if (!checkSignature(key, hashData, signature)) {
        codeError("invalid-evidence", "TURNKEY_KEY_MISMATCH", `Turnkey key ${input.signWith} did not sign with ${input.publicKeyMultibase}: check the identity's key reference`);
      }
      return signature;
    },
  };
}

/** A Turnkey client from credentials. */
export function turnkeyClient(credentials: TurnkeyCredentials): Turnkey {
  return new Turnkey({
    apiBaseUrl: credentials.apiBaseUrl ?? "https://api.turnkey.com",
    apiPublicKey: credentials.apiPublicKey,
    apiPrivateKey: credentials.apiPrivateKey,
    defaultOrganizationId: credentials.organizationId,
  });
}

/** Signs a remote identity's entries through Turnkey (`workspace.mirror({ identity, sign })`). */
export function turnkeyEntrySigner(identity: RemoteIdentity, credentials: TurnkeyCredentials, client: TurnkeyClientLike = turnkeyClient(credentials)): EntrySigner {
  return remoteEntrySigner(identity, turnkeyProofSigner({ client, organizationId: credentials.organizationId, signWith: identity.key.signWith, publicKeyMultibase: identity.key.publicKeyMultibase }));
}
