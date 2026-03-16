import { describe, test, expect } from 'bun:test';
import {
  StatusListManager,
  type StatusListOptions,
  type StatusCheckResult,
} from '../../../src/vc/StatusListManager';
import { BitstringStatusList } from '../../../src/vc/BitstringStatusList';
import type {
  VerifiableCredential,
  BitstringStatusListEntry,
} from '../../../src/types/credentials';

// ============================================================
// StatusListManager tests (W3C Bitstring Status List v1.0)
// ============================================================

describe('StatusListManager', () => {
  const manager = new StatusListManager();
  const listId = 'https://example.com/credentials/status/1';
  const issuer = 'did:example:issuer';

  function createStatusListVC(purpose: 'revocation' | 'suspension' = 'revocation') {
    return manager.createStatusListCredential({
      id: listId,
      issuer,
      statusPurpose: purpose,
    });
  }

  describe('createStatusListCredential', () => {
    test('creates a valid BitstringStatusListCredential', () => {
      const vc = createStatusListVC();

      expect(vc.type).toContain('VerifiableCredential');
      expect(vc.type).toContain('BitstringStatusListCredential');
      expect(vc.id).toBe(listId);
      expect(vc.issuer).toBe(issuer);
      expect(vc.issuanceDate).toBeDefined();
      expect(vc.credentialSubject.type).toBe('BitstringStatusList');
      expect(vc.credentialSubject.statusPurpose).toBe('revocation');
      expect(vc.credentialSubject.encodedList).toBeDefined();
    });

    test('uses W3C credentials v2 context', () => {
      const vc = createStatusListVC();
      expect(vc['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    });

    test('creates all-zeros bitstring by default', () => {
      const vc = createStatusListVC();
      const bitstring = StatusListManager.decodeBitstring(vc.credentialSubject.encodedList);
      for (const byte of bitstring) {
        expect(byte).toBe(0);
      }
    });

    test('enforces minimum bitstring length of 131072', () => {
      expect(() =>
        manager.createStatusListCredential({
          id: listId,
          issuer,
          statusPurpose: 'revocation',
          length: 100,
        })
      ).toThrow('131072');
    });

    test('allows custom length >= 131072', () => {
      const vc = manager.createStatusListCredential({
        id: listId,
        issuer,
        statusPurpose: 'revocation',
        length: 262144,
      });
      const capacity = manager.getCapacity(vc);
      expect(capacity).toBe(262144);
    });

    test('supports suspension purpose', () => {
      const vc = createStatusListVC('suspension');
      expect(vc.credentialSubject.statusPurpose).toBe('suspension');
    });
  });

  describe('allocateStatusEntry', () => {
    test('creates a valid BitstringStatusListEntry', () => {
      const entry = manager.allocateStatusEntry(listId, 42, 'revocation');

      expect(entry.id).toBe(`${listId}#42`);
      expect(entry.type).toBe('BitstringStatusListEntry');
      expect(entry.statusPurpose).toBe('revocation');
      expect(entry.statusListIndex).toBe('42');
      expect(entry.statusListCredential).toBe(listId);
    });

    test('rejects negative index', () => {
      expect(() => manager.allocateStatusEntry(listId, -1, 'revocation')).toThrow();
    });

    test('rejects non-integer index', () => {
      expect(() => manager.allocateStatusEntry(listId, 3.5, 'revocation')).toThrow();
    });
  });

  describe('setStatus / checkStatus', () => {
    test('sets a single bit and verifies it', () => {
      let vc = createStatusListVC();
      const entry = manager.allocateStatusEntry(listId, 0, 'revocation');

      // Initially not set
      let result = manager.checkStatus(entry, vc);
      expect(result.isSet).toBe(false);

      // Set the bit
      vc = manager.setStatus(vc, 0, true);
      result = manager.checkStatus(entry, vc);
      expect(result.isSet).toBe(true);
      expect(result.statusPurpose).toBe('revocation');
      expect(result.statusListIndex).toBe(0);
    });

    test('can clear a set bit', () => {
      let vc = createStatusListVC();
      vc = manager.setStatus(vc, 10, true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 10, 'revocation'), vc).isSet).toBe(true);

      vc = manager.setStatus(vc, 10, false);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 10, 'revocation'), vc).isSet).toBe(false);
    });

    test('sets bits independently', () => {
      let vc = createStatusListVC();
      vc = manager.setStatus(vc, 0, true);
      vc = manager.setStatus(vc, 7, true);
      vc = manager.setStatus(vc, 42, true);

      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 0, 'revocation'), vc).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 1, 'revocation'), vc).isSet).toBe(false);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 7, 'revocation'), vc).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 42, 'revocation'), vc).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 43, 'revocation'), vc).isSet).toBe(false);
    });

    test('uses MSB-first bit ordering per W3C spec', () => {
      let vc = createStatusListVC();
      // Bit 0 should be MSB of byte 0
      vc = manager.setStatus(vc, 0, true);
      const bitstring = StatusListManager.decodeBitstring(vc.credentialSubject.encodedList);
      expect(bitstring[0] & 0x80).toBe(0x80);
      // Bit 7 should be LSB of byte 0
      vc = manager.setStatus(vc, 7, true);
      const bitstring2 = StatusListManager.decodeBitstring(vc.credentialSubject.encodedList);
      expect(bitstring2[0] & 0x01).toBe(0x01);
    });

    test('rejects negative index', () => {
      const vc = createStatusListVC();
      expect(() => manager.setStatus(vc, -1, true)).toThrow();
    });

    test('rejects index exceeding capacity', () => {
      const vc = createStatusListVC();
      const capacity = manager.getCapacity(vc);
      expect(() => manager.setStatus(vc, capacity, true)).toThrow();
    });

    test('returns immutable credential (does not mutate input)', () => {
      const vc = createStatusListVC();
      const updated = manager.setStatus(vc, 0, true);
      // Original should be unchanged
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 0, 'revocation'), vc).isSet).toBe(false);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 0, 'revocation'), updated).isSet).toBe(true);
    });

    test('purpose mismatch throws', () => {
      const vc = createStatusListVC('revocation');
      const entry = manager.allocateStatusEntry(listId, 0, 'suspension');
      expect(() => manager.checkStatus(entry, vc)).toThrow('purpose mismatch');
    });
  });

  describe('batchSetStatus', () => {
    test('sets multiple bits at once', () => {
      const vc = createStatusListVC();
      const updated = manager.batchSetStatus(vc, [
        [0, true],
        [10, true],
        [100, true],
      ]);

      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 0, 'revocation'), updated).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 10, 'revocation'), updated).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 100, 'revocation'), updated).isSet).toBe(true);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 50, 'revocation'), updated).isSet).toBe(false);
    });

    test('can mix set and clear operations', () => {
      let vc = createStatusListVC();
      vc = manager.setStatus(vc, 5, true);
      const updated = manager.batchSetStatus(vc, [
        [5, false],  // clear
        [10, true],  // set
      ]);

      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 5, 'revocation'), updated).isSet).toBe(false);
      expect(manager.checkStatus(manager.allocateStatusEntry(listId, 10, 'revocation'), updated).isSet).toBe(true);
    });
  });

  describe('getCapacity', () => {
    test('returns default capacity of 131072', () => {
      const vc = createStatusListVC();
      expect(manager.getCapacity(vc)).toBe(131072);
    });
  });

  describe('getSetCount', () => {
    test('returns 0 for empty list', () => {
      const vc = createStatusListVC();
      expect(manager.getSetCount(vc)).toBe(0);
    });

    test('counts set bits accurately', () => {
      let vc = createStatusListVC();
      vc = manager.batchSetStatus(vc, [
        [0, true],
        [1, true],
        [100, true],
      ]);
      expect(manager.getSetCount(vc)).toBe(3);
    });
  });

  describe('encode/decode bitstring', () => {
    test('roundtrips through encode/decode', () => {
      const original = new Uint8Array(16384);
      original[0] = 0x80;
      original[100] = 0xFF;
      const encoded = StatusListManager.encodeBitstring(original);
      const decoded = StatusListManager.decodeBitstring(encoded);
      expect(decoded).toEqual(original);
    });

    test('encoded format starts with multibase prefix u', () => {
      const bitstring = new Uint8Array(16384);
      const encoded = StatusListManager.encodeBitstring(bitstring);
      expect(encoded[0]).toBe('u');
    });

    test('decode rejects missing multibase prefix', () => {
      expect(() => StatusListManager.decodeBitstring('InvalidData')).toThrow('multibase');
    });
  });

  describe('validation', () => {
    test('rejects non-BitstringStatusListCredential for setStatus', () => {
      const badVC: VerifiableCredential = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'test' },
      };
      expect(() => manager.setStatus(badVC, 0, true)).toThrow('BitstringStatusListCredential');
    });

    test('rejects credential with wrong subject type', () => {
      const badVC: VerifiableCredential = {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: 'did:example:issuer',
        issuanceDate: new Date().toISOString(),
        credentialSubject: { type: 'WrongType', encodedList: 'u' },
      };
      expect(() => manager.setStatus(badVC, 0, true)).toThrow('BitstringStatusList');
    });
  });
});

