# Canon: 5-Tier Personal Baseline Calibration System

## Overview

Canon is WhatsAnima's personalized audio calibration system. It replaces generic emotion labels (like "neutral") with individualized baselines — because every person has their own tonal center, speaking rhythm, volume level, and emotional resting state.

**Core principle:** "Neutral" doesn't exist. What OPM labels as "neutral" is simply the absence of a population-average match. Canon solves this by building a personal reference point for each contact, then measuring everything as a **delta** from **their** center.

**Key insight:** A single 60-second recording tells you almost nothing about a person's baseline. Someone might be tired, in a noisy room, or unusually excited. Canon addresses this with 5 progressive tiers of calibration — each recalculating the entire baseline from all collected data, with increasing confidence.

---

## Architecture

### Data Flow

```
Voice/Video Message
       │
       ▼
   callOpmApi()              ← Pure proxy to OPM, no DB write
       │ Returns: emotion, prosody, rules, transcript
       ▼
   sendMessage()             ← Creates message, gets message_id
       │
       ▼
   createPerceptionLog()     ← Central hub: ONE insert with ALL data + Canon logic
       │
       ├── 1. Insert unified perception log (message_id + all OPM data)
       ├── 2. Sum cumulative audio duration for this contact
       ├── 3. Determine current tier
       ├── 4. If new tier reached → full recalibration from ALL logs
       ├── 5. Compute delta against baseline
       └── 6. Return: log + canon { phase, tier, confidence, delta }
       │
       ▼
   chat.ts buildPerceptionPrompt()
       │ Injects tier-aware context into avatar prompt
       │ Higher confidence → finer delta thresholds
       ▼
   Avatar response informed by personal delta
```

### Before Canon (broken)

```
Voice Message → OPM → INSERT #1 (emotions, no message_id)
                         ↓
              Message created → INSERT #2 (message_id, no emotions)

Result: Two incomplete rows per message. No cumulative tracking.
```

### After Canon (unified)

```
Voice Message → OPM → Message created → ONE INSERT (everything)
                                              ↓
                                     Canon tier check + delta
```

---

## The 5-Tier System

### Why 5 Tiers?

After 60 seconds of audio you can't claim to know someone's baseline. They might be:
- Just woken up (slower, lower pitch)
- In a crowd (louder, faster)
- Stressed about something (higher pitch, more pauses)
- Unusually excited (faster, wider pitch range)

Each tier adds data from more contexts, more moods, more situations — until the baseline genuinely represents the person.

### Tier Overview

| Tier | Name | Threshold | Confidence | What It Tells You |
|------|------|-----------|------------|-------------------|
| 0 | `building` | < 60s | 0% | Nothing yet — still collecting |
| 1 | `snapshot` | ≥ 60s | 15% | "This is how they sound right now" — a single context snapshot |
| 2 | `session` | ≥ 30 min | 40% | Session-level stability. Enough to see if they're consistent or variable within one session |
| 3 | `short_term` | ≥ 60 min | 60% | Daily pattern. Multiple topics, multiple emotional states captured |
| 4 | `established` | ≥ 180 min | 80% | Real personal tendency. Outliers (tiredness, noise) have been averaged out |
| 5 | `deep` | ≥ 600 min | 95% | Long-term profile. Different days, different moods, different contexts. This IS the person |

### Accumulation Example

```
Message  1:  18s   →  Cumulative:   18s  → Tier 0 (building, 30%)
Message  2:  24s   →  Cumulative:   42s  → Tier 0 (building, 70%)
Message  3:  21s   →  Cumulative:   63s  → Tier 1 (snapshot!) ← baseline locked
Message  4:  15s   →  Cumulative:   78s  → Tier 1 (analyzing delta)
...
Message 45:  32s   →  Cumulative: 1842s  → Tier 2 (session!) ← full recalibration
...
Message 120: 28s   →  Cumulative: 3624s  → Tier 3 (short_term!) ← full recalibration
...
Message 340: 35s   →  Cumulative: 10815s → Tier 4 (established!) ← full recalibration
...
Message 980: 22s   →  Cumulative: 36020s → Tier 5 (deep!) ← full recalibration
```

