/**
 * Isomorphic email-identity normalization.
 *
 * Turnkey sub-org lookup filters on the exact email string, so any entry
 * point that can initiate or complete an OTP flow — server-proxied or
 * client-direct — must normalize the same way before sending a contact
 * value to Turnkey. Otherwise `Alice@x.com` and `alice@x.com` can resolve
 * to different sub-organizations and fork the user's identity.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
