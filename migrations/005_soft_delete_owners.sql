-- Migration 005: Soft-delete for wa_owners
-- Adds deleted_at column (nullable timestamp, default null).
-- When an owner is "deleted", deleted_at is set to NOW() instead of removing the row.
-- All queries that load owners must filter WHERE deleted_at IS NULL.

ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Index for efficient filtering of active (non-deleted) owners
CREATE INDEX IF NOT EXISTS idx_owners_active
  ON public.wa_owners (deleted_at) WHERE deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
