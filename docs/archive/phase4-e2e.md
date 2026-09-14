# Phase 4 — S7 E2E gegen reale Nextcloud Talk Instanz

## Ziel
Verifikation der Nextcloud Talk Integration über die **echte** OCS/WebDAV-Schnittstelle
(extern gehostet, `https://nextcloud.example.com`). Abdeckung der in der ROADMAP für S7
definierten Invariante: **Empfangen → Antworten → Media → Loop-Freiheit → Restart**.

## Zugangsdaten (NICHT ins Git!)
Lokal in `docs/nextcloud-test.env` (siehe `.gitignore`). Der Test liest diese Datei
ein (dotenv-parse), ohne Secrets in Code/Tests/Memory zu schreiben:
- `GATEWAY_NEXTCLOUD_BASE_URL=https://nextcloud.example.com`
- `GATEWAY_NEXTCLOUD_USER_ID=bot-user`
- `GATEWAY_NEXTCLOUD_APP_TOKEN=<redacted>`
- `GATEWAY_NEXTCLOUD_ROOM=room-token-1`

## Test-Strategie
Ein **isoliertes Gateway** wird gegen die reale Instanz betrieben, ohne die laufende
`~/.pi/gateway/config.json` zu beeinflussen:
- Der Test baut sich seine eigene `NextcloudTalkAdapter`-Instanz mit Config aus den
  Env-Variablen (`enabled:true`, `baseUrl`, `userId`, `appToken`, `rooms:[room]`).
- Der **Agent-Call wird gemockt** (Spy auf die Callback-Antwortfunktion), damit kein
  echter pi-Agent aufgerufen wird und die Antwort deterministisch verifizierbar ist.
- Der Poller läuft im realen `long-poll`-Modus; der Test triggert Inbound, indem er
  eine Test-Nachricht über `OcsClient` (`messages:send`) in den Room postet.
- Isoliertes `GATEWAY_DB_DIR` (temporär) für den talk_state-Store, um Wasserstände
  nicht mit dem Betrieb zu teilen.

## E2E-Szenarien
1. **Empfangen:** Test-Nachricht posten → Poller ruft sie über Long-Poll ab → Adapter
   löst Agent-Call aus (gemockt) → korrekte Session-Zuordnung.
2. **Antworten:** Mock-Antwort → Adapter sendet `messages:send` → Nachricht im Room
   vorhanden (via `messages:list` verifizierbar).
3. **Media inbound:** Datei via WebDAV (`files:put`) im Room ablegen → Poller/Adapter
   erkennt Attachment → MediaManager materialisiert → Agent-Call mit Pfad.
4. **Loop-Freiheit:** Bot-Antwort auslösende Nachricht (Edit/Sturm) → kein zweiter
   Agent-Call (Invariante: 1 Agent-Call pro User-Nachricht).
5. **Restart:** Adapter stoppen + neu starten (oder Process-Simulation) → kein
   Double-Send / kein Re-Processing der bereits verarbeiteten Nachricht (Wasserstand
   im Store überlebt den Restart).

## Deliverables
- `tests/adapters/nextcloud/nextcloud-e2e.test.ts` — die 5 Szenarien oben.
- Ggf. kleiner Helper `tests/adapters/nextcloud/e2e-harness.ts` für Setup/Teardown
  (isolierter Adapter + Mock-Callback + Env-Lade-Logik).

## Randbedingungen
- Reale Instanz = echte Latenz; Poll-Timeouts realistisch setzen (Long-Poll ~30s).
- Tests gegen reale Instanz sind potenziell flaky (Netzwerk) — Retry/Timeout sauber
  abfangen, aber keine fake-OCS-Näherung verwenden (Soll-Szene ist die echte Instanz).
- Bestehende Tests (393) müssen grün bleiben; neue Tests in separater Datei.
