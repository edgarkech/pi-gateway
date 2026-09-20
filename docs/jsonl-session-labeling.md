# JSONL-Session-Labeling — Befund & Fix

**Status:** Umgesetzt (2026-09-20) — Code-Fix gebaut, getestet (480 Tests grün), deployed und live verifiziert (acqr68sv/u4cmmzxu: frische Session mit frischem Timestamp + `session_info`-Label + Re-Mapping; Daily-Reset log-belegt "daily at 1:00"). Befund vom 2026-09-20 (empirisch verifiziert, Edgar beauftragt) darunter dokumentiert.
**Scope:** per-room-Flow im message-pipeline (`set_session_name`-Aufrufe, session-per-room.md §5) · RPC-Session-Wechsel (`src/core/rpc.ts`) · Config-Reload-Pfad (`sessions.perRoom`) · gateway.log-Sichtbarkeit
**Verwandt:** `docs/session-per-room.md` (V-A, umgesetzt + „live verifiziert" 17.09., Changelog 14:32) · pi-brain F9-Dispatch-Festzurrung (`~/.pi/projects/pi-brain/docs/ENGINE-FASSUNG-SPEC.md` §6.5, festgezurrt 2026-09-20)

## 1. Befund (Empirie 2026-09-20)

### 1.1 Design vs. Realität: Label nur im new_session-Zweig

- session-per-room.md §5: `set_session_name "gateway:<platform>:<channelId>"` wird nur bei der **ersten Nachricht eines Raums ohne Mapping** gerufen (new_session-Zweig). §2 (Nicht-Ziele): „JSONL-Labeling … wird hier nebenbei über `set_session_name` mitgeliefert" — als `session_info`-Entry in der JSONL (§3, maschinenlesbar).
- **Realität:** Sessions, die über den **switch/resume-Zweig** laufen (Mapping vorhanden), tragen **kein Label**. Verliert eine Raum-Datei ihr Label oder wird sie neu angelegt, bleibt die Session unlabeled — das „nebenbei mitgelieferte" Labeling ist kein verlässlicher Datenvertrag.

### 1.2 Belegte Beobachtungen (20.09.)

1. **acqr68sv (Igor 1:1):** Die Datei `2026-09-17T12-14-22-022Z_01a0af4a-1146-71ff-ab6d-d258bcb50745.jsonl` fehlte um ~11:00 lokal; nach dem neuen Session-Start (11:08:23 lokal / 09:08 UTC) existiert sie wieder — **neue Session-ID** (`01a0be12-e2fa-…`) **im alten Dateinamen**, **ohne** `session_info`-Entry, **ohne** `gateway:`-String in der gesamten Datei.
2. **TUI-Session (Gegenprobe):** ebenso kein Label — erwartungsgemäß (TUI, kein Gateway; die TUI-Session ist kein pi-gateway-Fall).
3. **Gateway-Log:** **0 Treffer** für `set_session_name`/`switch_session`/`new_session`/`session_info` im gesamten Log (229 KB, seit 30.08.) — session-per-room.md §7.4 verifiziert „Wechsel sichtbar im Log". Weder die RPC-Aktionen noch ihre Log-Spuren sind heute reproduzierbar.
4. **Store-Zustand (gateway-sessions.db, read-only gelesen):** `u4cmmzxu` (Test-Raum) + `mmp26ta6` (supervised bot talk): `pi_session_file = None` (unmapped); `xjfdan6m`/`acqr68sv`/telegram: `pi_session_file` zeigt auf verlorene 17.09.-Dateien (stale). Keine `session_name`-Spalte — der Raum-NAME lebt nur in Nextcloud, nicht in der DB.
5. **Verlorene 17.09.-Session-Dateien:** Die laut Changelog (17.09. 14:32) live-verifizierten „3 Session-Dateien mit Labels" existieren **weder** in `~/.pi/agent/sessions/` **noch** im pi-brain-Archiv (`~/.pi/memory/archive/sessions/` — Bestand nur bis 15.09.). Der Label-Nachweis von damals ist nicht mehr reproduzierbar.
6. **Daily-Reset-Abweichung:** session-per-room.md §6 / pi-brain WRAPPER-GATEWAY-SKIP.md §4: „Beim Daily-Reset wird die Row vor dem `new_session` gelöscht" — Realität: die Rows existieren **unverändert seit 17.09.** (created_at 17.09., stale `pi_session_file`, last_activity aktuell).

### 1.3 Hypothese (unbelegt, verifizierbar)

- **Config-Reload vs. Daemon-Start:** `sessions.perRoom: true` wurde 17.09. 14:12 per **Config-Reload ohne Daemon-Restart** aktiviert (Changelog) — 4 Minuten nach Daemon-Start (PID 25075, 14:08). Liest der Daemon das Flag nur beim Start, lief er bis zu den heutigen Neuladungen (Log 11:14:48/11:16:54: „extension loaded", „Database initialized") vermutlich **ohne** per-room-Verhalten. Die 17.09.-Live-Verifikation könnte gegen einen frisch gestarteten (Test-)Daemon gelaufen sein — beide Neuladungen lagen **nach** dem Session-Start 11:08.

## 2. Warum das wichtig ist (pi-brain F9, festgezurrt 2026-09-20)

- Die **Dispatch-Matrix** (ENGINE-FASSUNG-SPEC §6.5, E1) leitet Herkunft/Adapter/Raum aus dem **JSONL-Label** ab — bewusst **ohne Gateway-DB-Zugriff** (keine harte pi-gateway-Abhängigkeit; pi-brain/pi-worker laufen strikt-lokal-tauglich auch ohne Gateway, z. B. auf einer zweiten Maschine).
- Der Labeling-Fix ist **Voraussetzung für die Auto-Commit-Zeilen** der Matrix: fehlendes Label → TUI-Fallback (sicherer Default, HITL). Chat-Räume folgen ihrer Zeile (Chat-Profil, Auto-Commit) erst, wenn das Label zuverlässig in der JSONL steht.
- Matrix-Sicherheitsdesign: fehlendes Label ist immer die **sichere Seite** (HITL statt Auto-Commit) — der Fix liefert Funktionalität, keine Sicherheits-Abhängigkeit.

## 3. Umsetzung (2026-09-20)

- **Pre-Check statt Switch auf fehlende Datei:** `ensurePiSession` (src/core/message-pipeline.ts) prüft `existsSync(pi_session_file)` — fehlt die gemappte Datei (hart gelöscht/moved), geht der Pfad **nie** an `switch_session`; stattdessen `new_session` + Label + Re-Mapping (frischer Timestamp, frische UUID). Damit entfällt der pi-seitige Timestamp-Erbe-Fall (§1.2.1) vollständig.
- **Label im switch/resume-Zweig:** nach jedem erfolgreichen Switch `get_state` — `sessionName` ≠ `gateway:<platform>:<channelId>` → `set_session_name` (idempotent, `setPiSessionName` in src/core/rpc.ts).
- **Post-Switch-Verifikation (Self-Heal):** `sessionFile` ≠ gemappter Pfad → Re-Mapping (`setPiSessionFile`); deckt den Fall ab, dass pi still auf eine andere Datei landet. Verifikationsfehler brechen die Nachricht nicht.
- **Log-Sichtbarkeit:** `new_session`/`switch_session`/`set_session_name` loggen jetzt Aktion + Ergebnis (sessionFile/sessionId/sessionName) — §7.4-Verifikation reproduzierbar per grep.
- **Daily-Reset-Fix (src/sessions/store.ts):** Reset-Grenze referenziert `created_at` statt `last_activity` (`crossedDailyBoundary`); der frühere Stunden-Vergleich mit last_activity (bei jeder Nachricht aktualisiert) machte den Daily-Reset praktisch unerreichbar (§1.2.6). resetPolicy=both: daily 01:00 + 24h idle unverändert.
- **Tests:** `tests/sessions/store-daily-reset.test.ts` (10) + `tests/core/pipeline-per-room-label.test.ts` (7); 480 Tests grün.

Hinweis (Edgar, 2026-09-20): die in §1.2.5/§5 erwähnten "verlorenen" Session-Dateien wurden im Rahmen einer Aufräumaktion hart gelöscht — kein weiterer Analysebedarf.

## 4. Fix-Anforderungen (2026-09-20 — alle abgedeckt, siehe §3)

1. **Label im switch/resume-Zweig:** `set_session_name` auch beim Wechsel auf eine bekannte Raum-Datei setzen — oder bei jeder Raum-Nachricht prüfen (Label fehlt/abweichend → nachziehen). Idempotent.
2. **Datei-Neuanlage nach Verlust:** dasselbe Nachziehen, wenn der RPC eine neue Session in den gemappten Pfad schreibt (heute beobachtet: neue Session-ID im alten Dateinamen, unlabeled).
3. **Config-Reload-Pfad verifizieren:** prüfen, ob `sessions.perRoom` nach einem Reload ohne Daemon-Restart sauber greift; falls nicht — Reload-Fix oder dokumentierter Restart-Pfad.
4. **Log-Sichtbarkeit:** Session-Aktionen (`set_session_name`/`switch_session`/`new_session`) so loggen, dass die dokumentierte Verifikation (§7.4 „Wechsel sichtbar im Log") reproduzierbar ist.
5. **Daily-Reset klären:** Row-Löschung vs. Realität (Rows seit 17.09. unverändert, stale `pi_session_file`); Reset-Policy `both` (daily 01:00 + idle) verifizieren.
6. **2 unmapped Räume:** `u4cmmzxu`/`mmp26ta6` — nächste Nachricht sollte new_session + Label setzen (Doku-Verhalten); verifizieren.

## 5. Verifikation (nach dem Fix — durchgeführt 2026-09-20)

1. **Unit-Tests:** Label-Nachziehen (switch/resume, Datei-Neuanlage) idempotent; Config-Reload-Pfad (Flag greift nach Reload).
2. **E2E:** Raum-Session → Datei entfernen → neue Nachricht → neue Session **mit Label**; switch/resume → Label bleibt bzw. wird nachgezogen; overlapping prompts (Queue) unverändert grün.
3. **Live-Verifikation:** acqr68sv/xjfdan6m/telegram → `session_info`-Entry je Session prüfbar (`grep 'gateway:' <session>.jsonl`), Log zeigt die Aktionen. **Ergebnis 2026-09-20:** acqr68sv ✅ (Daily-Reset feuerte, fresh session mit frischem Timestamp, session_info-Label, Re-Mapping) · u4cmmzxu ✅ (unmapped → new_session + Label + Mapping) · xjfdan6m/telegram/mmp26ta6 heilen beim ersten Kontakt (gleicher Mechanismus).
4. **pi-brain-Abnahme:** Dispatch-Matrix matched die Labels (TUI-Fallback unberührt; kein Gateway-DB-Zugriff im pi-brain-Wrapper).

## 6. Offene Punkte

- ~~Verbleib der 17.09.-Session-Dateien~~ — geklärt 2026-09-20 (Edgar): hart gelöscht im Rahmen einer Aufräumaktion, kein weiterer Analysebedarf.
- **Daemon-Restart-Verhalten:** nach einem Restart perRoom-Verhalten sauber verifizieren (Flag beim Start vs. Reload) — Reload-Pfad code-seitig verifiziert (Pipeline liest `sessions.perRoom` pro Nachricht, Watcher lädt validiert live).
- **pi-brain-seitige Umsetzung** (Dispatch-Matrix, Wrapper-Dispatch, Profile `lauf-allgemein.md`/`lauf-group.md`) ist pi-brain-Thema (ENGINE-FASSUNG-SPEC §6.5) — hier nicht Gegenstand.