**Messages are never skipped.** An 8-second voice note contributes 8 seconds to the total.

### What Happens at Each Tier Advancement

When cumulative audio crosses a tier threshold:

1. **ALL perception logs** for this contact+owner are fetched from the database
2. **Every prosodic feature** is averaged across all samples (full recalculation, not incremental)
3. **Emotion distribution** is recomputed from all primary_emotion values
4. The baseline row is **updated** (or inserted if first tier)
5. `current_tier`, `confidence`, `cumulative_audio_sec` are updated
6. The response includes `phase: "tier_advanced"` so the frontend can react

---

## Prosodic Features Tracked

Canon tracks and averages these features from Cygnus Echo:

| Feature | Description | Unit | Why It Matters |
|---------|-------------|------|----------------|
| `mean_pitch` | Average fundamental frequency | Hz | Higher when stressed/excited, lower when calm/tired |
| `pitch_range` | Highest - lowest pitch | Hz | Narrows when monotone, widens when animated |
| `pitch_variability` | Standard deviation of pitch | Hz | Low = flat delivery, high = expressive |
| `speaking_rate` | Words per second | words/s | Faster when nervous/excited, slower when thoughtful |
| `articulation_rate` | Syllables per second (excl. pauses) | syl/s | Pure speech speed without silence |
| `pause_count` | Number of pauses per message | count | More pauses = hesitation or emphasis |
| `mean_pause_duration` | Average pause length | seconds | Longer pauses = more processing/hesitation |
| `pause_ratio` | Proportion of silence | ratio | High ratio = many/long pauses |
| `volume_mean` | Average loudness | dB | Louder = more energetic/emphatic |
| `volume_range` | Loudest - quietest | dB | Wide range = dynamic, expressive delivery |
| `volume_variability` | Standard deviation of volume | dB | How much volume fluctuates |
| `jitter` | Cycle-to-cycle pitch variation | ratio | Involuntary vocal quality marker |
| `shimmer` | Cycle-to-cycle amplitude variation | ratio | Voice stability/roughness |
| `harmonic_to_noise_ratio` | Signal clarity vs breathiness | dB | Lower when strained/breathy |

---

## Delta Interpretation

### Confidence-Adaptive Thresholds

The avatar doesn't just get raw deltas — the **confidence level determines how sensitive the detection is** and how certainly deviations are reported:

| Feature | Tier 1 (15%) | Tier 2 (40%) | Tier 3 (60%) | Tier 4-5 (80-95%) |
|---------|-------------|-------------|-------------|-------------------|
| Speaking rate | >25% change | >15% change | >12% change | >10% change |
| Pause duration | >30% change | >20% change | >15% change | >12% change |
| Volume | >25% change | >15% change | >12% change | >10% change |
| Pitch | >25% change | >15% change | >12% change | >10% change |

### Certainty Qualifiers

The avatar receives language that reflects the confidence:

| Confidence | Qualifier | Example |
|------------|-----------|---------|
| ≥ 80% (Tier 4-5) | *(none)* | "Speaking 23% faster than their personal norm" |
| ≥ 60% (Tier 3) | "likely" | "Likely speaking 23% faster than their personal norm" |
| ≥ 40% (Tier 2) | "possibly" | "Possibly speaking 23% faster than their personal norm" |
| < 40% (Tier 1) | "tentatively" | "Tentatively speaking 23% faster than their personal norm" |

### Emotion Delta

| Detection | Threshold | Meaning |
|-----------|-----------|---------|
| `is_unusual` | Emotion appears < 15% of the time | This emotion is rare for this person — pay attention |
| `is_typical` | Emotion appears > 30% of the time | Normal state, nothing remarkable |

---

## What The Avatar Sees

### Phase: Building (Tier 0)

```
[PERCEPTION CONTEXT]
Primary emotion: baseline still calibrating — treat as personal resting state
[CANON: Collecting audio for calibration — 70% to Initial Snapshot (42s / 60s)]
Behavioral summary: Speaker appears calm
```

### Phase: Tier Just Advanced (e.g., Tier 1 → Tier 2)

