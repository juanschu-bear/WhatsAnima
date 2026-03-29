ALTER TABLE wa_perception_logs
  ADD COLUMN IF NOT EXISTS persona_name text DEFAULT NULL;

COMMENT ON COLUMN wa_perception_logs.persona_name IS 'Display name of the avatar/persona that was active when this perception was recorded';
