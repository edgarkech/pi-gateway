# Session-per-Room — pi-seitige Sessions je Raum (Option A)

**Status:** Umgesetzt (Variante A, 2026-09-17) — Feature-Flag `sessions.perRoom` (Default aus), 480 Tests grün; produktiv aktiv seit 2026-09-17 (Live-Verifikation + Aktivierung 17.09.); Label-Nachziehen + Self-Heal nachgezogen 2026-09-20 (docs/jsonl-session-labeling.md)
**Scope:** `src/core/rpc.ts` · `src/core/message-pipeline.ts` · `src/sessions/store.ts` (+ DB-Schema) · abhängig: pi-brain pipeline_wrapper (Skip-Regel, separates Projekt)
**Verwandt:** `docs/rpc-persona.md` (rpc-Felder: Modell/Systemprompt/CWD) · `docs/adr-rpc-session-management.md` (ADR-Status) · `docs/ARCHITECTURE.md`

## 1. Befund (QED-Test 2026-09-17)

- pi-RPC ignoriert das `sessionId`-Feld im `prompt`-Command (`rpc-mode.js`, case "prompt" liest nur `message`/`images`/`streamingBehavior`) → **ein RPC-Child = eine pi-Session = alle Räume gemischt** (belegt: 3 Räume acqr68sv/xjfdan6m/telegram → 1 Session-Datei `01a0ab3f`, seit 16.09 über Child-Restarts fortgesetzt).
- Überlappende Prompts aus verschiedenen Räumen werden **verworfen**: „Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')" — kein Queueing; der User erhält eine Fehlermeldung.
- Die Multiplexing-Map (Option B, D-0004) matcht Events nur über den `lastActiveSessionId`-Fallback — pi liest `prompt.sessionId` nicht.
- F-0039 („Session pro Raum/channel_id, getrennte Sessions") beschreibt nur die Gateway-Store-Buchhaltung, nicht pi-seitige Sessions.

## 2. Ziel & Nicht-Ziele

**Ziel:** Je Raum (`platform`/`channel_id`) eine eigene pi-Session — eigene JSONL-Datei, eigener Kontext, kein Mix. Überlappende Nachrichten werden **gequeued** statt verworfen.

**Nicht-Ziele:**
- Keine echte Parallelität: ein RPC-Prozess mit einem LLM-Stream bleibt; Räume serialisieren über die Queue.
- Kein pro-Raum-Prozess (Option C / ADR-Umbau, ~17 Dateien — ausdrücklich nicht gebaut).
- Kein pro-Raum-Modell/Systemprompt: die rpc-Felder (`rpc.model`/`rpc.systemPrompt`/`rpc.cwd`) bleiben gateway-weit (Cloud-Modell gegen den lokalen LLM-Engpass).
- JSONL-Labeling (Adapter/Raum-Kennzeichnung für die pi-brain-Verarbeitung) ist sekundär — wird hier nebenbei über `set_session_name` mitgeliefert.

## 3. Mechanik (pi-RPC-Bausteine, nativ, keine pi-Code-Änderung)

- `new_session` — neue Session (Datei `<ts>_<uuid>.jsonl`); feuert `session_shutdown` (reason `"new"`) für die bisherige Session.
- `switch_session { sessionPath }` — lädt eine Session-Datei; feuert `session_shutdown` (reason `"resume"`) für die bisherige Session.
- `set_session_name { name }` — `session_info`-Entry in der JSONL (maschinenlesbar, erscheint im Session-Picker).
- `get_state` — `sessionFile`/`sessionId` des aktuellen RPC-Childs erfassen.
- `agent_settled` — Event: Agent-Run vollständig settled (kein Retry/Compaction/Queue offen) → Wechsel-/Queue-Trigger.
- Hinweis: `switch_session`/`new_session` können durch Extensions abgebrochen werden (`session_before_switch`) — es sind keine solchen Handler registriert.

## 4. Store-Schema

`sessions`-Tabelle um `pi_session_file TEXT` erweitern (`ALTER TABLE … ADD COLUMN`, additiv, rückwärtskompatibel). Mapping: Gateway-Session (`platform`/`channel_id`) → pi-Session-Datei. Die Reset-Policy (daily 01:00 + 24h idle) bleibt unverändert.

## 5. Implementierung (Skizze)

- **Feature-Flag:** `sessions.perRoom: true` in `config.json` (Default `false` → heutiges Verhalten; Rollback-Pfad). `DEFAULT_CONFIG` + Deep-Merge erweitern, Typ-Validierung (boolean).
- **Erste Nachricht eines Raums** (Row ohne `pi_session_file`): `new_session` → `set_session_name "gateway:<platform>:<channelId>"` → `get_state` → `pi_session_file` in der Row speichern → `prompt`.
- **Nachricht aus bekanntem Raum** (Agent idle): Pre-Check `existsSync(pi_session_file)` — fehlt die Datei (hart gelöscht/moved): `new_session` + Label + Re-Mapping (pi wirft bei fehlendem Switch-Ziel NICHT — `SessionManager.open` öffnet still eine unlabeled frische Session mit ererbtem Timestamp, docs/jsonl-session-labeling.md §1.2.1); existiert sie: `switch_session(pi_session_file)` → Post-Switch-Verifikation via `get_state` (Re-Mapping bei Pfad-Mismatch) + Label-Nachziehen (`set_session_name` idempotent, auch im switch/resume-Zweig — Fix 2026-09-20, docs/jsonl-session-labeling.md §3) → `prompt`.
- **Agent beschäftigt:** Nachricht in eine **globale FIFO-Queue** (Serialisierung über den einen LLM-Stream); bei `agent_settled` → nächsten Queue-Eintrag verarbeiten (switch/new → prompt). Timeout je Queue-Eintrag = `promptTimeoutMs`.
- **Busy-Erkennung:** über die `agent_start`/`agent_settled`-Events (statt der heutigen Prompt-Rejection als Fehlerpfad).
- **Boot-Session:** der Child erzeugt beim Spawn eine leere Session — sie wird beim ersten Wechsel verlassen und (unmapped) vom Dreaming archiviert. Rauschen: eine leere Datei je Child-Start, bewusst akzeptiert.
- **Admin-Ops:** `stopRpc`/`restartRpc` bleiben global; Store-Mappings bleiben gültig (Session-Dateien persistieren über Child-Restarts).
- **Multiplexing:** bei strikter Serialisierung ist maximal eine Pending-Completion offen — die `pendingCompletions`-Map bleibt unangetastet (rückwärtskompatibel), verliert aber ihre kritische Rolle.

## 6. Session-Lebenszyklus & Dreaming (kritische Wechselwirkung)

- `switch_session`/`new_session` feuern `session_shutdown` (reason `"resume"`/`"new"`) → der pi-brain-Wrapper verarbeitet `"resume"` (nur `"reload"` wird gefiltert — „Session-Resume wird architektonisch gekappt" ist bewusstes Design) und **verschiebt die Session-Datei ins Archiv**. Ohne Anpassung brechen Wechsel die Raum-Sessions (Rückwechsel auf einen archivierten Pfad).
- **Skip-Regel im pi-brain-Wrapper:** vor Digest/Move die Gateway-DB lesen (read-only, `~/.pi/gateway/gateway-sessions.db`, WAL): ist die Datei gemappt (`sessions.pi_session_file = ?`) → **skip** (noop, geloggt). Sonst → Digest + Archiv.
- **Deploy-Reihenfolge (kritisch):** (1) Wrapper-Skip-Regel live, (2) erst dann Gateway-V-A-Deploy — sonst archiviert der erste Wechsel eine laufende Raum-Session.
- **Daily-Reset:** Row gelöscht → nächste Nachricht → `new_session` (neue Datei) → alte Datei unmapped → Dreaming verdichtet + archiviert sie. Kontext-Reset aligned mit der Reset-Policy.
- **Daemon-Restart:** Child-Exit feuert `session_shutdown` (reason `"quit"`) → Dateien sind gemappt → Skip. Sessions überleben Daemon-Restarts.

## 7. Verifikation

1. **Unit-Tests:** Queue (FIFO, `agent_settled`-Trigger, Timeout), Switch-Flow (new vs. switch), Store-Mapping (`pi_session_file`), Feature-Flag-Pfade (an/aus, Graceful).
2. **Qualitäts-Gates:** `tsc --noEmit` (strict), eslint, prettier, komplette Test-Suite.
3. **E2E:** Mock-Nextcloud, zwei Räume überlappend → beide beantwortet, kein Verwurf; zwei Session-Dateien entstehen; `session_info`-Namen korrekt.
4. **Live-Verifikation:** Nachrichtenserie à la QED-Test (3 Räume, überlappend) → 3 pi-Session-Dateien, keine Fehlermeldungen an die User, Wechsel sichtbar im Log.

## 8. Offene Punkte

- **pi-brain-Wrapper-Änderung** (Skip-Regel): ✅ umgesetzt und produktiv (2026-09-17, vor dem Gateway-Deploy — Deploy-Reihenfolge §6 eingehalten).
- **set_session_name-Format final:** `gateway:<platform>:<channelId>` (umgesetzt so).
- **Queue-Tiefe:** unbegrenzt mit Timeout je Eintrag (umgesetzt so); hartes Limit nur bei Bedarf.
- **Live-Verifikation:** Nachrichtenserie à la QED-Test (3 Räume, überlappend) → 3 pi-Session-Dateien, keine Fehlermeldungen an die User; danach `sessions.perRoom: true` in der Produktiv-Config aktivieren.
