# WhatsAnima Full Audit Report

**Date:** 2026-03-09

---

## 1. Vercel Environment Variables

> **Note:** Vercel CLI is not authenticated in this environment. Could not run `vercel env ls`.
> The table below lists what the codebase **expects**. You must manually verify SET/MISSING status in the Vercel dashboard.

| Variable Name | Purpose | Environments (Prod/Preview/Dev) | Status |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI LLM calls (`api/chat.ts`) | Verify in dashboard | **UNKNOWN — verify manually** |
| `OPENAI_KEY` | Fallback name for OpenAI key | Verify in dashboard | **UNKNOWN — verify manually** |
| `OPENAI_SECRET_KEY` | Fallback name for OpenAI key | Verify in dashboard | **UNKNOWN — verify manually** |
| `OPENAI_CHAT_MODEL` | Model selection (defaults to `gpt-4.1-mini`) | Verify in dashboard | **UNKNOWN — verify manually** |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS (`api/tts.ts`) | Verify in dashboard | **UNKNOWN — verify manually** |
| `POSTGRES_URL` | Database connection (`api/bootstrap-persona.ts`) | Verify in dashboard | **UNKNOWN — verify manually** |
| `DATABASE_URL` | Fallback DB connection | Verify in dashboard | **UNKNOWN — verify manually** |
| `SUPABASE_DB_URL` | Fallback DB connection | Verify in dashboard | **UNKNOWN — verify manually** |
| `SUPABASE_DATABASE_URL` | Fallback DB connection | Verify in dashboard | **UNKNOWN — verify manually** |
| `POSTGRES_PRISMA_URL` | Fallback DB connection | Verify in dashboard | **UNKNOWN — verify manually** |
| `VITE_SUPABASE_URL` | Supabase project URL (client-side) | Verify in dashboard | **UNKNOWN — verify manually** |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (client-side) | Verify in dashboard | **UNKNOWN — verify manually** |

---

## 2. Required API Keys

| Variable Name | What It's For | Required? | Currently Set on Vercel |
|---|---|---|---|
| `OPENAI_API_KEY` (or `OPENAI_KEY` / `OPENAI_SECRET_KEY`) | LLM chat completions via OpenAI | Yes — without it, fallback hardcoded replies are used | **UNKNOWN — verify manually** |
| `OPENAI_CHAT_MODEL` | Selects which OpenAI model to use | No — defaults to `gpt-4.1-mini` | **UNKNOWN — verify manually** |
| `ELEVENLABS_API_KEY` | Text-to-speech via ElevenLabs | Yes — without it, `/api/tts` returns HTTP 500 | **UNKNOWN — verify manually** |
| `POSTGRES_URL` (or `DATABASE_URL` / `SUPABASE_DB_URL` / `SUPABASE_DATABASE_URL` / `POSTGRES_PRISMA_URL`) | PostgreSQL database for persona bootstrap | Yes — for `/api/bootstrap-persona` | **UNKNOWN — verify manually** |
| `VITE_SUPABASE_URL` | Supabase client initialization | Yes — all database reads/writes use this | **UNKNOWN — verify manually** |
| `VITE_SUPABASE_ANON_KEY` | Supabase client auth | Yes — all database reads/writes use this | **UNKNOWN — verify manually** |

**Note:** `.env.example` also lists `VITE_ELEVENLABS_API_KEY` and `VITE_ELEVENLABS_VOICE_ID`, but these are **not used anywhere in the codebase**. The backend uses `ELEVENLABS_API_KEY` (server-side, no `VITE_` prefix).

---

## 3. Endpoint Status

> **Note:** No outbound network access from this environment. Could not curl the live deployment.
> You must test these manually against your deployment URL.

| Route | Method | What It Does | Live Status |
|---|---|---|---|
| `/api/chat` | POST | Sends user message + history to OpenAI, returns AI text reply. Falls back to hardcoded multilingual responses if no API key. | **UNTESTABLE — no network access** |
| `/api/tts` | POST | Converts text to speech via ElevenLabs API. Returns MP3 audio. Returns 500 if `ELEVENLABS_API_KEY` missing. | **UNTESTABLE — no network access** |
| `/api/bootstrap-persona` | POST | Reads `AVATAR_SOUL.md`, upserts persona record (Juan Schubert) into PostgreSQL with system prompt and voice ID. | **UNTESTABLE — no network access** |

### Manual Test Commands

Replace `$URL` with your Vercel deployment URL:

```bash
# Test /api/chat
curl -X POST "$URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","history":[]}' \
  -w "\nHTTP %{http_code}\n"

# Test /api/tts
curl -X POST "$URL/api/tts" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}' \
  -o /dev/null -w "HTTP %{http_code}\n"

# Test /api/bootstrap-persona
curl -X POST "$URL/api/bootstrap-persona" \
  -w "\nHTTP %{http_code}\n"
```

---

## 4. Features Ported from ANIMA Connect

