# pi-gateway Roadmap

## 🎯 Gesamtziel
Entwicklung eines robusten und modularisierten Channel-Adapters für den Pi-Agenten. Ziel ist es, eine zuverlässige Kommunikation mit dem Pi von außerhalb (z. B. via Telegram und Nextcloud Talk) zu ermöglichen. Ein zentraler Bestandteil ist die volle Unterstützung von File-Attachments, um dem Agenten die Verarbeitung von Dokumenten und Bildern zu erlauben.

---

## 🗺️ Roadmap

### Phase 1: Foundation (Architektur & Core) — ✅ COMPLETED
*Ziel: Schaffung eines stabilen, modularen Fundaments, um parallele Kommunikation und korrekte Session-Zuordnung zu ermöglichen.*

- [x] **W1: Modularisierung der `index.ts`** ✅ (Phase 1.2, `refactor_plan_phase_1.md`, 2026-08-19)
  - Aufbrechen des Monolithen in logische Module (`src/core/server.ts`, `src/core/rpc.ts`, `src/core/commands.ts`, `src/core/daemon.ts`, `src/core/tools.ts`, `src/core/status-footer.ts`, `src/core/message-pipeline.ts`, `src/adapters/registry.ts`, `src/sessions/store.ts`, `src/security/auth.ts`). `src/index.ts` ist jetzt ein dünner Entry-Point (50 Zeilen); Logik verhaltensneutral via `runtime`-Container verteilt.
- [x] **B7: Session-Isolation** ✅ (2026-08-20)
  - RPC-Protokoll erweitert: `sessionId` wird pro Nachricht an den pi-Agenten übergeben.
- [x] **B4: Race Condition Fix** ✅ (2026-08-20)
  - Completion-Handling von einer FIFO-Queue auf ein Mapping (`Map<sessionId, PendingRequest>`) umgestellt, sodass Antworten korrekt den Chats zugeordnet werden.

### Phase 2: Cleanup (Stabilisierung & Qualität) — ✅ COMPLETED
*Ziel: Behebung der bestehenden Bugs und Erhöhung der Code-Qualität/Wartbarkeit.*

- [x] **Bugfixing:**
  - [x] **B1:** Rate-Limiting im Message-Pfad korrekt aktiviert (`isRateLimited` in `core/message-pipeline.ts`).
  - [x] **B2:** Pairing-Flow (Code-Generierung) in den Message-Pfad integriert (`isPairingRequired` + `generatePairingCode`).
  - [x] **B3:** Bereinigung der `Platform`-Union (Typen korrigiert, ungenutzte/entfernte Plattformen bereinigt; `twitch` entfernt).
  - [x] **B6:** Twitch-Adapter entfernt (`src/adapters/twitch.ts` gelöscht, keine Referenzen mehr).
  - [x] **B8:** Robustheit verbessert (WhatsApp-Dependencies, Imports).
- [x] **Code Quality:**
  - [x] **W2:** TypeScript `strict`-Flags im `tsconfig.json` aktiviert und `any`-Typen eliminiert.
  - [x] **W4:** Einheitliche Formatierung via Prettier + Linting via ESLint eingeführt (`npm run format`, `npm run lint`).
  - [x] **W5:** Unit-Tests für Kernmodule etabliert (`tests/security/*`, `tests/sessions/*`, `tests/adapters/*` — Vitest).
  - [x] **W6:** Dokumentation (README) mit dem tatsächlichen Code synchronisiert (S9, diese Aufgabe).

### Phase 2.5: Operational Validation & Deployment — 🔵 IN PROGRESS (Pending Real-World Validation)
*Ziel: Verifizierung der stabilen, modularisierten Architektur in der realen Produktionsumgebung und Sicherstellung der Betriebsbereitschaft vor der Funktionserweiterung.*

