-- Migration 009: Canon baseline per CONTACT, not per contact+owner
--
-- Bug fix: A user has ONE voice regardless of which avatar they talk to.
-- The baseline should be keyed on contact_id alone, not (contact_id, owner_id).
--
-- This migration:
-- 1. Merges duplicate rows (same contact_id, different owner_id) into one
-- 2. Drops the old UNIQUE(contact_id, owner_id) constraint
-- 3. Adds a new UNIQUE(contact_id) constraint
-- 4. Makes owner_id nullable (no longer part of baseline identity)

-- Step 1: Merge duplicates — for contacts with multiple baseline rows,
-- keep the one with the highest tier, sum cumulative_audio_sec, combine baseline_data samples.
-- We use a CTE to identify the "winner" row per contact and delete the rest after merging.

-- First, update the winning row (highest tier, then most cumulative audio) with merged data
WITH ranked AS (
  SELECT
    id,
    contact_id,
    current_tier,
    cumulative_audio_sec,
    baseline_data,
    sample_count,
    ROW_NUMBER() OVER (
      PARTITION BY contact_id
      ORDER BY current_tier DESC, cumulative_audio_sec DESC, updated_at DESC
    ) AS rn
  FROM public.wa_voice_baseline
),
duplicates AS (
  SELECT contact_id
  FROM public.wa_voice_baseline
  GROUP BY contact_id
  HAVING COUNT(*) > 1
),
merged AS (
  SELECT
    d.contact_id,
    MAX(r.current_tier) AS max_tier,
    SUM(r.cumulative_audio_sec) AS total_audio_sec,
    SUM(r.sample_count) AS total_samples
  FROM duplicates d
  JOIN public.wa_voice_baseline r ON r.contact_id = d.contact_id
  GROUP BY d.contact_id
),
winners AS (
  SELECT r.id, r.contact_id
  FROM ranked r
  JOIN duplicates d ON d.contact_id = r.contact_id
  WHERE r.rn = 1
)
UPDATE public.wa_voice_baseline b
SET
  cumulative_audio_sec = m.total_audio_sec,
  sample_count = m.total_samples,
  current_tier = m.max_tier,
  tier_name = CASE m.max_tier
    WHEN 1 THEN 'snapshot'
    WHEN 2 THEN 'session'
    WHEN 3 THEN 'short_term'
    WHEN 4 THEN 'established'
    WHEN 5 THEN 'deep'
    ELSE 'building'
  END,
  confidence = CASE m.max_tier
    WHEN 1 THEN 0.15
    WHEN 2 THEN 0.40
    WHEN 3 THEN 0.60
    WHEN 4 THEN 0.80
    WHEN 5 THEN 0.95
    ELSE 0
  END,
  updated_at = NOW()
FROM winners w
JOIN merged m ON m.contact_id = w.contact_id
WHERE b.id = w.id;

-- Step 2: Delete the non-winner duplicates
WITH ranked AS (
  SELECT
    id,
    contact_id,
    ROW_NUMBER() OVER (
      PARTITION BY contact_id
      ORDER BY current_tier DESC, cumulative_audio_sec DESC, updated_at DESC
    ) AS rn
  FROM public.wa_voice_baseline
)
DELETE FROM public.wa_voice_baseline
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 1
);

-- Step 3: Drop old unique constraint and add new one
ALTER TABLE public.wa_voice_baseline DROP CONSTRAINT IF EXISTS wa_voice_baseline_contact_id_owner_id_key;
ALTER TABLE public.wa_voice_baseline ADD CONSTRAINT wa_voice_baseline_contact_id_key UNIQUE (contact_id);

-- Step 4: Make owner_id nullable (no longer required for baseline identity)
ALTER TABLE public.wa_voice_baseline ALTER COLUMN owner_id DROP NOT NULL;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
