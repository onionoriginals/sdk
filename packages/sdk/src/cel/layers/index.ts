/**
 * CEL Layer Managers
 * 
 * Layer managers handle CEL-based asset creation and management at different
 * trust/persistence layers of the Originals Protocol:
 * 
 * - PeerCelManager: Layer 0 (did:peer) - Local control, no witnesses
 * - WebVHCelManager: Layer 1 (did:webvh) - HTTP-based witnessing
 * - BtcoCelManager: Layer 2 (did:btco) - Bitcoin-based witnessing
 */

// Export everything from PeerCelManager including CelSigner type
export * from './PeerCelManager';

// Export specific items from WebVHCelManager (CelSigner is imported from PeerCelManager)
export { 
  WebVHCelManager, 
  type WebVHCelConfig, 
  type WebVHMigrationData 
} from './WebVHCelManager';

// Export specific items from BtcoCelManager (CelSigner is imported from PeerCelManager)
export { 
  BtcoCelManager, 
  type BtcoCelConfig, 
  type BtcoMigrationData,
  type FinalArtifactMaterialization,
  type FinalAnchoringAttestation
} from './BtcoCelManager';