- [x] **1. Deployment & Installation Audit**
    - [x] Pre-Install-Check: Mentale Simulation der Installation & Korrektur der `README.md`.
    - [x] Clean Install: Durchführung einer sauberen Installation (Build-Prozess, Dependency-Check, `npm install`) auf dem Zielsystem.
    - [x] Service-Integration: Korrekte Einbindung in den Systemdienst (via `systemd` User-Service) und Überprüfung der Boot-Sequenz.
    - [x] Environment Check: Validierung der benötigten Umgebungsvariablen und Konfigurationsdateien.
    - [!] *Note: Deployment verified, pending long-term stability check in production.*
- [x] **2. End-to-End (E2E) Connectivity Test**
    - [x] Full-Loop Verification: Test des gesamten Nachrichtenpfads für den primären Adapter (Telegram).
    - [x] (Session-Isolation Test wurde auf Phase 4 verschoben).
- [ ] **3. Resilienz & Edge-Case Testing**
    - [ ] Network Flakiness: Simulation von Verbindungsabbrüchen & Wiederverbindung.
    - [ ] Service Restarts: Verhalten bei Neustart des `pi-gateway`-Dienstes.
    - [ ] Rate-Limiting & Stress: Test der Rate-Limits unter realen Bedingungen.
    - [!] *Note: To be validated via real-world usage.*
- [ ] **4. Observability & Logging**
    - [ ] Log-Audit: Aussagekraft der Logs in der modularen Struktur.
    - [ ] Error Handling: Werden Fehler (z. B. ungültige RPC-Calls) sauber abgefangen?
    - [!] *Note: To be validated via real-world usage.*

### Phase 3: Input Expansion (File-Attachments) — ✅ COMPLETED
*Ziel: Unterstützung von Medien-Inhalten.*

- [x] Erweiterung des `PlatformMessage`-Interfaces für Anhänge (Metadata, LocalPath). ✅
- [x] Implementierung eines zentralen `media/`-Moduls (Download-Logik, lokaler Speicher, TTL-Cleanup). ✅
- [x] Integration des Datei-Handlings in den Telegram-Adapter (und ggf. Discord/WhatsApp). ✅
- [x] Integration der Pfad-Übergabe an den pi-Agenten (Prompt-Materialisierung: "Nutzer hat Datei X angehängt..."). ✅

### Phase 4: Channel Expansion (Nextcloud Talk) — 🔵 IN PROGRESS (S1–S7 ✅, Deployment/Real-World ausstehend)
*Ziel: Erweiterung der Kommunikationswege. Konzept: `docs/concept_phase_4_nextcloud.md` (Option B: OCS User-Polling, Betrieb ohne öffentliche URL).*

- [x] **S1:** `OcsClient` + Talk-Typen (`src/adapters/nextcloud/ocs.ts`, `talk-types.ts`) + Tests (`tests/adapters/nextcloud/ocs.test.ts`).
- [x] **S2:** `talk_state`-Wasserstands-Store (SQLite, Warm-Start, Room-Prune) + Tests (`src/adapters/nextcloud/store.ts`, `store.test.ts`).
- [x] **S3:** `NextcloudTalkPoller` — Long-Poll primär / Interval-Fallback, Backoff + Circuit-Breaker, DoS-Kontrolle (D9), Anti-Loop-Selbstfilter (D4) + Tests (`src/adapters/nextcloud/poller.ts`, `poller.test.ts`).
- [x] **S4:** `NextcloudTalkAdapter` — Inbound-Pipeline (`isPublishable`-Anti-Loop-Core, Rich-Text-Auflösung, Media-Ingest via WebDAV), Outbound (Send/Edit/Delete, Chunking >32k/N6) + Tests (`src/adapters/nextcloud-talk.ts`, `tests/adapters/nextcloud-talk.test.ts`).
- [x] **S5:** Config-Integration (`types.ts`, `config.ts`, `config.default.json` inkl. Env-Override), Registry-Wiring (`registry.ts`), Daemon-Shutdown (stopAdapters → `shutdownTalkStateStore`) + Tests (`tests/adapters/registry-nextcloud.test.ts`).
- [x] **S6:** Pipeline-Smoke/E2E (`tests/core/pipeline-nextcloud.test.ts`: Inbound → WebDAV-Media → MediaManager → Adapter → Agent-Antwort, Allowlist, Restart-ohne-Duplikat) + **Anti-Loop-Edge-Test** (`tests/core/anti-loop-edge.test.ts`: Bot-Antwort auslösende Polls triggern keinen 2ten Agent-Call — Edit-Sturm, Chunked-Langantwort, gemischte Batches, nicht-publishable Typen, Ablehnungs-Loop, Restart) + README/ROADMAP-Sync.
- [x] **S7:** E2E gegen reale Nextcloud-Instanz (`nextcloud.example.com`, NC 33) abgeschlossen: alle 5 Szenarien (Empfangen, Antworten, Media inbound, Loop-Freiheit, Restart) gruen, Gesamtsuite 403/403. Fix OCS-Regel (NC 33 sendet `statuscode 200`) + NC-33-Poll-Semantik in E2E-Harness. Checklist `docs/phase4-e2e.md`.