```
[PERCEPTION CONTEXT]
Primary emotion: at personal center (baseline state)
[CANON: Baseline recalibrated — now at "Session Baseline" (Tier 2/5, 40% confidence)]
[PERSONAL DELTA — changes relative to calibrated baseline (40% confidence)]
- possibly Speaking 18% faster than their personal norm
- possibly Pauses 25% longer than their personal norm
Behavioral summary: Speaker appears slightly agitated
```

### Phase: Analyzing Delta (Tier 4 — high confidence)

```
[PERCEPTION CONTEXT]
Primary emotion: at personal center (baseline state)
[CANON: Established Baseline active (Tier 4/5, 80% confidence)]
[PERSONAL DELTA — changes relative to calibrated baseline (80% confidence)]
- Speaking 23% faster than their personal norm
- Pauses 35% longer than their personal norm
- Speaking 18% louder than their personal norm
- Emotion "anxious" is unusual for this person (only 8% of the time)
Behavioral summary: Speaker appears agitated
Detected signals: conviction_alignment, topic_specific_hesitation
```

### Phase: Deep Profile (Tier 5 — maximum confidence)

```
[PERCEPTION CONTEXT]
Primary emotion: engaged
[CANON: Deep Profile active (Tier 5/5, 95% confidence)]
[PERSONAL DELTA — changes relative to calibrated baseline (95% confidence)]
- Pitch 12% higher than their personal norm
- Speaking 11% louder than their personal norm
Behavioral summary: Speaker is enthusiastic about this topic
```

---

## Database Schema

### `wa_voice_baseline` Table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | UUID | auto | Primary key |
| `contact_id` | UUID | | FK → `wa_contacts.id` |
| `owner_id` | UUID | | FK → `wa_owners.id` |
| `current_tier` | INTEGER | 0 | Current calibration tier (1-5) |
| `tier_name` | TEXT | 'building' | Human-readable tier name |
| `confidence` | FLOAT | 0 | Confidence level (0.0 - 1.0) |
| `cumulative_audio_sec` | FLOAT | 0 | Total audio seconds at last recalibration |
| `baseline_data` | JSONB | '{}' | Personal center data (prosodic + emotion) |
| `sample_count` | INTEGER | 0 | Messages used for baseline |
| `locked_at` | TIMESTAMPTZ | NOW() | When first baseline was created |
| `updated_at` | TIMESTAMPTZ | NOW() | When last recalibrated |

**Unique constraint:** `(contact_id, owner_id)` — one baseline per contact per avatar.

