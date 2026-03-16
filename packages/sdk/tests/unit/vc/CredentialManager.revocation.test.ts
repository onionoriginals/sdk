import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { StatusListManager } from '../../../src/vc/StatusListManager';
import type { VerifiableCredential, BitstringStatusListEntry } from '../../../src/types';

describe('CredentialManager - Revocation', () => {
  const config = { network: 'regtest' as const, defaultKeyType: 'Ed25519' as const, enableLogging: false };
  const credentialManager = new CredentialManager(config);
  const statusListManager = new StatusListManager();

  const issuerDid = 'did:example:issuer';
  const statusListId = 'https://issuer.example/status/revocation/1';
  const suspensionListId = 'https://issuer.example/status/suspension/1';

  function createCredentialWithStatus(
    entry: BitstringStatusListEntry
  ): VerifiableCredential {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'ResourceCreated'],
      id: 'urn:uuid:test-credential',
      issuer: issuerDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:subject' },
      credentialStatus: entry,
    };
  }

  describe('revokeCredential', () => {
    test('revokes a credential by setting its status bit', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 42, 'revocation');
      const credential = createCredentialWithStatus(entry);

      const updatedList = credentialManager.revokeCredential(credential, statusListVC);
      expect(credentialManager.isRevoked(credential, updatedList)).toBe(true);
    });

    test('throws if credential has no credentialStatus', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: issuerDid,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject' },
      };

      expect(() => credentialManager.revokeCredential(credential, statusListVC)).toThrow(
        /no credentialStatus/
      );
    });

    test('throws if status purpose is suspension instead of revocation', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: suspensionListId,
        issuer: issuerDid,
        statusPurpose: 'suspension',
      });

      const entry = statusListManager.allocateStatusEntry(suspensionListId, 0, 'suspension');
      const credential = createCredentialWithStatus(entry);

      expect(() => credentialManager.revokeCredential(credential, statusListVC)).toThrow(
        /expected 'revocation'/
      );
    });

    test('throws if credentialStatus type is not BitstringStatusListEntry', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: issuerDid,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject' },
        credentialStatus: { id: 'some-id', type: 'UnknownType' },
      };

      expect(() => credentialManager.revokeCredential(credential, statusListVC)).toThrow(
        /Unsupported credentialStatus type/
      );
    });
  });

  describe('suspendCredential', () => {
    test('suspends a credential by setting its status bit', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: suspensionListId,
        issuer: issuerDid,
        statusPurpose: 'suspension',
      });

      const entry = statusListManager.allocateStatusEntry(suspensionListId, 10, 'suspension');
      const credential = createCredentialWithStatus(entry);

      const updatedList = credentialManager.suspendCredential(credential, statusListVC);
      const result = credentialManager.checkRevocationStatus(credential, updatedList);
      expect(result.isSet).toBe(true);
      expect(result.statusPurpose).toBe('suspension');
    });

    test('throws if status purpose is revocation instead of suspension', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');
      const credential = createCredentialWithStatus(entry);

      expect(() => credentialManager.suspendCredential(credential, statusListVC)).toThrow(
        /expected 'suspension'/
      );
    });
  });

  describe('unsuspendCredential', () => {
    test('unsuspends a previously suspended credential', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: suspensionListId,
        issuer: issuerDid,
        statusPurpose: 'suspension',
      });

      const entry = statusListManager.allocateStatusEntry(suspensionListId, 10, 'suspension');
      const credential = createCredentialWithStatus(entry);

      // Suspend first
      const suspended = credentialManager.suspendCredential(credential, statusListVC);
      expect(credentialManager.checkRevocationStatus(credential, suspended).isSet).toBe(true);

      // Unsuspend
      const unsuspended = credentialManager.unsuspendCredential(credential, suspended);
      expect(credentialManager.checkRevocationStatus(credential, unsuspended).isSet).toBe(false);
    });

    test('throws if status purpose is revocation', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');
      const credential = createCredentialWithStatus(entry);

      expect(() => credentialManager.unsuspendCredential(credential, statusListVC)).toThrow(
        /expected 'suspension'/
      );
    });
  });

  describe('checkRevocationStatus', () => {
    test('returns isSet=false for non-revoked credential', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');
      const credential = createCredentialWithStatus(entry);

      const result = credentialManager.checkRevocationStatus(credential, statusListVC);
      expect(result.isSet).toBe(false);
      expect(result.statusPurpose).toBe('revocation');
      expect(result.statusListIndex).toBe(0);
    });

    test('returns isSet=true for revoked credential', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 5, 'revocation');
      const credential = createCredentialWithStatus(entry);

      const updatedList = credentialManager.revokeCredential(credential, statusListVC);
      const result = credentialManager.checkRevocationStatus(credential, updatedList);
      expect(result.isSet).toBe(true);
      expect(result.statusListIndex).toBe(5);
    });
  });

  describe('isRevoked', () => {
    test('returns false for non-revoked credential', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');
      const credential = createCredentialWithStatus(entry);

      expect(credentialManager.isRevoked(credential, statusListVC)).toBe(false);
    });

    test('returns true for revoked credential', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');
      const credential = createCredentialWithStatus(entry);

      const updatedList = credentialManager.revokeCredential(credential, statusListVC);
      expect(credentialManager.isRevoked(credential, updatedList)).toBe(true);
    });
  });

  describe('end-to-end: issue with status + revoke', () => {
    test('issue credential with revocation entry via factory, then revoke', () => {
      // Create a status list
      const statusListVC = statusListManager.createStatusListCredential({
        id: statusListId,
        issuer: issuerDid,
        statusPurpose: 'revocation',
      });

      // Allocate a status entry
      const entry = statusListManager.allocateStatusEntry(statusListId, 0, 'revocation');

      // Issue a credential with the status entry via CredentialChainOptions
      const resource = {
        id: 'main.ts',
        type: 'code',
        hash: 'abc123',
        contentType: 'application/typescript',
        content: '',
      };
      const credential = credentialManager.issueResourceCredential(
        resource,
        'did:peer:asset123',
        issuerDid,
        { credentialStatus: entry }
      );

      // Verify the status entry is embedded
      expect(credential.credentialStatus).toBeDefined();
      expect(credential.credentialStatus!.type).toBe('BitstringStatusListEntry');

      // Initially not revoked
      expect(credentialManager.isRevoked(credential, statusListVC)).toBe(false);

      // Revoke it
      const updatedList = credentialManager.revokeCredential(credential, statusListVC);
      expect(credentialManager.isRevoked(credential, updatedList)).toBe(true);
    });

    test('issue credential with suspension entry, suspend and unsuspend', () => {
      const statusListVC = statusListManager.createStatusListCredential({
        id: suspensionListId,
        issuer: issuerDid,
        statusPurpose: 'suspension',
      });

      const entry = statusListManager.allocateStatusEntry(suspensionListId, 99, 'suspension');

      const resource = {
        id: 'index.html',
        type: 'text',
        hash: 'def456',
        contentType: 'text/html',
        content: '',
      };
      const credential = credentialManager.issueResourceCredential(
        resource,
        'did:peer:asset456',
        issuerDid,
        { credentialStatus: entry }
      );

      // Initially not suspended
      const result1 = credentialManager.checkRevocationStatus(credential, statusListVC);
      expect(result1.isSet).toBe(false);

      // Suspend
      const suspended = credentialManager.suspendCredential(credential, statusListVC);
      expect(credentialManager.checkRevocationStatus(credential, suspended).isSet).toBe(true);

      // Unsuspend
      const unsuspended = credentialManager.unsuspendCredential(credential, suspended);
      expect(credentialManager.checkRevocationStatus(credential, unsuspended).isSet).toBe(false);
    });
  });
});
