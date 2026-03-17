ALTER TABLE wa_perception_logs
  ADD COLUMN IF NOT EXISTS facial_analysis jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS body_language jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS media_type text DEFAULT 'audio',
  ADD COLUMN IF NOT EXISTS video_duration_sec integer DEFAULT NULL;

COMMENT ON COLUMN wa_perception_logs.facial_analysis IS 'CYGNUS output: action_units (46 AUs), gaze_direction, head_pose, micro_expressions, face_confidence';
COMMENT ON COLUMN wa_perception_logs.body_language IS 'CYGNUS output: body_pose (33 landmarks), hand_gestures, posture_score, movement_patterns';
COMMENT ON COLUMN wa_perception_logs.media_type IS 'audio or video — determines which analysis pipeline was used';
COMMENT ON COLUMN wa_perception_logs.video_duration_sec IS 'Duration of video in seconds (null for audio-only messages)';
