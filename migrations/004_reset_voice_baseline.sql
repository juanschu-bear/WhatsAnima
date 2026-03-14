-- 004_reset_voice_baseline.sql
--
-- Reset Canon voice baseline: the existing data was built from Haiku fallback,
-- not real OPM/ECHO prosodic data. Canon must only build on genuine OPM output.
--
-- This resets ALL baseline rows to tier-0 ("building") state so Canon
-- recalibrates cleanly once enough real OPM data accumulates.

UPDATE wa_voice_baseline SET
  cumulative_audio_sec = 0,
  sample_count         = 0,
  baseline_data        = '{}'::jsonb,
  current_tier         = 0,
  tier_name            = 'building',
  confidence           = 0,
  locked_at            = NULL,
  updated_at           = now();
