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

export * from './PeerCelManager';
export * from './WebVHCelManager';
export * from './BtcoCelManager';