// ============================================================
// BitstringStatusList (low-level) tests
// ============================================================

describe('BitstringStatusList', () => {
  test('creates a list with minimum size', () => {
    const list = new BitstringStatusList();
    expect(list.length).toBe(131072);
  });

  test('rejects size below minimum', () => {
    expect(() => new BitstringStatusList(100)).toThrow('131072');
  });

  test('set/get individual bits', () => {
    const list = new BitstringStatusList();
    expect(list.get(0)).toBe(false);
    list.set(0);
    expect(list.get(0)).toBe(true);
    expect(list.get(1)).toBe(false);
  });

  test('clear a set bit', () => {
    const list = new BitstringStatusList();
    list.set(42);
    expect(list.get(42)).toBe(true);
    list.clear(42);
    expect(list.get(42)).toBe(false);
  });

  test('uses MSB-first ordering', () => {
    const list = new BitstringStatusList();
    list.set(0);
    const encoded = list.encode();
    const decoded = BitstringStatusList.decode(encoded);
    expect(decoded.get(0)).toBe(true);
    expect(decoded.get(1)).toBe(false);
  });

  test('encode/decode roundtrip', () => {
    const list = new BitstringStatusList();
    list.set(0);
    list.set(7);
    list.set(131071);

    const encoded = list.encode();
    const decoded = BitstringStatusList.decode(encoded);
    expect(decoded.get(0)).toBe(true);
    expect(decoded.get(7)).toBe(true);
    expect(decoded.get(131071)).toBe(true);
    expect(decoded.get(1)).toBe(false);
  });

  test('throws for out-of-range index', () => {
    const list = new BitstringStatusList();
    expect(() => list.get(-1)).toThrow();
    expect(() => list.get(131072)).toThrow();
    expect(() => list.set(-1)).toThrow();
  });
});

