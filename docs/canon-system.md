# Canon: Personal Baseline Calibration System

## Overview

Canon is WhatsAnima's personalized audio calibration system. It replaces generic emotion labels (like "neutral") with individualized baselines — because every person has their own tonal center, speaking rhythm, and emotional resting state.

**Core principle:** "Neutral" doesn't exist. What OPM labels as "neutral" is simply the absence of a population-average match. Canon solves this by building a personal reference point for each contact, then measuring everything as a delta from **their** center.

---

## Architecture

### Data Flow (Before Canon)

```
Voice Message → OPM → Generic Emotion Label → Avatar Response
                       "neutral" / "happy"
                       (against population average)
```

**Problem:** Two separate database inserts per message. OPM data (emotions, prosody, rules) stored without a `message_id`. Basic data (transcript, duration) stored separately with `message_id`. No cumulative tracking.

### Data Flow (After Canon)

```
Voice/Video Message
       │
       ▼
   callOpmApi()          ← Pure proxy, no DB write
       │
       ▼
   sendMessage()         ← Creates message, gets message_id
       │
       ▼
   createPerceptionLog() ← SINGLE insert with ALL data + Canon logic
       │
       ├── Insert perception log (message_id + OPM data unified)
       ├── Calculate cumulative audio duration
       ├── Check/create baseline
       └── Compute personal delta
       │
       ▼
   Avatar receives:
   - Raw OPM data
   - Canon phase status
   - Personal delta (if baseline locked)
```

---

## Two-Phase System

### Phase 1: Building (0–60 seconds cumulative)

| Aspect | Description |
|--------|-------------|
| **Trigger** | Every voice message contributes to the total |
| **Accumulation** | Seconds are summed across ALL messages from this contact |
| **Status** | `building` — shown as progress percentage |
| **Analysis** | OPM still runs normally, but no delta comparison |
| **Example** | Msg 1 (18s) + Msg 2 (24s) + Msg 3 (21s) = 63s total |

Messages are **never skipped** due to being too short. An 8-second voice note contributes 8 seconds to the cumulative total.

### Phase 2: Baseline Locked (60+ seconds cumulative)

| Aspect | Description |
|--------|-------------|
| **Trigger** | The message that crosses the 60-second threshold |
| **Computation** | Averages all collected prosodic features |
| **Status** | `baseline_locked` (first time) → `analyzing_delta` (ongoing) |
| **Storage** | Persisted in `wa_voice_baseline` table |
| **Result** | Every subsequent message measured as delta from personal center |

### Phase 3: Analyzing Delta (all subsequent messages)

| Aspect | Description |
|--------|-------------|
| **Delta computation** | Each prosodic feature compared to personal average |
| **Emotion context** | "neutral" replaced with "at personal center" |
| **Unusual detection** | Emotions occurring <15% of the time flagged as unusual |
| **Significance thresholds** | Changes >15% from personal norm are surfaced |

---

## Prosodic Features Tracked

Canon tracks and averages these features from Cygnus Echo:

| Feature | Description | Unit | Why It Matters |
|---------|-------------|------|----------------|
| `mean_pitch` | Average fundamental frequency | Hz | Higher when stressed/excited, lower when calm/tired |
| `pitch_range` | Difference between highest and lowest pitch | Hz | Narrows when monotone, widens when animated |
| `pitch_variability` | Standard deviation of pitch | Hz | Low = flat delivery, high = expressive |
| `speaking_rate` | Words per second | words/s | Faster when nervous/excited, slower when thoughtful |
| `articulation_rate` | Syllables per second (excluding pauses) | syl/s | Pure speech speed without silence |
| `pause_count` | Number of pauses per message | count | More pauses can indicate hesitation or emphasis |
| `mean_pause_duration` | Average length of pauses | seconds | Longer pauses = more processing/hesitation |
| `pause_ratio` | Proportion of message that is silence | ratio | High ratio = many/long pauses |
| `volume_mean` | Average loudness | dB | Louder = more energetic/emphatic |
| `volume_range` | Difference between loudest and quietest | dB | Wide range = dynamic expression |
| `volume_variability` | Standard deviation of volume | dB | How much volume fluctuates |
| `jitter` | Cycle-to-cycle pitch variation | ratio | Involuntary vocal quality marker |
| `shimmer` | Cycle-to-cycle amplitude variation | ratio | Voice stability/roughness indicator |
| `harmonic_to_noise_ratio` | Signal clarity vs breathiness | dB | Lower when voice is strained/breathy |

