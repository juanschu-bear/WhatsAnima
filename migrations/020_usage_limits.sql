-- Usage limits for testing and future billing
CREATE TABLE IF NOT EXISTS public.wa_usage_limits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  call_minutes_used float NOT NULL DEFAULT 0,
  call_minutes_limit float NOT NULL DEFAULT 60,
  voice_count_used integer NOT NULL DEFAULT 0,
  voice_count_limit integer NOT NULL DEFAULT 200,
  video_count_used integer NOT NULL DEFAULT 0,
  video_count_limit integer NOT NULL DEFAULT 100,
  reset_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.wa_usage_limits ENABLE ROW LEVEL SECURITY;

-- Users can read their own limits
CREATE POLICY "usage_own_select" ON public.wa_usage_limits
  FOR SELECT USING (user_id = auth.uid());

-- Service key handles inserts/updates from API
CREATE POLICY "usage_insert" ON public.wa_usage_limits
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "usage_update" ON public.wa_usage_limits
  FOR UPDATE USING (TRUE);
