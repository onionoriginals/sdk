import { describe, test, expect } from 'bun:test';
import { StatusListManager } from '../../../src/vc/StatusListManager';
import type { BitstringStatusListEntry, BitstringStatusListSubject } from '../../../src/types';

describe('StatusListManager', () => {
  const manager = new StatusListManager();

  describe('createStatusListCredential', () => {
    test('creates a valid BitstringStatusListCredential', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(vc['@context']).toContain('https://www.w3.org/ns/credentials/v2');
      expect(vc.type).toContain('VerifiableCredential');
      expect(vc.type).toContain('BitstringStatusListCredential');
      expect(vc.id).toBe('https://example.com/status/1');
      expect(vc.issuer).toBe('did:example:issuer');
      expect(vc.issuanceDate).toBeDefined();

      const subject = vc.credentialSubject as BitstringStatusListSubject;
      expect(subject.type).toBe('BitstringStatusList');
      expect(subject.statusPurpose).toBe('revocation');
      expect(subject.encodedList).toMatch(/^u/);
    });

    test('creates with suspension purpose', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/2',
        issuer: 'did:example:issuer',
        statusPurpose: 'suspension',
      });

      const subject = vc.credentialSubject as BitstringStatusListSubject;
      expect(subject.statusPurpose).toBe('suspension');
    });

    test('defaults to 131072 entries', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(manager.getCapacity(vc)).toBe(131072);
    });

    test('accepts custom length >= 131072', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
        length: 262144,
      });

      expect(manager.getCapacity(vc)).toBe(262144);
    });

    test('throws on length below minimum', () => {
      expect(() =>
        manager.createStatusListCredential({
          id: 'https://example.com/status/1',
          issuer: 'did:example:issuer',
          statusPurpose: 'revocation',
          length: 1000,
        })
      ).toThrow(/at least 131072/);
    });

    test('initial bitstring has all zeros', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(manager.getSetCount(vc)).toBe(0);
    });
  });

  describe('allocateStatusEntry', () => {
    test('creates a valid BitstringStatusListEntry', () => {
      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        42,
        'revocation'
      );

      expect(entry.type).toBe('BitstringStatusListEntry');
      expect(entry.statusPurpose).toBe('revocation');
      expect(entry.statusListIndex).toBe('42');
      expect(entry.statusListCredential).toBe('https://example.com/status/1');
      expect(entry.id).toBe('https://example.com/status/1#42');
    });

    test('throws on negative index', () => {
      expect(() =>
        manager.allocateStatusEntry('https://example.com/status/1', -1, 'revocation')
      ).toThrow(/non-negative integer/);
    });

    test('throws on non-integer index', () => {
      expect(() =>
        manager.allocateStatusEntry('https://example.com/status/1', 1.5, 'revocation')
      ).toThrow(/non-negative integer/);
    });

    test('accepts index 0', () => {
      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        0,
        'suspension'
      );
      expect(entry.statusListIndex).toBe('0');
    });
  });

  describe('setStatus', () => {
    test('sets a bit at a given index', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 42, true);
      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        42,
        'revocation'
      );
      const result = manager.checkStatus(entry, updated);
      expect(result.isSet).toBe(true);
    });

    test('clears a bit at a given index', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'suspension',
      });

      const set = manager.setStatus(vc, 100, true);
      const cleared = manager.setStatus(set, 100, false);

      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        100,
        'suspension'
      );
      expect(manager.checkStatus(entry, cleared).isSet).toBe(false);
    });

    test('does not affect other bits', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 42, true);

      const entry41 = manager.allocateStatusEntry(
        'https://example.com/status/1',
        41,
        'revocation'
      );
      const entry43 = manager.allocateStatusEntry(
        'https://example.com/status/1',
        43,
        'revocation'
      );
      expect(manager.checkStatus(entry41, updated).isSet).toBe(false);
      expect(manager.checkStatus(entry43, updated).isSet).toBe(false);
    });

    test('sets issuanceDate on update', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 0, true);
      expect(updated.issuanceDate).toBeDefined();
      expect(typeof updated.issuanceDate).toBe('string');
    });

    test('returns a new credential (immutable)', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 0, true);
      expect(updated).not.toBe(vc);
      expect(manager.getSetCount(vc)).toBe(0);
      expect(manager.getSetCount(updated)).toBe(1);
    });

    test('throws on negative index', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(() => manager.setStatus(vc, -1, true)).toThrow(/non-negative integer/);
    });

    test('throws on index exceeding capacity', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(() => manager.setStatus(vc, 200000, true)).toThrow(/exceeds status list capacity/);
    });

    test('throws on invalid credential type', () => {
      const fakeVC: any = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: {},
      };

      expect(() => manager.setStatus(fakeVC, 0, true)).toThrow(
        /must include type "BitstringStatusListCredential"/
      );
    });
  });

  describe('checkStatus', () => {
    test('returns isSet=false for unset bits', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        0,
        'revocation'
      );

      const result = manager.checkStatus(entry, vc);
      expect(result.isSet).toBe(false);
      expect(result.statusPurpose).toBe('revocation');
      expect(result.statusListIndex).toBe(0);
    });

    test('throws on purpose mismatch', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        0,
        'suspension'
      );

      expect(() => manager.checkStatus(entry, vc)).toThrow(/Status purpose mismatch/);
    });

    test('throws on invalid statusListIndex', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const entry: BitstringStatusListEntry = {
        id: 'https://example.com/status/1#bad',
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: 'not-a-number',
        statusListCredential: 'https://example.com/status/1',
      };

      expect(() => manager.checkStatus(entry, vc)).toThrow(/Invalid statusListIndex/);
    });

    test('throws when index exceeds capacity', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        999999,
        'revocation'
      );

      expect(() => manager.checkStatus(entry, vc)).toThrow(/exceeds status list capacity/);
    });
  });

  describe('batchSetStatus', () => {
    test('sets multiple bits at once', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.batchSetStatus(vc, [
        [0, true],
        [7, true],
        [8, true],
        [100, true],
      ]);

      expect(manager.getSetCount(updated)).toBe(4);
      for (const idx of [0, 7, 8, 100]) {
        const entry = manager.allocateStatusEntry(
          'https://example.com/status/1',
          idx,
          'revocation'
        );
        expect(manager.checkStatus(entry, updated).isSet).toBe(true);
      }
    });

    test('can mix set and clear operations', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const step1 = manager.batchSetStatus(vc, [
        [10, true],
        [20, true],
      ]);
      const step2 = manager.batchSetStatus(step1, [
        [10, false],
        [30, true],
      ]);

      expect(manager.getSetCount(step2)).toBe(2);
      const e10 = manager.allocateStatusEntry('https://example.com/status/1', 10, 'revocation');
      const e20 = manager.allocateStatusEntry('https://example.com/status/1', 20, 'revocation');
      const e30 = manager.allocateStatusEntry('https://example.com/status/1', 30, 'revocation');
      expect(manager.checkStatus(e10, step2).isSet).toBe(false);
      expect(manager.checkStatus(e20, step2).isSet).toBe(true);
      expect(manager.checkStatus(e30, step2).isSet).toBe(true);
    });

    test('throws on invalid index in batch', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(() =>
        manager.batchSetStatus(vc, [
          [0, true],
          [-5, true],
        ])
      ).toThrow(/non-negative integer/);
    });
  });

  describe('encodeBitstring / decodeBitstring', () => {
    test('roundtrips correctly', () => {
      const original = new Uint8Array(16384); // 131072 bits
      original[0] = 0b10000000; // bit 0 set
      original[5] = 0b00100000; // bit 42 set (5*8 + 2 = 42, inverted = bit 5)

      const encoded = StatusListManager.encodeBitstring(original);
      expect(encoded[0]).toBe('u');

      const decoded = StatusListManager.decodeBitstring(encoded);
      expect(decoded.length).toBe(original.length);
      expect(decoded[0]).toBe(original[0]);
      expect(decoded[5]).toBe(original[5]);
    });

    test('decodeBitstring throws on invalid prefix', () => {
      expect(() => StatusListManager.decodeBitstring('z1234')).toThrow(/must start with/);
    });

    test('decodeBitstring throws on empty string', () => {
      expect(() => StatusListManager.decodeBitstring('')).toThrow(/must start with/);
    });
  });

  describe('getCapacity', () => {
    test('returns correct capacity', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(manager.getCapacity(vc)).toBe(131072);
    });
  });

  describe('getSetCount', () => {
    test('returns 0 for empty list', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      expect(manager.getSetCount(vc)).toBe(0);
    });

    test('counts correctly after multiple sets', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.batchSetStatus(vc, [
        [0, true],
        [1, true],
        [2, true],
        [1000, true],
        [50000, true],
      ]);

      expect(manager.getSetCount(updated)).toBe(5);
    });
  });

  describe('validation', () => {
    test('throws on credential missing BitstringStatusListCredential type', () => {
      const fakeVC: any = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { type: 'BitstringStatusList', encodedList: 'u123' },
      };

      expect(() => manager.getCapacity(fakeVC)).toThrow(
        /must include type "BitstringStatusListCredential"/
      );
    });

    test('throws on missing BitstringStatusList subject type', () => {
      const fakeVC: any = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { type: 'Wrong', encodedList: 'u123' },
      };

      expect(() => manager.getCapacity(fakeVC)).toThrow(
        /credentialSubject.type must be "BitstringStatusList"/
      );
    });

    test('throws on missing encodedList', () => {
      const fakeVC: any = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { type: 'BitstringStatusList', statusPurpose: 'revocation' },
      };

      expect(() => manager.getCapacity(fakeVC)).toThrow(/missing encodedList/);
    });
  });

  describe('bit addressing (MSB first)', () => {
    test('bit 0 sets MSB of byte 0', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 0, true);
      const subject = updated.credentialSubject as BitstringStatusListSubject;
      const decoded = StatusListManager.decodeBitstring(subject.encodedList);
      expect(decoded[0]).toBe(0b10000000);
    });

    test('bit 7 sets LSB of byte 0', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 7, true);
      const subject = updated.credentialSubject as BitstringStatusListSubject;
      const decoded = StatusListManager.decodeBitstring(subject.encodedList);
      expect(decoded[0]).toBe(0b00000001);
    });

    test('bit 8 sets MSB of byte 1', () => {
      const vc = manager.createStatusListCredential({
        id: 'https://example.com/status/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      const updated = manager.setStatus(vc, 8, true);
      const subject = updated.credentialSubject as BitstringStatusListSubject;
      const decoded = StatusListManager.decodeBitstring(subject.encodedList);
      expect(decoded[0]).toBe(0);
      expect(decoded[1]).toBe(0b10000000);
    });
  });

  describe('end-to-end revocation flow', () => {
    test('full lifecycle: create list -> allocate entries -> revoke -> check', () => {
      // Issuer creates a status list
      const statusListVC = manager.createStatusListCredential({
        id: 'https://issuer.example/status/revocation/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      // Issuer allocates status entries for credentials
      const cred1Entry = manager.allocateStatusEntry(
        'https://issuer.example/status/revocation/1',
        0,
        'revocation'
      );
      const cred2Entry = manager.allocateStatusEntry(
        'https://issuer.example/status/revocation/1',
        1,
        'revocation'
      );
      const cred3Entry = manager.allocateStatusEntry(
        'https://issuer.example/status/revocation/1',
        2,
        'revocation'
      );

      // Initially none are revoked
      expect(manager.checkStatus(cred1Entry, statusListVC).isSet).toBe(false);
      expect(manager.checkStatus(cred2Entry, statusListVC).isSet).toBe(false);
      expect(manager.checkStatus(cred3Entry, statusListVC).isSet).toBe(false);

      // Revoke credential 2
      const updated = manager.setStatus(statusListVC, 1, true);
      expect(manager.checkStatus(cred1Entry, updated).isSet).toBe(false);
      expect(manager.checkStatus(cred2Entry, updated).isSet).toBe(true);
      expect(manager.checkStatus(cred3Entry, updated).isSet).toBe(false);

      // Revoke credential 1 too
      const updated2 = manager.setStatus(updated, 0, true);
      expect(manager.checkStatus(cred1Entry, updated2).isSet).toBe(true);
      expect(manager.checkStatus(cred2Entry, updated2).isSet).toBe(true);
      expect(manager.checkStatus(cred3Entry, updated2).isSet).toBe(false);
    });

    test('full lifecycle: suspension with un-suspend', () => {
      const statusListVC = manager.createStatusListCredential({
        id: 'https://issuer.example/status/suspension/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'suspension',
      });

      const entry = manager.allocateStatusEntry(
        'https://issuer.example/status/suspension/1',
        500,
        'suspension'
      );

      // Suspend
      const suspended = manager.setStatus(statusListVC, 500, true);
      expect(manager.checkStatus(entry, suspended).isSet).toBe(true);

      // Un-suspend
      const reactivated = manager.setStatus(suspended, 500, false);
      expect(manager.checkStatus(entry, reactivated).isSet).toBe(false);
    });
  });

  describe('integration with CredentialManager', () => {
    test('allocateStatusEntry produces valid credentialStatus for CredentialChainOptions', () => {
      const entry = manager.allocateStatusEntry(
        'https://example.com/status/1',
        42,
        'revocation'
      );

      // Verify the entry shape is compatible with CredentialChainOptions.credentialStatus
      expect(entry.id).toBeDefined();
      expect(entry.type).toBe('BitstringStatusListEntry');
      expect(typeof entry.statusListIndex).toBe('string');
      expect(typeof entry.statusListCredential).toBe('string');
    });

    test('verifyCredentialWithStatus detects revoked credentials', async () => {
      const { OriginalsSDK } = await import('../../../src');
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

      // Create a status list
      const statusListVC = sdk.statusList.createStatusListCredential({
        id: 'https://example.com/status/revocation/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'revocation',
      });

      // Allocate entry for credential at index 42
      const entry = sdk.statusList.allocateStatusEntry(
        'https://example.com/status/revocation/1',
        42,
        'revocation'
      );

      const credential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject', name: 'Test' },
        credentialStatus: entry,
      };

      // Not revoked initially
      const result1 = await sdk.credentials.verifyCredentialWithStatus(
        credential as any,
        statusListVC
      );
      expect(result1.revoked).toBe(false);

      // Revoke the credential
      const updatedStatusList = sdk.statusList.setStatus(statusListVC, 42, true);

      // Now revoked
      const result2 = await sdk.credentials.verifyCredentialWithStatus(
        credential as any,
        updatedStatusList
      );
      expect(result2.revoked).toBe(true);
      expect(result2.errors).toContain('Credential has been revoked');
    });

    test('verifyCredentialWithStatus detects suspended credentials', async () => {
      const { OriginalsSDK } = await import('../../../src');
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

      const statusListVC = sdk.statusList.createStatusListCredential({
        id: 'https://example.com/status/suspension/1',
        issuer: 'did:example:issuer',
        statusPurpose: 'suspension',
      });

      const entry = sdk.statusList.allocateStatusEntry(
        'https://example.com/status/suspension/1',
        10,
        'suspension'
      );

      const credential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject' },
        credentialStatus: entry,
      };

      // Suspend
      const suspended = sdk.statusList.setStatus(statusListVC, 10, true);
      const result = await sdk.credentials.verifyCredentialWithStatus(
        credential as any,
        suspended
      );
      expect(result.suspended).toBe(true);

      // Un-suspend
      const reactivated = sdk.statusList.setStatus(suspended, 10, false);
      const result2 = await sdk.credentials.verifyCredentialWithStatus(
        credential as any,
        reactivated
      );
      expect(result2.suspended).toBe(false);
    });

    test('verifyCredentialWithStatus errors when status list not provided', async () => {
      const { OriginalsSDK } = await import('../../../src');
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

      const entry = sdk.statusList.allocateStatusEntry(
        'https://example.com/status/1',
        0,
        'revocation'
      );

      const credential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject' },
        credentialStatus: entry,
      };

      const result = await sdk.credentials.verifyCredentialWithStatus(
        credential as any
      );
      expect(result.errors.some(e => e.includes('no status list credential was provided'))).toBe(true);
    });

    test('SDK exposes statusList on top-level instance', async () => {
      const { OriginalsSDK, StatusListManager } = await import('../../../src');
      const sdk = OriginalsSDK.create();
      expect(sdk.statusList).toBeInstanceOf(StatusListManager);
    });
  });
});
