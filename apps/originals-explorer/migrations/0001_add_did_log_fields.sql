-- Migration: Add DID log and slug fields to users table
-- This migration adds support for storing DID logs (did.jsonl) and user slugs

ALTER TABLE "users" ADD COLUMN "did_log" jsonb;
ALTER TABLE "users" ADD COLUMN "did_slug" text;

-- Create index on did_slug for faster lookups
CREATE INDEX IF NOT EXISTS "idx_users_did_slug" ON "users" ("did_slug");

-- Add comment to explain the fields
COMMENT ON COLUMN "users"."did_log" IS 'DID log entries in JSONL format (array of log entries)';
COMMENT ON COLUMN "users"."did_slug" IS 'User slug extracted from DID for URL routing';
