# Key Rotation and Recovery Guide

This guide covers best practices for key rotation and recovery mechanisms in the Originals SDK, specifically focusing on the `KeyManager` class.

## Overview

Key rotation and recovery are critical security operations in any decentralized identity system. The `KeyManager` class provides robust implementations for both operations:

- **Key Rotation**: Proactive security measure to replace keys on a regular schedule
- **Key Recovery**: Emergency procedure when keys are compromised

## Key Rotation

### When to Rotate Keys

You should rotate keys in the following scenarios:

1. **Scheduled Rotation**: Every 90-180 days as a security best practice
2. **Personnel Changes**: When team members with key access leave
3. **Suspected Exposure**: When keys may have been inadvertently exposed (logs, screenshots, etc.)
4. **System Upgrades**: When migrating to newer cryptographic standards
5. **Compliance Requirements**: When regulatory frameworks mandate rotation

### How Key Rotation Works

The `rotateKeys()` method performs the following operations:

1. **Marks Old Keys as Revoked**: All existing verification methods receive a `revoked` timestamp
2. **Adds New Key**: Creates a new verification method with the provided key pair
3. **Updates Authentication**: Updates `authentication` and `assertionMethod` arrays to reference only the new key
4. **Preserves Context**: Maintains all service endpoints, key agreements, and other DID document properties
5. **Adds Required Contexts**: Ensures proper JSON-LD contexts are present

### Usage Example

```typescript
import { KeyManager } from '@originals/sdk';
import { DIDDocument } from '@originals/sdk/types';

const keyManager = new KeyManager();

// Generate a new key pair for rotation
const newKeyPair = await keyManager.generateKeyPair('Ed25519');

// Rotate keys on existing DID document
const rotatedDoc = await keyManager.rotateKeys(existingDidDoc, newKeyPair);

// Store the rotated DID document
// IMPORTANT: Securely store the new private key (newKeyPair.privateKey)
```

### Best Practices for Key Rotation

1. **Secure the New Private Key**: Store the new private key in a secure key management system immediately
2. **Publish Updated DID Document**: Make the rotated DID document available through your DID method's resolution mechanism
3. **Keep Revoked Keys**: Don't remove revoked keys from the document - they provide an audit trail
4. **Notification**: Notify relevant parties that the key has been rotated
5. **Grace Period**: Maintain the old key in a revoked state for a grace period (e.g., 30 days) before complete retirement
6. **Backup**: Ensure the rotated DID document is backed up to multiple secure locations

### Key Rotation Schedule

Recommended rotation schedules by key type:

- **ES256K (Secp256k1)**: Every 180 days
- **Ed25519**: Every 180 days  
- **ES256 (P-256)**: Every 180 days

High-security environments should rotate keys every 90 days.

## Key Recovery from Compromise

### When to Perform Recovery

Perform an emergency key recovery in these situations:

1. **Confirmed Compromise**: Private key has been leaked or stolen
2. **Suspected Breach**: System breach where keys may have been accessed
3. **Lost Keys**: Private key has been lost without backup
4. **Malicious Activity**: Unauthorized transactions or signatures detected
5. **Insider Threat**: Former administrator with key access becomes hostile

### How Key Recovery Works

The `recoverFromCompromise()` method performs the following operations:

1. **Detects Key Type**: Automatically determines the key type from existing verification methods
2. **Generates New Keys**: Creates a new key pair of the same type
3. **Marks Keys as Compromised**: All existing verification methods are marked with a `compromised` timestamp
4. **Updates Authentication**: Updates authentication arrays to use the new key
5. **Creates Recovery Credential**: Generates a verifiable credential documenting the recovery action
6. **Preserves Properties**: Maintains all service endpoints and other DID document properties

### Usage Example

```typescript
import { KeyManager } from '@originals/sdk';

const keyManager = new KeyManager();

// Perform emergency recovery
const result = await keyManager.recoverFromCompromise(compromisedDidDoc);

// Extract results
const { didDocument, recoveryCredential, newKeyPair } = result;

// CRITICAL: Securely store the new private key immediately
await storePrivateKeySecurely(didDocument.id, newKeyPair.privateKey);

// Publish the recovery credential to provide transparency
// Store it in a verifiable credential registry or publish to a public ledger
```

### Best Practices for Key Recovery

1. **Act Immediately**: Don't delay - every moment counts during a compromise
2. **Document Everything**: The recovery credential provides an audit trail - preserve it
3. **Revoke Old Keys**: The system marks keys as compromised automatically, but ensure they're also revoked in any external key registries
4. **Alert Stakeholders**: Immediately notify all parties who may have relied on the compromised keys
5. **Forensic Analysis**: Conduct a security audit to determine how the compromise occurred
6. **Update Security Procedures**: Improve processes to prevent future compromises
7. **Monitor Activity**: Watch for any unauthorized use of the compromised keys
8. **Legal Compliance**: Follow regulatory reporting requirements for security incidents

### Recovery Credential

The recovery credential is a W3C Verifiable Credential that contains:

- **Issuer**: The DID that was recovered
- **Issuance Date**: Timestamp of the recovery operation
- **Recovery Reason**: Always "key_compromise" for this operation
- **Previous Verification Methods**: List of compromised key IDs
- **New Verification Method**: ID of the new key