// ============================================================
// Integration: credential with revocation status
// ============================================================

describe('credential revocation workflow', () => {
  test('full lifecycle: issue, embed status, revoke, check', () => {
    const manager = new StatusListManager();
    const listId = 'https://example.com/credentials/status/revocation';
    const issuer = 'did:example:issuer';

    // 1. Create status list credential
    let statusListVC = manager.createStatusListCredential({
      id: listId,
      issuer,
      statusPurpose: 'revocation',
    });

    // 2. Allocate a status entry for a new credential
    const entry = manager.allocateStatusEntry(listId, 42, 'revocation');

    // 3. Create a credential with the status entry
    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:subject', name: 'Alice' },
      credentialStatus: entry,
    };

    // 4. Verify credential is NOT revoked
    const result1 = manager.checkStatus(
      credential.credentialStatus as BitstringStatusListEntry,
      statusListVC
    );
    expect(result1.isSet).toBe(false);

    // 5. Revoke the credential
    statusListVC = manager.setStatus(statusListVC, 42, true);

    // 6. Verify credential IS now revoked
    const result2 = manager.checkStatus(
      credential.credentialStatus as BitstringStatusListEntry,
      statusListVC
    );
    expect(result2.isSet).toBe(true);
    expect(result2.statusPurpose).toBe('revocation');
  });

  test('suspension lifecycle: suspend, check, reinstate, check', () => {
    const manager = new StatusListManager();
    const listId = 'https://example.com/credentials/status/suspension';
    const issuer = 'did:example:issuer';

    let statusListVC = manager.createStatusListCredential({
      id: listId,
      issuer,
      statusPurpose: 'suspension',
    });

    const entry = manager.allocateStatusEntry(listId, 10, 'suspension');

    // Not suspended initially
    expect(manager.checkStatus(entry, statusListVC).isSet).toBe(false);

    // Suspend
    statusListVC = manager.setStatus(statusListVC, 10, true);
    expect(manager.checkStatus(entry, statusListVC).isSet).toBe(true);

    // Reinstate
    statusListVC = manager.setStatus(statusListVC, 10, false);
    expect(manager.checkStatus(entry, statusListVC).isSet).toBe(false);
  });
});