| Feature | Present in WhatsAnima | Details |
|---|---|---|
| Voice recording | **YES** | `navigator.mediaDevices.getUserMedia({ audio: true })`, MediaRecorder with WebM/Opus, waveform visualization, recording timer. (`Chat.tsx:671`) |
| Voice playback with working timer | **YES** | `VoiceMessageBubble` component with HTML Audio element, `ontimeupdate` progress tracking, MM:SS timer display, 15-bar waveform progress visualization. (`Chat.tsx:150`) |
| Transcribe button | **YES** | Web Speech Recognition API during recording for live transcription. Stored in `transcriptMap`. Toggle button shows/hides transcript below voice message. (`Chat.tsx:258-269`) |
| Video recording | **YES** | Camera capture with `getUserMedia({ video, audio })`, MediaRecorder (WebM/VP9 or fallback), face validation with skin-tone detection, recording timer, orientation correction. (`Chat.tsx:760, 1109`) |
| Video upload | **YES** | File input with `accept="video/*"`, 500MB size limit, orientation auto-correction, caption draft modal, Supabase Storage upload to `video-uploads` bucket. (`Chat.tsx:1268`) |
| Image upload | **YES** | File input with `accept="image/*"`, caption draft modal, Supabase Storage upload to `image-uploads` bucket. (`Chat.tsx:1257`) |
| Date separators | **YES** | `groupedTimeline` groups messages by day using `dateKey()`. Shows "Today", "Yesterday", or full date (e.g., "Monday, January 15"). Rendered as centered pill-shaped dividers. (`Chat.tsx:445, 101`) |

**All 7 features are present.**

---

## 5. Current Chat Flow

### Exact flow when a user sends a text message:

```
USER TYPES MESSAGE
        │
        ▼
handleSendText() (Chat.tsx:575)
  ├─ Trims input, clears text field
  ├─ Sets sending=true (disables UI)
  │
  ▼
sendMessage() via Supabase (Chat.tsx:583)
  ├─ INSERT into wa_messages table:
  │    sender='contact', type='text', content=message
  ├─ Adds message to local state immediately
  │
  ▼
sendAvatarReply() (Chat.tsx:553)
  ├─ Sets avatarTyping=true (shows typing indicator)
  │
  ▼
getAvatarReply() (Chat.tsx:481)
  ├─ Builds history from last 10 messages
  ├─ Loads system prompt from owner record
  │
  ├─── POST /api/chat ──────────────────────────────┐
  │    Body: { message, systemPrompt, history }      │
  │                                                   ▼
  │                                          api/chat.ts:
  │                                          ├─ Detects language (DE/ES/EN)
  │                                          ├─ If NO OpenAI key → return
  │                                          │   hardcoded fallback reply
  │                                          ├─ If key exists → call OpenAI
  │                                          │   model: gpt-4.1-mini
  │                                          │   temp: 0.8, max_tokens: 180
  │                                          └─ Returns { content: "..." }
  │                                                   │
  │    ◄────────────────────────────────────────────  │
  │
  ├─── POST /api/tts ───────────────────────────────┐
  │    Body: { text: replyText, voiceId }            │
  │                                                   ▼
  │                                          api/tts.ts:
  │                                          ├─ If NO ElevenLabs key → 500
  │                                          ├─ Calls ElevenLabs API
  │                                          │   model: eleven_multilingual_v2
  │                                          └─ Returns MP3 audio blob
  │                                                   │
  │    ◄────────────────────────────────────────────  │
  │
  ├─ Uploads MP3 to Supabase Storage (voice-messages bucket)
  ├─ Gets public URL for audio
  │
  ▼
INSERT avatar reply into wa_messages:
  sender='avatar', type='voice',
  content=replyText, media_url=audioURL
        │
        ▼
Update local state:
  ├─ Add reply to messages array
  ├─ Add transcript to transcriptMap
  ├─ Set avatarTyping=false
  └─ Set sending=false
```

### Key observations:

1. **There IS a real LLM call** — `POST /api/chat` calls OpenAI's `gpt-4.1-mini` model.
2. **There IS a hardcoded fallback** — if `OPENAI_API_KEY` (or fallbacks) is not set, the API returns canned multilingual responses instead of calling OpenAI. The user would see replies like "Hey, was geht?" or "Tell me something interesting" but would have no indication these are not AI-generated.
3. **Avatar always replies as voice** — even for text input, the reply is type `voice` with a TTS-generated audio file attached. The text content is stored as transcript.
4. **If ElevenLabs key is missing**, the TTS call fails with HTTP 500. The `getAvatarReply` function has a try/catch but still attempts to store a reply with `null` media_url — the voice message bubble would render without playable audio.

---

## Summary of Risks

| Risk | Severity | Detail |
|---|---|---|
| No way to confirm env vars are set | **High** | Vercel CLI not authenticated; must check dashboard manually |
| Silent fallback to hardcoded replies | **Medium** | If OpenAI key is missing, users get fake-looking canned responses with no warning |
| TTS failure cascades | **Medium** | Missing ElevenLabs key causes 500; avatar reply saved with null media_url |
| `.env.example` out of sync | **Low** | Lists `VITE_ELEVENLABS_API_KEY` and `VITE_ELEVENLABS_VOICE_ID` which are unused in code |
| No health-check endpoint | **Low** | No `/api/health` route to verify deployment is alive and keys are configured |
