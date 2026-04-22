-- Migration 023: extend cfo_transactions with Google Drive and Sheets linkage
--
-- drive_url          — public/shareable URL of the uploaded receipt image in Drive
-- sheets_row_index   — 1-based index of the appended row in the CFO Sheet
--                      (null if the Sheets append failed)
--
-- Both columns are nullable because the pipeline is best-effort:
-- the Supabase row is written even if Drive or Sheets fail, so the data
-- is never lost. Backfill of earlier rows is intentionally skipped.

ALTER TABLE cfo_transactions
  ADD COLUMN IF NOT EXISTS drive_url text,
  ADD COLUMN IF NOT EXISTS sheets_row_index integer;