> **Nächster Schritt (nicht mehr in dieser Session): Phase 2.5 — Deployment & Real-World-Testing** (Resilienz/Edge-Cases, Service-Restart, Langzeitstabilität gegen Live-Instanz).

#### Phase 4 — Stand 2026-08-30
- [x] **2. Talk-Raum `room-token-2` ("Interner Bot-Talk") live:** war vormals 401, jetzt app-token-lesbar (Bot=Owner, readOnly=0). Zur `config.json` (`rooms=[room-token-1, room-token-2]`) hinzugefuegt, Daemon neugestartet; E2E-Round-Trip verifiziert (eigene Session pro Raum).
- [ ] **File-Test ueber Talk (P2):** NC-33-Client-File-Share-Format noch NIE mit echtem Client verifiziert (`extractFileObjects` deckt nur `messageParameters type=file` ab, bisher nur Mock/E2E-Harness). Erster Live-Test kam nicht an — erneut testen.

#### Kleinere Fixes (S7-Follow-ups) — NÄCHSCHRITT, vor Slash-Commands
- [ ] **P2a — `setReadMarker=1`:** OCS-Methode existiert, wird aber nicht aufgerufen → Ungelesen-Zaehler in Nextcloud bleibt. Kosmetisch.
- [ ] **P2b — `autoDiscoverRooms` / `roomRefreshIntervalMs`:** in config/types konfiguriert, aber nicht konsumiert (Reserve fuer MVP/D2).
- [ ] **P3 — TUI-Flapping:** kosmisches Flackern der Statusanzeige im Idle (RPC-Timing); `generation`-Counter vorhanden, aber keine Test-Invariante.
- [ ] **SIGHUP / Config-Reload → Poller-Restart:** ausgelagert (groesserer `daemon.ts`-Eingriff, nie implementiert).

### Phase 5: Meta-Commands / Slash-Commands — ⚪ PLANED (nach kleineren Fixes)
*Ziel: Steuerungs-Commands fuer den Pi-Agenten auch ueber die Kanaele (insb. Nextcloud Talk). Aktuell OUT OF SCOPE: der Anti-Loop-Filter `isPublishable` (§5.3) wirft Talk-Slash-Commands (`messageType=command`) verworfen; Gateway-Meta-Commands (/new,/status,/model) laufen nur als reine Textnachrichten (§8).*

- [ ] **Entscheidung:** Umfang festlegen — reale Talk-Slash-Commands unterstuetzen vs. eigene Feature-Phase. (vertagt 2026-08-25, jetzt als erforderlich bestaetigt.)
- [ ] **Pflicht-Commands:** /new (Session neu), /status (Zustand), /stop (Aktuelle Antwort abbrechen) + ggf. weitere.
- [ ] **Umsetzung:** Command-Routing im Message-Pfad; Abgrenzung zu publishbaren Chat-Nachrichten; Anti-Loop-bewahrt.

---
*Letzte Aktualisierung: 2026-08-30*