This credential provides cryptographic proof of the recovery action and can be:
- Published to a transparency log
- Stored in a verifiable credential registry
- Shared with relying parties
- Used for compliance and audit purposes

## Security Considerations

### Private Key Management

1. **Never Log Private Keys**: Ensure private keys are never written to logs
2. **Use Hardware Security Modules (HSM)**: Store private keys in HSMs when possible
3. **Encrypt at Rest**: Always encrypt private keys when stored
4. **Access Control**: Implement strict access controls for key material
5. **Multi-Party Computation**: Consider MPC for high-value keys

### DID Document Updates

1. **Atomic Updates**: Ensure DID document updates are atomic to prevent race conditions
2. **Version Control**: Maintain version history of DID documents
3. **Availability**: Ensure rotated/recovered DID documents are immediately resolvable
4. **Caching**: Consider cache invalidation when documents are updated

### Monitoring and Alerts

1. **Monitor for Unauthorized Usage**: Watch for signatures from revoked/compromised keys
2. **Set Up Alerts**: Configure alerts for suspicious activity
3. **Audit Logs**: Maintain comprehensive audit logs of all key operations
4. **Regular Reviews**: Conduct regular security reviews of key management practices

## Technical Details

### Verification Method Properties

The `VerificationMethod` type supports security status properties:

```typescript
interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
  revoked?: string;      // ISO 8601 timestamp
  compromised?: string;  // ISO 8601 timestamp
}
```

### Context Requirements

Both operations ensure these contexts are present:

- `https://www.w3.org/ns/did/v1` - Base DID context
- `https://w3id.org/security/multikey/v1` - Multikey cryptography
- `https://w3id.org/security/v1` - Security vocabulary (for revoked/compromised properties)

### Key Type Support

All operations support:

- **ES256K**: Secp256k1 (Bitcoin/Ethereum compatible)
- **Ed25519**: Edwards curve signature scheme
- **ES256**: P-256 NIST curve

## Integration Examples

### Scheduled Rotation with Cron

```typescript
// Rotate keys every 90 days
async function scheduledKeyRotation(did: string) {
  const keyManager = new KeyManager();
  
  // Load current DID document
  const currentDoc = await loadDidDocument(did);
  
  // Generate new key pair
  const newKeyPair = await keyManager.generateKeyPair('Ed25519');
  
  // Rotate keys
  const rotatedDoc = await keyManager.rotateKeys(currentDoc, newKeyPair);
  
  // Securely store new private key
  await storePrivateKeySecurely(did, newKeyPair.privateKey);
  
  // Publish updated DID document
  await publishDidDocument(rotatedDoc);
  
  // Log the rotation
  console.log(`Successfully rotated keys for ${did} at ${new Date().toISOString()}`);
}
```

### Emergency Recovery with Notification

```typescript
async function emergencyRecovery(did: string) {
  const keyManager = new KeyManager();
  
  // Load compromised DID document
  const compromisedDoc = await loadDidDocument(did);
  
  // Perform recovery
  const { didDocument, recoveryCredential, newKeyPair } = await keyManager.recoverFromCompromise(compromisedDoc);
  
  // CRITICAL: Securely store the new private key immediately
  await storePrivateKeySecurely(did, newKeyPair.privateKey);
  
  // Store recovery credential
  await storeRecoveryCredential(recoveryCredential);
  
  // Publish updated DID document immediately
  await publishDidDocumentUrgently(didDocument);
  
  // Send alerts to all stakeholders
  await notifyStakeholders({
    type: 'KEY_COMPROMISE',
    did: did,
    timestamp: recoveryCredential.issuanceDate,
    newKeyId: recoveryCredential.credentialSubject.newVerificationMethod
  });
  
  // Log incident
  await logSecurityIncident({
    type: 'KEY_RECOVERY',
    did: did,
    credential: recoveryCredential
  });
}
```

## Compliance and Auditing

### Audit Trail

Both operations automatically create audit trails:

- **Rotation**: Revoked keys remain in the document with timestamps
- **Recovery**: Recovery credential provides verifiable proof

### Regulatory Requirements

Consider these compliance frameworks:

- **SOC 2**: Document key rotation policies and procedures
- **ISO 27001**: Implement cryptographic key management controls
- **PCI DSS**: Rotate keys in accordance with payment card industry standards
- **GDPR**: Ensure key recovery procedures protect personal data

## Troubleshooting

### Common Issues

**Problem**: `rotateKeys()` not updating authentication arrays
- **Solution**: Ensure the DID document is properly formatted with existing verification methods

**Problem**: `recoverFromCompromise()` generates wrong key type
- **Solution**: The method auto-detects key type from existing keys. If no keys exist, it defaults to Ed25519

**Problem**: Rotated keys not resolving
- **Solution**: Verify the updated DID document has been published to the resolution service

**Problem**: Recovery credential validation fails
- **Solution**: Ensure all required contexts are present and the credential follows W3C VC spec

## Additional Resources

- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
- [Multikey Specification](https://w3c-ccg.github.io/multikey/)
- [DID Security and Privacy Considerations](https://www.w3.org/TR/did-core/#security-and-privacy-considerations)

## Support

For questions or issues with key rotation and recovery:

1. Check the test suite in `tests/did/KeyManager.test.ts` for examples
2. Review the KeyManager source code in `src/did/KeyManager.ts`
3. Open an issue in the project repository
4. Contact the security team for compromise incidents
