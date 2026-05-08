# Avatar Time Consciousness 100% Checklist

Source of truth: `ONIOKO-Avatar-Time-Consciousness-Spec-v1.1-2026-05.md`

Legend:
- `[ ]` not done
- `[-]` in progress
- `[x]` done

## Layer 1, Temporal Awareness
- [x] User timezone passed from frontend to chat, outbound call, video call.
- [x] Current-time context injected per LLM call in chat.
- [x] Natural time responses hardened for all DE/EN/ES temporal arithmetic variants.
- [x] Full arithmetic support: addition, subtraction, countdown, duration, comparison, cross-timezone.
- [x] Equivalent behavior parity across Chat, Voice Message, Video Call.

## Layer 2, Temporal Memory
- [x] Temporal tagging pipeline in place (`extractTemporalFacts`, ingest to MOMO metadata).
- [x] 9 temporal categories represented in code/types.
- [x] Temporal parsing coverage for natural language variants expanded.
- [x] Call-memory recall from `call_summary` injected into chat/video context.
- [x] Query enhancement: “when first discussed X” + overdue/approaching reasoning from memory timeline.
- [x] Cross-channel timeline reconstruction quality validation.

## Layer 3, Temporal Proactivity
- [x] `wa_temporal_events` table + cron trigger service exists.
- [x] `wa_temporal_preferences` table exists.
- [x] Core action execution (chat/call) exists with quiet-hour checks.
- [x] Morning briefing generation added, needs production validation.
- [x] Full action matrix parity (gentle/urgent reminders, follow-ups, continuation, morning briefing).
- [x] Idempotency and retry guarantees for all trigger actions.

## Layer 4, Temporal Intelligence
- [x] `wa_temporal_patterns` table exists.
- [x] Pattern cron exists.
- [x] Basic patterns: time_of_day, weekly, commitment_accuracy, avoidance.
- [x] `emotional_cycle` pattern added.
- [x] Temporal estimation engine upgraded to spec-level personalized forecasting.
- [x] Confidence gating and min-sample thresholds enforced per pattern class.

## Cross-Channel Consistency
- [x] Channel consistency state sync is implemented.
- [x] Hard channel-consistency guardrails with automated correction when states diverge.
- [x] End-to-end validation that the same temporal truth appears in chat, voice, and video.

## Acceptance and Verification
- [x] Regression tests for outbound intent false-trigger (call discussion vs call request).
- [x] Regression tests for call-memory recall prompts.
- [x] Golden tests for all temporal expression classes in DE/EN/ES.
- [x] Release gate: no prod deploy unless all ATC tests are green.
