-- Migration: Add layer tracking and DID storage for assets
-- This migration adds columns to track which layer an asset is in (did:peer, did:webvh, did:btco)
-- and stores the DID identifiers for each layer along with provenance history

ALTER TABLE assets ADD COLUMN current_layer TEXT DEFAULT 'did:peer';
ALTER TABLE assets ADD COLUMN did_peer TEXT;
ALTER TABLE assets ADD COLUMN did_webvh TEXT;
ALTER TABLE assets ADD COLUMN did_btco TEXT;
ALTER TABLE assets ADD COLUMN provenance JSONB;
ALTER TABLE assets ADD COLUMN did_document JSONB;

-- Create indexes for efficient querying
CREATE INDEX idx_assets_current_layer ON assets(current_layer);
CREATE INDEX idx_assets_did_peer ON assets(did_peer);
CREATE INDEX idx_assets_did_webvh ON assets(did_webvh);
CREATE INDEX idx_assets_did_btco ON assets(did_btco);

-- Add comments for documentation
COMMENT ON COLUMN assets.current_layer IS 'Current layer of the asset: did:peer (private), did:webvh (web), or did:btco (bitcoin)';
COMMENT ON COLUMN assets.did_peer IS 'DID identifier for the peer layer (e.g., did:peer:abc123)';
COMMENT ON COLUMN assets.did_webvh IS 'DID identifier for the web layer (e.g., did:webvh:domain.com:abc123)';
COMMENT ON COLUMN assets.did_btco IS 'DID identifier for the Bitcoin layer (e.g., did:btco:1234567890)';
COMMENT ON COLUMN assets.provenance IS 'Complete provenance chain including migrations and transfers';
COMMENT ON COLUMN assets.did_document IS 'Complete DID document for the asset';
