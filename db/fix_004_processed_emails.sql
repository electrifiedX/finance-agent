-- db/fix_004_processed_emails.sql
-- Add tracking columns the Gmail ingestion job uses. Safe/idempotent.
-- psql "$DATABASE_URL" -f db/fix_004_processed_emails.sql

ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS bank   TEXT;
ALTER TABLE processed_emails ADD COLUMN IF NOT EXISTS status TEXT;
