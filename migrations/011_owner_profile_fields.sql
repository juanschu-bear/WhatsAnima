-- Migration 011: Add profile metadata fields to owners
ALTER TABLE public.wa_owners
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS expertise text;
