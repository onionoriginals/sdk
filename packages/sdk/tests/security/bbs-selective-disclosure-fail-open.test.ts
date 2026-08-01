import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../src/vc/CredentialManager';
import type { OriginalsConfig, VerifiableCredential } from '../../src/types';

/**
 * Regression tests for a fail-open selective-disclosure bug.
 *
 * `deriveSelectiveProof` used to fall back, for any credential without a
 * bbs-2023 proof, to returning the credential UNCHANGED while reporting the
 * undisclosed paths in `hiddenFields`. A caller who trusted that report and
 * forwarded `result.credential` published every field it claimed to withhold.
 *
 * `prepareSelectiveDisclosure` had the matching hole: with no key it returned a
 * "metadata-only" result that looked like success but created no proof — so the
 * documented flow produced a credential that could never be disclosed, and then
 * a derive that leaked. Both now throw.
 */
const config = { network: 'regtest', defaultKeyType: 'ES256K' } as unknown as OriginalsConfig;

const SECRET = 'alice@example.com';

const credential: VerifiableCredential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential'],
  issuer: 'did:example:issuer',
  validFrom: '2026-01-01T00:00:00Z',
  credentialSubject: {
    id: 'did:example:subject',
    name: 'Alice',
    email: SECRET
  }
} as unknown as VerifiableCredential;

describe('selective disclosure fails closed', () => {
  const cm = new CredentialManager(config);

  test('derive on an unsigned credential throws instead of leaking withheld fields', async () => {
    await expect(
      cm.deriveSelectiveProof(credential, ['/credentialSubject/id'])
    ).rejects.toThrow(/bbs-2023 base proof/);
  });

  test('no result object can carry the secret while calling it hidden', async () => {
    // The precise shape of the old bug: hiddenFields named the email, and the
    // returned credential still contained it.
    let leaked: unknown;
    try {
      const result = await cm.deriveSelectiveProof(credential, ['/credentialSubject/id']);
      leaked = result.credential;
    } catch {
      leaked = undefined;
    }
    expect(JSON.stringify(leaked ?? {})).not.toContain(SECRET);
  });

  test('prepare without a key throws rather than returning an unsigned credential', async () => {
    await expect(
      cm.prepareSelectiveDisclosure(credential, {
        mandatoryPointers: ['/credentialSubject/id'],
        selectivePointers: ['/credentialSubject/name']
      })
    ).rejects.toThrow(/BBS\+ key pair|privateKey/);
  });

  test('the errors are actionable — they name the missing input', async () => {
    await expect(
      cm.prepareSelectiveDisclosure(credential, { mandatoryPointers: ['/credentialSubject/id'] })
    ).rejects.toThrow(/generateKeyPair|privateKey/);

    await expect(cm.deriveSelectiveProof(credential, [])).rejects.toThrow(
      /prepareSelectiveDisclosure/
    );
  });
});
