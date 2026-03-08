# WhatsAnima

**Observational Perception Messaging - the only AI twin that reads the room while it runs the conversation.**

WhatsAnima lets you deploy a personalized AI avatar, powered by your voice and likeness, that your contacts can message 24/7. Every conversation is silently analyzed through the OPM (Observational Perception Models) pipeline, giving you a real-time read on who you're dealing with - without ever being in the room.

---

## What It Does

- **Your AI, your voice, your face.** Built on ElevenLabs voice cloning and Tavus video rendering.
- **Invite-only access.** You control who gets to interact with your avatar via unique invitation links.
- **Perception on every message.** Every voice note, video, and message your contacts send is processed through CYGNUS and ORACLE — giving you behavioral patterns, emotional arcs, and moment-level evidence.
- **You observe. They never know.**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vite + React 19 + TypeScript strict |
| Styling | Tailwind CSS v4 |
| Routing | react-router-dom |
| Backend/DB | Supabase (PostgreSQL + Auth + Storage) |
| Voice | ElevenLabs |
| Video Avatar | Tavus |
| Perception | OPM Pipeline (CYGNUS, ORACLE, LUCID, TRACE) |
| Deployment | Vercel |

---

## Project Structure

```
src/
├── components/       # Reusable UI components
├── lib/
│   └── supabase.ts   # Supabase client
├── pages/            # Route-level pages
├── App.tsx           # Router setup
├── main.tsx          # Entry point
└── index.css         # Tailwind import
```

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/juanschu-bear/WhatsAnima.git
cd WhatsAnima
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Fill in your credentials in `.env`:

```
VITE_SUPABASE_URL=https://wofklmwbokdjoqlstjmy.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

### 4. Run locally

```bash
npm run dev
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | WhatsAnima Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key |

---

## Architecture

WhatsAnima sits on top of the DITTO Architecture - the same OPM engine that powers ANIMA Connect, configured for a different vertical: **inbound contact perception** instead of outbound CEO coaching.

```
Contact sends voice/video message
        ↓
OPM Pipeline (CYGNUS → ORACLE → LUCID → TRACE)
        ↓
Owner sees perception report: patterns, emotional arc, moment-level evidence
        ↓
Owner's AI avatar responds via ElevenLabs + Tavus
```

---

## Part of the ONIOKO Ecosystem

Built by [ONIOKO](https://onioko.com) - hybrid human-AI product studio.

- ANIMA Connect: CEO avatar coaching platform
- WhatsAnima: Observational Perception Messaging
- OPM: Observational Perception Models pipeline
