-- Migration: Add Google Drive import functionality
-- Date: 2025-10-15

-- Add source tracking columns to assets table
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source VARCHAR DEFAULT 'manual';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_metadata JSONB;

COMMENT ON COLUMN assets.source IS 'Origin of the asset: manual, google-drive-import, etc.';
COMMENT ON COLUMN assets.source_metadata IS 'Source-specific metadata (e.g., Google Drive file ID, links)';

-- Create google_drive_imports table
CREATE TABLE IF NOT EXISTS google_drive_imports (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  total_files VARCHAR,
  processed_files VARCHAR DEFAULT '0',
  failed_files VARCHAR DEFAULT '0',
  error_details JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

COMMENT ON TABLE google_drive_imports IS 'Tracks Google Drive folder import sessions';
COMMENT ON COLUMN google_drive_imports.folder_id IS 'Google Drive folder ID';
COMMENT ON COLUMN google_drive_imports.status IS 'Import status: pending, processing, completed, failed';
COMMENT ON COLUMN google_drive_imports.error_details IS 'Array of error objects for failed files';

-- Create index for querying imports by user
CREATE INDEX IF NOT EXISTS idx_google_drive_imports_user_id ON google_drive_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_google_drive_imports_status ON google_drive_imports(status);

-- Create index for querying assets by source
CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);