---

## Delta Interpretation

When Canon is in `analyzing_delta` phase, it computes how the current message deviates from the personal baseline. The avatar receives this context:

### Significance Thresholds

| Feature | Threshold | Example Avatar Context |
|---------|-----------|----------------------|
| `speaking_rate` | >15% change | "Speaking 23% faster than their personal norm" |
| `mean_pause_duration` | >20% change | "Pauses 35% longer than their personal norm" |
| `volume_mean` | >15% change | "Speaking 18% louder than their personal norm" |
| `mean_pitch` | >15% change | "Pitch 20% higher than their personal norm" |
| Unusual emotion | <15% frequency | "Emotion 'anxious' is unusual for this person (only 8% of the time)" |

### What The Avatar Sees

**Before Canon (generic):**
```
[PERCEPTION CONTEXT]
Primary emotion: neutral
Behavioral summary: Speaker appears calm
```

**After Canon (Phase 1 — Building):**
```
[PERCEPTION CONTEXT]
Primary emotion: baseline still calibrating — treat as personal resting state
[CANON: Calibrating personal baseline — 42% complete (25.3s / 60s)]
Behavioral summary: Speaker appears calm
```

**After Canon (Phase 3 — Analyzing Delta):**
```
[PERCEPTION CONTEXT]
Primary emotion: at personal center (baseline state)
[PERSONAL DELTA — changes relative to this person's calibrated baseline]
- Speaking 23% faster than their personal norm
- Pauses 35% longer than their personal norm
- Speaking 18% louder than their personal norm
- Emotion "anxious" is unusual for this person (only 8% of the time)
Behavioral summary: Speaker appears agitated
```

---

## Database Schema

### `wa_voice_baseline` (new table)

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `contact_id` | UUID | FK → `wa_contacts.id` |
| `owner_id` | UUID | FK → `wa_owners.id` |
| `cumulative_audio_sec` | FLOAT | Total audio seconds at time of lock |
| `baseline_data` | JSONB | Personal center data (see structure below) |
| `sample_count` | INTEGER | Number of messages used for baseline |
| `locked_at` | TIMESTAMPTZ | When baseline was established |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |

**Unique constraint:** `(contact_id, owner_id)` — one baseline per contact per avatar.

### `baseline_data` JSONB Structure

```json
{
  "prosodic_center": {
    "mean_pitch": 185.2,
    "pitch_range": 45.3,
    "pitch_variability": 12.1,
    "speaking_rate": 4.2,
    "articulation_rate": 5.1,
    "pause_count": 3.5,
    "mean_pause_duration": 0.42,
    "pause_ratio": 0.18,
    "volume_mean": -22.5,
    "volume_range": 15.3,
    "volume_variability": 4.2,
    "jitter": 0.012,
    "shimmer": 0.034,
    "harmonic_to_noise_ratio": 18.5
  },
  "emotion_distribution": {
    "engaged": 0.45,
    "calm": 0.30,
    "amused": 0.15,
    "neutral": 0.10
  },
  "sample_count": 5,
  "prosodic_sample_count": 4
}
```

### `wa_perception_logs` (existing, now unified)

| Column | Type | Before Canon | After Canon |
|--------|------|-------------|-------------|
| `id` | UUID | PK | PK |
| `message_id` | UUID | Missing in OPM insert | Always present |
| `conversation_id` | UUID | Present | Present |
| `contact_id` | UUID | Present | Present |
| `owner_id` | UUID | Sometimes null | Always present |
| `transcript` | TEXT | Split across 2 rows | Single row |
| `primary_emotion` | TEXT | Only in OPM row | Unified |
| `secondary_emotion` | TEXT | Only in OPM row | Unified |
| `fired_rules` | JSONB | Only in OPM row | Unified |
| `behavioral_summary` | TEXT | Only in OPM row | Unified |
| `conversation_hooks` | JSONB | Only in OPM row | Unified |
| `prosodic_summary` | JSONB | Only in OPM row | Unified |
| `audio_duration_sec` | FLOAT | Split across 2 rows | Unified |
| `created_at` | TIMESTAMPTZ | 2 timestamps | 1 timestamp |

---

## API Endpoints

### `POST /api/opm-process`

**Role:** Pure proxy to Cygnus/OPM backend. No database writes.

| Field | Type | Description |
|-------|------|-------------|
| `audio` | string (base64) | Audio data |
| `conversationId` | string | Conversation UUID |
| `contactId` | string | Contact UUID |
| `filename` | string | Original filename |
| `contentType` | string | MIME type |

