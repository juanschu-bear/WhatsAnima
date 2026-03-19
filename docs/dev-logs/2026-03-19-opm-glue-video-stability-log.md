# WhatsAnima & ANIMA Connect — Dev Log
## 18. März 2026 (03:00) bis 19. März 2026 (05:00)

---

## 🟢 WAS HEUTE FUNKTIONIERT HAT

### Video Messages — ANIMA Connect
- Video aufnehmen, Preview mit Scrubber, Absenden ✅
- OPM analysiert Video vollständig (CYGNUS, ORACLE, LUCID) ✅
- Deepgram transkribiert Audio korrekt ✅
- Transkript landet in Supabase `perception_logs` ✅
- Avatar antwortet mit echtem Kontext basierend auf Video-Inhalt ✅
- Behavioral Summary (LUCID) mit Cal Lightman-Style ✅

### Live Video Calls — WhatsAnima
- Tavus Live Calls funktionieren ✅
- Brian Cox Persona korrekt zugewiesen (nach Fix) ✅
- Adri Kastel Avatar hinzugefügt ✅
- Juan Schubert (Extended) als Test-Avatar angelegt ✅
- Session terminiert korrekt beim End Call ✅
- max_call_duration auf 180 Sekunden gesetzt ✅

### Video Messages — WhatsAnima
- Video-Recording Flow neu aufgebaut (nach Löschung) ✅
- Circular Video Bubble mit Glow-Ring ✅
- "Uploading video..." und "is watching your video..." Indikatoren ✅
- Upload direkt zu Supabase Storage ✅

### Infrastruktur
- DB Migration `010_video_perception_fields.sql` ausgeführt ✅
- Deepgram als primäre Transkriptions-Engine für Video auf OPM ✅
- Transcript-Pfad `layers.cygnus.audio.transcript.text` korrekt eingebaut ✅
- OPM `/results` Endpoint gibt jetzt Transkript zurück ✅

---

## 🔴 WAS SCHIEFGELAUFEN IST

### 1. OPM Port-Konflikt (kritisch)
**Problem:** OPM-Prozess stürzte ab. Beim Neustart lief der alte Prozess noch → Port 8000 doppelt belegt → alle `/analyze` Requests gaben 500 zurück.

**Symptom:** `POST /analyze 500 Internal Server Error` in Browser Console. Avatar sagt "had trouble reading your message."

**Fix:**
```bash
pkill -f "uvicorn server.server:app" || true
sleep 2
cd /workspace/opm && nohup /venv/main/bin/python3 -m uvicorn server.server:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/opm-uvicorn.log 2>&1 & disown
sleep 4
curl -s http://127.0.0.1:8000/health
```

**Diagnose:**
```bash
grep -n "500\|ERROR\|address already in use" /tmp/opm-uvicorn.log | tail -n 20
```

### 2. Tavus Minuten-Verlust (900+ Minuten = 15 Stunden)
**Problem:** Codex hat automatisch Tavus Test-Sessions gestartet ohne Genehmigung. Sessions liefen im Hintergrund weiter.

**Fix:** 
- `max_call_duration: 180` auf jeder Session-Erstellung
- End Call Button terminiert Session serverseitig
- Codex explizit verboten Tavus Sessions zu erstellen
- E-Mail an Tavus für Erstattung geschickt

### 3. GLUE-Aktivierung hat Chat kaputt gemacht
**Problem:** Commits `5163c68` und `56b9bc0` (GLUE für Juan Extended) haben den gesamten Chat-Flow destabilisiert. Juan Schubert antwortete plötzlich mit Adri Kastel-Inhalten ("irresistible offer", E-Commerce).

**Ursache:** Hardcoded Maxim-Fallback im Code + falscher System-Prompt-Fallback wenn `system_prompt` null.

**Fix:** Beide Commits reverted (`8cedde7`, `bcdde3d`). Hardcoded Fallbacks aus `api/chat.ts` entfernt.

### 4. OPM Status-Polling zu aggressiv
**Problem:** Neue Fehlerbehandlung warf sofort `opm_status_failed` bei jedem HTTP-Fehler im Polling — auch bei kurzen Netzwerkunterbrechungen auf iPhone.

