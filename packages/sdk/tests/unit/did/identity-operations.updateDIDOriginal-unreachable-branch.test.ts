/**
 * #699 — updateDIDOriginal must throw "Cannot determine DID from update
 * result" whenever neither `result.did` nor the log's last state carries a
 * usable `id`, instead of silently returning `did: ""`.
 *
 * The bug: `latestDoc?.id || ""` never lets the function's own final `else`
 * throw fire once `result.log` is non-empty, even when that log's last state
 * has no `id`. The currently-pinned `didwebvh-ts@2.8.0` never actually
 * returns that shape (it throws internally first), so this is mocked here to
 * exercise the branch directly.
 */

import { describe, test, expect, mock, afterAll } from 'bun:test';
import * as realDidwebvhTs from 'didwebvh-ts';

const realExports = { ...realDidwebvhTs };
afterAll(() => {
  mock.module('didwebvh-ts', () => realExports);
});

describe('#699 — updateDIDOriginal throws instead of returning did: ""', () => {
  test('no top-level did and a log whose last state has no id throws', async () => {
    mock.module('didwebvh-ts', () => ({
      ...realExports,
      updateDID: async () => ({
        log: [{ state: {} }],
        doc: {},
        meta: {},
      }),
    }));

    const { updateDIDOriginal } = await import('../../../src/did/identity-operations.js');
    const dummySigner = {
      getVerificationMethodId: () => 'did:key:zDummy',
      verify: async () => true,
    } as any;

    await expect(
      updateDIDOriginal({
        type: 'did',
        log: [{ state: {} }] as any,
        signer: dummySigner,
        verifier: dummySigner,
      }),
    ).rejects.toThrow('Cannot determine DID from update result');
  });

  test('a log whose last state has an id still resolves the did', async () => {
    mock.module('didwebvh-ts', () => ({
      ...realExports,
      updateDID: async () => ({
        log: [{ state: { id: 'did:webvh:abc:example.com:user' } }],
        doc: {},
        meta: {},
      }),
    }));

    const { updateDIDOriginal } = await import('../../../src/did/identity-operations.js');
    const dummySigner = {
      getVerificationMethodId: () => 'did:key:zDummy',
      verify: async () => true,
    } as any;

    const result = await updateDIDOriginal({
      type: 'did',
      log: [{ state: {} }] as any,
      signer: dummySigner,
      verifier: dummySigner,
    });

    expect(result.did).toBe('did:webvh:abc:example.com:user');
  });
});