**Returns:** Raw OPM analysis data.

### `POST /api/create-perception-log`

**Role:** Central perception hub — stores unified log + Canon logic.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | string | No | Message UUID |
| `conversationId` | string | Yes | Conversation UUID |
| `contactId` | string | Yes | Contact UUID |
| `ownerId` | string | Yes | Owner UUID |
| `transcript` | string | No | Transcribed text |
| `audioDurationSec` | number | No | Duration in seconds |
| `primaryEmotion` | string | No | From OPM echo_analysis |
| `secondaryEmotion` | string | No | From OPM echo_analysis |
| `firedRules` | array | No | From OPM echo_analysis |
| `behavioralSummary` | string | No | From OPM lucid interpretation |
| `conversationHooks` | array | No | From OPM session analysis |
| `prosodicSummary` | object | No | From OPM audio_features |
| `mediaType` | string | No | `"audio"` or `"video"` |

**Response:**

```json
{
  "log": { /* inserted perception log row */ },
  "canon": {
    "phase": "building" | "baseline_locked" | "analyzing_delta",
    "cumulative_sec": 42.5,
    "threshold_sec": 60,
    "progress": 71,
    "baseline": null | { /* baseline_data object */ },
    "delta": null | {
      "prosodic_delta": {
        "speaking_rate": 0.23,
        "mean_pause_duration": -0.15,
        "volume_mean": 0.18
      },
      "emotion_delta": {
        "emotion": "anxious",
        "personal_frequency": 0.08,
        "is_unusual": true,
        "is_typical": false
      }
    }
  }
}
```

---

## File Map

| File | Role in Canon |
|------|---------------|
| `api/opm-process.ts` | Pure OPM proxy (no DB) |
| `api/create-perception-log.ts` | Central perception hub + Canon logic |
| `api/chat.ts` | `buildPerceptionPrompt()` — constructs avatar context with delta |
| `src/lib/api.ts` | `createPerceptionLog()` — frontend client function |
| `src/lib/mediaUtils.ts` | `callOpmApi()` — OPM call orchestration |
| `src/hooks/useVoiceRecording.ts` | Voice flow — calls createPerceptionLog with OPM data |
| `src/hooks/useVideoCapture.ts` | Recorded video flow — calls createPerceptionLog |
| `src/pages/Chat.tsx` | Uploaded video flow — calls createPerceptionLog |
| `supabase_schema.sql` | Schema for `wa_voice_baseline` table |
| `docs/canon-system.md` | This documentation |

---

## Supabase SQL Migration

Run this SQL in the Supabase SQL Editor to create the `wa_voice_baseline` table:

```sql
-- Canon: Personal Voice Baseline (Cygnus Echo Calibration)
CREATE TABLE IF NOT EXISTS public.wa_voice_baseline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  cumulative_audio_sec FLOAT NOT NULL DEFAULT 0,
  baseline_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_count INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, owner_id)
);

ALTER TABLE public.wa_voice_baseline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "baseline_owner_select" ON public.wa_voice_baseline
  FOR SELECT USING (
    owner_id IN (SELECT id FROM public.wa_owners WHERE user_id = auth.uid())
  );
CREATE POLICY "baseline_insert" ON public.wa_voice_baseline
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "baseline_update" ON public.wa_voice_baseline
  FOR UPDATE USING (TRUE);

NOTIFY pgrst, 'reload schema';
```

---

## Roadmap

### Phase 1 (Current): Audio Baseline via Cygnus Echo
- [x] Unified perception log (single row per message)
- [x] Cumulative audio duration tracking per contact
- [x] 60-second baseline threshold
- [x] Personal prosodic center calculation
- [x] Delta computation (prosodic + emotion)
- [x] Avatar context injection with personal delta
- [x] "neutral" replaced with personal center terminology

### Phase 2 (Planned): Video Baseline via Oracle
- [ ] Determine which Oracle features are consistent enough for baseline
- [ ] Define calibration threshold for video (likely >60s, TBD)
- [ ] Extend `wa_voice_baseline` or create `wa_video_baseline`
- [ ] Facial expression distribution as visual baseline
- [ ] Micro-expression delta detection
- [ ] Combined audio+video delta context for avatar

### Phase 3 (Future): Baseline Evolution
- [ ] Baseline recalibration over time (gradual drift)
- [ ] Session-level baselines (within one conversation)
- [ ] Cross-conversation baseline comparison
- [ ] Anomaly detection (sudden baseline shifts)
