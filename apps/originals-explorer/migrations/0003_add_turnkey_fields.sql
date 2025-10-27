-- Add Turnkey authentication fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS turnkey_sub_org_id text UNIQUE;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_turnkey_sub_org_id ON users(turnkey_sub_org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