### `wa_perception_logs` Table (Unified)

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | PK |
| `message_id` | UUID | FK → message (always present now) |
| `conversation_id` | UUID | FK → conversation |
| `contact_id` | UUID | FK → contact |
| `owner_id` | UUID | FK → owner |
| `transcript` | TEXT | Transcribed speech |
| `primary_emotion` | TEXT | OPM-detected emotion |
| `secondary_emotion` | TEXT | Secondary emotion |
| `fired_rules` | JSONB | OPM rules that fired |
| `behavioral_summary` | TEXT | OPM interpretation |
| `conversation_hooks` | JSONB | Session patterns |
| `prosodic_summary` | JSONB | All audio features |
| `audio_duration_sec` | FLOAT | Message duration |
| `created_at` | TIMESTAMPTZ | When logged |

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
    "contemplative": 0.10
  },
  "sample_count": 340,
  "prosodic_sample_count": 285
}
```

---

## API Reference

### `POST /api/opm-process`

**Role:** Pure proxy to Cygnus/OPM backend. No database writes.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | string | Yes | Base64-encoded audio |
| `conversationId` | string | Yes | Conversation UUID |
| `contactId` | string | Yes | Contact UUID |
| `filename` | string | No | Original filename |
| `contentType` | string | No | MIME type |

**Returns:** Raw OPM analysis data.

### `POST /api/create-perception-log`

**Role:** Central perception hub — unified log insert + Canon tier logic.

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
| `firedRules` | array | No | From OPM fired_rules |
| `behavioralSummary` | string | No | From OPM lucid interpretation |
| `conversationHooks` | array | No | From OPM session patterns |
| `prosodicSummary` | object | No | From OPM audio_features |
| `mediaType` | string | No | `"audio"` or `"video"` |

**Response:**

```json
{
  "log": { /* inserted perception log row */ },
  "canon": {
    "phase": "building | tier_advanced | analyzing_delta",
    "tier": 2,
    "tier_name": "session",
    "tier_label": "Session Baseline",
    "confidence": 0.40,
    "cumulative_sec": 1842.5,
    "next_tier": {
      "name": "short_term",
      "label": "Short-Term Baseline",
      "threshold_sec": 3600,
      "remaining_sec": 1757.5,
      "progress": 51
    },
    "baseline": {
      "prosodic_center": { "mean_pitch": 185.2, "..." : "..." },
      "emotion_distribution": { "engaged": 0.45, "..." : "..." },
      "sample_count": 45,
      "prosodic_sample_count": 38
    },
    "delta": {
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
| `api/create-perception-log.ts` | Central perception hub + 5-tier Canon logic |
| `api/chat.ts` | `buildPerceptionPrompt()` — tier-aware avatar context with confidence-adaptive deltas |
| `src/lib/api.ts` | `createPerceptionLog()` — frontend client with all OPM fields |
| `src/lib/mediaUtils.ts` | `callOpmApi()` — OPM call orchestration |
| `src/hooks/useVoiceRecording.ts` | Voice flow → createPerceptionLog with OPM data |
| `src/hooks/useVideoCapture.ts` | Recorded video flow → createPerceptionLog |
| `src/pages/Chat.tsx` | Uploaded video flow → createPerceptionLog |
| `supabase_schema.sql` | Schema for `wa_voice_baseline` with tier columns |
| `docs/canon-system.md` | This documentation |

---

## Supabase SQL Migration

Run this in the Supabase SQL Editor:

```sql
-- Canon: Personal Voice Baseline (5-Tier Calibration System)
CREATE TABLE IF NOT EXISTS public.wa_voice_baseline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES public.wa_owners(id) ON DELETE CASCADE,
  current_tier INTEGER NOT NULL DEFAULT 0,
  tier_name TEXT NOT NULL DEFAULT 'building',
  confidence FLOAT NOT NULL DEFAULT 0,
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

**If you already ran the old SQL** (without `current_tier`, `tier_name`, `confidence`), run this migration instead:

```sql
-- Add tier columns to existing wa_voice_baseline table
ALTER TABLE public.wa_voice_baseline
  ADD COLUMN IF NOT EXISTS current_tier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.wa_voice_baseline
  ADD COLUMN IF NOT EXISTS tier_name TEXT NOT NULL DEFAULT 'building';
ALTER TABLE public.wa_voice_baseline
  ADD COLUMN IF NOT EXISTS confidence FLOAT NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
```

---

## Roadmap

### Phase 1 (Complete): 5-Tier Audio Baseline via Cygnus Echo
- [x] Unified perception log (single row per message, all data)
- [x] Cumulative audio duration tracking per contact
- [x] 5-tier progressive calibration (60s → 30min → 60min → 180min → 600min)
- [x] Full recalibration from ALL data at each tier advancement
- [x] Confidence-adaptive delta thresholds (higher tier = finer detection)
- [x] Certainty qualifiers in avatar context (tentatively → possibly → likely → definite)
- [x] "neutral" replaced with "personal center" terminology
- [x] Volume tracking (volume_mean, volume_range, volume_variability)
- [x] Body size limit increased to 500mb for long voice messages

### Phase 2 (Planned): Video Baseline via Oracle
- [ ] Determine consistent Oracle features for visual baseline
- [ ] Define calibration thresholds for video (likely higher than audio)
- [ ] Extend `wa_voice_baseline` or create `wa_video_baseline`
- [ ] Facial expression distribution as visual baseline
- [ ] Micro-expression delta detection
- [ ] Combined audio+video delta context for avatar

### Phase 3 (Future): Baseline Evolution
- [ ] Gradual baseline drift detection over time
- [ ] Session-level baselines (within one conversation)
- [ ] Cross-conversation baseline comparison
- [ ] Anomaly detection (sudden baseline shifts)
- [ ] Circadian rhythm patterns (time-of-day adjustments)