**Fix:** Revert auf `6b82918` — Status-Poll-Fehler werden geloggt und `continue`, nicht abgebrochen.

### 5. Canvas Re-Encode verliert Audio auf Mobile
**Problem:** `correctVideoOrientation()` re-encodiert Video über Canvas. Auf Mobile wird der Audiotrack dabei oft nicht mitgenommen → Video kommt ohne Audio bei OPM an → kein Transkript.

**Fix:** Mobile-Detection — auf iOS/Android wird der Raw-Blob direkt verwendet, kein Canvas Re-Encode.

### 6. System-Prompt für Juan Schubert (Extended) fehlte
**Problem:** Extended Avatar hatte `system_prompt: null` in DB → fiel auf falschen Fallback zurück.

**Status:** Noch offen — muss noch Juan's Prompt + Voice ID in DB geschrieben werden.

---

## ⚠️ NOCH OFFEN (für Freitag kritisch)

### Höchste Priorität für Freitagstermine:

1. **Juan Schubert Live Call** — muss stabil laufen, Persona korrekt, keine Latenz-Spikes
2. **OPM Auto-Restart** — wenn OPM abstürzt, muss er automatisch neu starten (kein manuelles Eingreifen nötig)
3. **Status Dashboard** — zeigt OPM als "Operational" obwohl er down ist → Health Check muss echten `/health` Endpoint prüfen

### Mittlere Priorität:

4. **Video Messages WhatsAnima** — crash beim Senden noch nicht vollständig behoben
5. **Juan Schubert (Extended)** — System-Prompt und Voice ID müssen in DB
6. **Call History im Chat** — wann/wie lange Live Calls waren ist nicht sichtbar
7. **primary_emotion** — kommt immer noch als `null` aus OPM für viele Runs
8. **Nudge Timer** — soll auf 10 Minuten (nicht 3)
9. **GLUE für Extended Juan** — sauber einbauen ohne den normalen Juan zu stören

---

## 🔧 RUNBOOK — OPM CRASH

Wenn Video-Upload mit 500 fehlschlägt:

**Schritt 1 — Diagnosiere:**
```bash
ssh -p 50119 root@220.82.46.3
grep -n "500\|ERROR\|address already in use" /tmp/opm-uvicorn.log | tail -n 20
curl -s http://127.0.0.1:8000/health
```

**Schritt 2 — Fix:**
```bash
pkill -f "uvicorn server.server:app" || true
sleep 2
cd /workspace/opm && nohup /venv/main/bin/python3 -m uvicorn server.server:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/opm-uvicorn.log 2>&1 & disown
sleep 4
curl -s http://127.0.0.1:8000/health
```

**Erwartetes Ergebnis:** `{"status":"ok","version":"4.0","gpus":1,...}`

---

## 📋 CREDENTIALS & INFRASTRUKTUR

- **OPM Server:** `ssh -p 50119 root@220.82.46.3`
- **OPM Public URL:** `https://boardroom-api.onioko.com` / `https://opm.onioko.com`
- **ANIMA Core:** `ssh -p 19834 root@142.127.68.223`
- **WhatsAnima:** `https://whats-anima.vercel.app`
- **ANIMA Connect:** `https://anima-connect.vercel.app`
- **Supabase WhatsAnima:** `wofklmwbokdjoqlstjmy.supabase.co`
- **Supabase ANIMA Connect:** `aaluywjxshspyzhyfrrl.supabase.co`
- **Deepgram API Key:** in `/workspace/opm/.env` als `DEEPGRAM_API_KEY`

---

## 💡 LESSONS LEARNED

1. **OPM-Abstürze nicht sofort sichtbar** — Status-Dashboard muss echten Health Check machen
2. **Codex darf keine Tavus Sessions öffnen** — immer explizit verbieten in jedem Task
3. **Nie zu viele Änderungen auf einmal** — wenn etwas funktioniert, sofort committen und Tag setzen
4. **ANIMA Connect als Referenz** — wenn WhatsAnima kaputt ist, immer ANIMA Connect als funktionierende Vorlage nehmen
5. **Port-Konflikte beim OPM-Neustart** — immer `pkill` vor neuem Start

---

*Log erstellt: 19. März 2026, ~05:00 Uhr*
*Nächste Session: Freitagvorbereitung — Live Calls stabil machen*
