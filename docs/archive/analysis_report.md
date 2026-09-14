# pi-gateway — Technischer Architekturbericht

| | |
|---|---|
| **Repository** | `~/pi-gateway` (Fork von [0xKobold/pi-gateway](https://github.com/0xKobold/pi-gateway), npm `@gamalan/pi-gateway`) |
| **Version** | 1.10.1 |
| **Stack** | TypeScript (ESM, Node ≥ 21 implizit), better-sqlite3, ws; peer: `@earendil-works/pi-coding-agent`, `@sinclair/typebox` |
| **Analyse-Datum** | 2026-08-18 |
| **Umfang** | ~7.900 Zeilen in `src/` + `tests/` (17 Module) |

---

## Executive Summary (TL;DR)

| Frage | Kurze Antwort |
|---|---|
| **1. Code-Struktur & Qualität** | Mittel-schichtig gut: sauberes Adapter-Pattern, klare Module, exzellente README. Aber: `index.ts` ist eine 2.578-zeilige God-File, `strict: false`, viel `any`, Modul-Level-State ohne DI, Tests decken nur `status.ts` ab. Für einen anderen Entwickler **verständigbar und weiterentwickelbar**, mit bekannten Stolpersteinen (siehe §2.3). |
| **2. File-Attachments** | **Nicht unterstützt.** `PlatformMessage` hat kein Attachment-Feld; alle Adapter werfen nicht-textuelle Inhalte weg (nur `text`/`caption`). Kein Download-, Speicher- oder Upload-Code existiert. Ausbaustufe: mittel, Design-Skizze in §3.3. |
| **3. Telegram Webhook → Long-Polling** | **Bereits umgesetzt.** Long-Polling via `getUpdates` ist der Default (wenn `webhookUrl` fehlt), mit Backoff und Offset-Tracking. Umstellung = **reine Config-Änderung**, kein Code nötig. Details & Lücken in §4. |
| **4. Nextcloud Talk** | **Machbar, Aufwand: mittel.** Das Provider/Adapter-Pattern ist der perfekte Anker — ein neuer `NextcloudTalkAdapter` reicht strukturell. Zwei API-Wege: (A) offizielle **Talk Bot API** (Webhook, NC ≥ 27.1, braucht erreichbare URL) oder (B) **OCS Chat-API als User mit echtem Long-Polling** (`lookIntoFuture=1`, keine öffentliche URL nötig). Empfehlung: B für Self-Hosting ohne öffentliche URL, A für dedizierte Bot-Identität. Details in §5. |

---

## 1. Systemüberblick

### 1.1 Was ist pi-gateway?

Eine **pi-Extension** (`pi.extensions` in `package.json`), die eine Chat-Bridge zwischen Messaging-Plattformen und dem pi Coding Agent aufbaut. Zwei Betriebsmodi:

- **Inline:** läuft innerhalb eines pi-Sessionsprozesses, gesteuert über `/gateway start|stop|…`.
- **Detached Daemon:** `pi-gateway start -d` spawnt einen eigenen Prozess (`dist/index.js --daemon`), der nach dem Schließen von pi weiterläuft. PID-File (`~/.pi/gateway/gateway.pid`), Health-Check über die eigene HTTP-API, Config-Hot-Reload via `watchFile`, SIGHUP-Reload, sauberes Shutdown mit Listener-Rollback.

Der Agent-Anschluss ist ein **RPC-Prozess**: Der Gateway spawnt `pi --mode rpc --extension dist/extensions/pi-gateway-ask-user-rpc.js` und spricht JSON-over-stdin/stdout (`prompt`, `set_model`, `get_available_models`, `agent_end`, `message_update`/`text_delta`, `extension_ui_request/response`).

### 1.2 Architektur-Diagramm

```
                        ┌──────────────────────────────────────────────────────┐
                        │                  pi-gateway Prozess                  │
 Telegram (poll/webhook)│                                                      │
 Discord (WS Gateway)   │  ┌─────────────┐   ┌──────────────────────────────┐  │
 Slack (outbound only)  │  │ Adapters    │   │  Core (index.ts)             │  │
 Twitch (EventSub WS)   │◄─┤ BaseAdapter │◄─►│  • HTTP/WS Server :3847      │  │
 WhatsApp (Baileys)     │  │  .start()   │   │  • RPC-Proc-Mgmt (pi --mode  │  │
                        │  │  .sendMessage│  │    rpc) + PendingRequests    │  │
                        │  │  .sendInter- │  │  • /gateway Commands & Tools │  │
                        │  └──────┬──────┘   │  • Daemon-Lifecycle          │  │
                        │         │ PlatformMessage (nur Text!)             │  │
 HTTP/WS Clients ──────►│  ┌──────▼──────┐   └──────────────┬───────────────┘  │
                        │  │ onMessage:  │                  │ spawn "pi"       │
                        │  │ Session +   │   ┌──────────────▼───────────────┐  │
                        │  │ Security +  │   │  pi Agent (RPC)              │  │
                        │  │ Tool-Guard  │   │  Tools, extension_ui_request │  │
                        │  └──────┬──────┘   └──────────────────────────────┘  │
                        │         ▼                                             │
                        │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │
                        │  │ Sessions DB  │ │ Security DB  │ │ Background DB │ │
                        │  │ (SQLite/WAL) │ │ (SQLite/WAL) │ │ (SQLite/WAL)  │ │
                        │  └──────────────┘ └──────────────┘ └───────────────┘ │
                        └──────────────────────────────────────────────────────┘
```

### 1.3 Modul-Karte

| Modul | Datei | Zeilen (ca.) | Verantwortung |
|---|---|---|---|
| Entry/Extension/Daemon | `src/index.ts` | 2.578 | Config, HTTP/WS-Server, RPC-Prozess, `/gateway`-Commands, Tool-Registrierung, Daemon-Lifecycle |
| CLI | `src/cli.ts` | ~330 | `pi-gateway start/stop/status` (Daemon-Verwaltung) |
| Adapter-Basis | `src/adapters/base.ts` | ~230 | `BaseAdapter`, `PlatformMessage`, `AdapterCallbacks`, `InteractivePrompt`, generischer Prompt-Fallback |
| Telegram | `src/adapters/telegram.ts` | ~640 | Long-Polling + Webhook, Inline-Keyboards, ForceReply |
| Discord | `src/adapters/discord.ts` | ~300 | Gateway-WS-Client (eigener Heartbeat/Identify) |
| Slack | `src/adapters/slack.ts` | ~330 | Outbound (Webhook/Web API); Inbound-Methode vorhanden, aber nicht verdrahtet |
| Twitch | `src/adapters/twitch.ts` | ~318 | EventSub-WS; **nur Stream-Online/Offline**, kein Chat |
| WhatsApp | `src/adapters/whatsapp.ts` | ~300 | Baileys (devDependency!), QR-Login, Text + Bild-Caption |
| Sessions | `src/sessions/store.ts` | ~390 | Per-Chat-Sessions in SQLite, Reset-Policies (daily/idle/both) |
| Security | `src/security/auth.ts` | ~520 | Allowlist, Pairing-Codes, Admins, Rate-Limit (SQLite) + Config-UIDs |
| Tool-Policy | `src/security/tool-policy.ts` | ~470 | Default-Policies + DB-Policies, Prompt-Guard-Generierung |
| Background | `src/background/manager.ts` | ~430 | Hintergrund-Tasks via `pi --mode json --print`, Ergebnis-Lieferung per Cron |
| Interactive Bridge | `src/interactive.ts` | ~250 | `extension_ui_request` → Adapter-UI, Response-Korrelation |
| Status/Health | `src/status.ts` | ~320 | Daemon-Health, PID-Handling, Status-Report (gut getestet) |
| Logger | `src/logger.ts` | ~75 | File-Logger nach `~/.pi/gateway/gateway.log` (schützt die TUI) |
| Pfade | `src/paths.ts` | ~40 | Config-Pfade, Package-Root-Auflösung |
| RPC-Bridge-Extension | `src/extensions/pi-gateway-ask-user-rpc.ts` | ~100 | Interceptet `ask_user_question` in RPC-Mode → select/confirm |
| Tests | `tests/index.ts` | ~387 | Assert-basiert, **nur `status.ts`** |

### 1.4 Datenfluss (Eingangs-Nachricht)

```
Adapter.handleUpdate → PlatformMessage{content: string}
  → adapterCallbacks.onMessage (index.ts)
    → getOrCreateSession (SQLite, Reset-Check)
    → isUserAllowed (allowAll / config UIDs / DB-Allowlist)
    → /model- & /restart-Behandlung (Admin)
    → buildPolicyGuard (Prompt-Guard voranstellen)
    → Adapter: "⏳ Thinking…" Placeholder + Typing-Heartbeat (4s)
    → sendPromptRpc → pi stdin {type:"prompt"}
    → text_delta → gedrosselte editMessage (400ms)
    → agent_end → finale editMessage, Typing aus
```

### 1.5 Persistenz

| Artefakt | Ort |
|---|---|
| Config | `~/.pi/gateway/config.json` (auto-seeded aus `config/config.default.json`) |
| Sessions | `~/.pi/gateway/gateway-sessions.db` |
| Security (Allowlist/Pairing/Admins/RateLimit) | `~/.pi/gateway/gateway-security.db` |
| Background Tasks | `~/.pi/gateway/gateway-background-tasks.db` |
| Log | `~/.pi/gateway/gateway.log` |
| PID | `~/.pi/gateway/gateway.pid` |

---

## 2. Frage 1: Code-Struktur & Qualität

### 2.1 Stärken

- **Kohärentes Provider/Adapter-Pattern.** `BaseAdapter` (abstrakt) + `PlatformAdapter`-Interface definieren einen klaren Vertrag: `initialize/start/stop/sendMessage/editMessage/deleteMessage/setTyping/getStatus/sendInteractive/cleanupInteractive`. Neue Plattformen sind damit ein eigenständiges Modul ohne Kernänderung — genau das, was für Nextcloud Talk gebraucht wird (§5).
- **Klare Separation in den Fachmodulen.** `sessions/`, `security/`, `background/` sind jeweils eigenständige, gut dokumentierte Module mit eigener DB und sauberer API. Jedes Modul beginnt mit einem Header-Kommentar, der Architektur und Caveats erklärt (z. B. `tool-policy.ts` dokumentiert explizit, dass der Guard **kein** kryptografisches Security-Boundary ist).
- **Sehr gute README** — Features, Config, Security, Commands, API, Architecture-Diagramm. Onboarding eines neuen Entwicklers ist damit realistisch in Stunden, nicht Tagen.
- **Sinnvolle defensive Details:** WAL-PRAGMAs, Indexe auf Hot-Paths, Backoff-Logik, Fire-and-forget mit begründetem Kommentar (Telegram-Polling), Listener-Rollback beim Daemon-Config-Reload, Health-verifizierte PID-Signale (kein blindes `kill`).
- **Benennung** durchgehend konsistent und selbstexplizierend (`getOrCreateSession`, `buildPolicyGuard`, `waitForGatewayHealth`).

### 2.2 Schwächen

| # | Befund | Ort | Einordnung |
|---|---|---|---|
| W1 | **God-File `index.ts` (2.578 Zeilen):** HTTP-Server, WS-Server, RPC-Prozess-Mgmt, ~1.300 Zeilen Command-Handler, 5 Tool-Definitionen, Daemon-Lifecycle, Streaming-Orchestrierung — alles in einer Datei mit Modul-Level-Variablen (`config`, `state`, `rpcProcess`, `globalCtx`, `pendingCompletions`…) | `src/index.ts` | Größtes Wartbarkeitsrisiko. Natürliches Refactoring: `server/http.ts`, `server/ws.ts`, `rpc/client.ts`, `commands/*.ts`, `daemon.ts`. |
| W2 | **`strict: false`** im tsconfig + durchgehende `any`-Typisierung (`createRpcProcess(): any`, `handleUpdate(update: any)`, `data: any` in Discord/Twitch) | `tsconfig.json`, Adapter | Typsicherheit nur deklarativer Natur; Typos in RPC-Payloads fallen erst zur Laufzeit auf. |
| W3 | **Kein Dependency Injection, Modul-Level-State** — alles hängt an importierten Singletons (`initSessionStore()` etc.) und Closures in `index.ts`. Unit-Tests sind ohne Mocking-Fugen kaum möglich (daher auch nur 1 getestetes Modul). | global | Erklärt die Test-Lücke. |
| W4 | **Inkonsistente Formatierung:** `telegram.ts`/`index.ts`/`security/*` mit Tabs, `discord.ts`/`whatsapp.ts`/`slack.ts`/`twitch.ts` mit 2 Spaces; keine Linter/Formatter-Konfiguration im Repo | Adapter | Hinweis auf Fork-Geschichte; `.editorconfig` + `eslint`/`prettier` wären ein Quick-Win. |
| W5 | **Testabdeckung minimal:** `tests/index.ts` ist ein Assert-Skript (kein Framework) und deckt ausschließlich `status.ts` ab. Adapter, Sessions, Security, Tool-Policy, Background: ungetestet. | `tests/` | Für ein Security-relevantes Gateway (Allowlist, Policy-Guard) auffällig dünn. |
| W6 | **Dokumentation ≠ Code** (mehrere Fälle, s. §2.3) | README vs. Code | Erosionssignal; README-Abschnitte veralten. |

### 2.3 Konkrete Befunde: Bugs, Dead Code, Doku-Lücken

| # | Befund | Detail |
|---|---|---|
| B1 | **Rate-Limiting ist implementiert, aber nie aufgerufen.** `checkRateLimit()` in `security/auth.ts` wird nirgends importiert — die Config `security.rateLimit` hat keine Wirkung. | Dead Code / Sicherheits-Lücke (README bewirbt Rate Limits) |
| B2 | **Pairing-Flow wie in der README beschrieben existiert nicht im Message-Pfad.** Ein nicht-erlaubter User erhält nur „You are not allowed…“ — es wird kein Pairing-Code generiert. `generatePairingCode` ist nur über das `gateway_pairing`-Tool erreichbar. `requirePairing` wird gelesen, aber nie geprüft. | Doku-Lücke / Feature-Fehlanzeige |
| B3 | **`Platform`-Union enthält `"twitch"` nicht** (`discord \| telegram \| slack \| whatsapp \| signal \| sms \| email \| matrix \| web \| websocket`). Twitch-Nachrichten laufen nur dank `strict: false` durch. Zusätzlich listet die Union Plattformen, die es gar nicht gibt (signal, sms, email, matrix). | Typ-Bug / Verwirrung |
| B4 | **Konkurrenz-Bug im Completion-Handling:** `pendingCompletions` ist eine FIFO-Queue ohne Korrelation zwischen Prompt und Antwort. `text_delta`-Events gehen immer an `[0]`, `agent_end` löst den Queue-Head auf. Bei **parallel laufenden Prompts** (Telegram behandelt Updates bewusst fire-and-forget!) werden Streams vermischt und Antworten dem falschen Chat zugeschrieben. `setActiveChannel` ist ebenfalls global — UI-Requests landen unter Last im falschen Channel. | Reales Bug-Risiko, vor allem mit Telegram + mehreren Usern |
| B5 | **Slack-Inbound ist nicht verdrahtet:** `handleIncomingEvent()` existiert, aber kein Socket-Mode-/Events-Client ruft sie auf. Slack ist faktisch outbound-only (trotz README „Multi-platform adapters … Slack“). | Feature-Lücke |
| B6 | **Twitch-Adapter sendet nie Chat-Nachrichten:** `sendMessage` ist ein No-Op, `subscribeToChannel` erstellt keine EventSub-Chat-Subscription (Kommentar: „requires webhook transport“). Nur Stream-Status-Events. | README übertreibt |
| B7 | **„Per-chat sessions“ sind nur nominell:** Session-IDs werden in SQLite geführt und Resets ausgewertet, aber die Session-ID wird **nie an den pi-RPC-Prompt übergeben** — alle Chats teilen sich eine einzige Agent-Konversation im einen RPC-Prozess. „Isolierte Konversationen“ (README) existieren auf Agent-Ebene nicht. | Architektur-Lücke (größtes konzeptionelles Problem) |
| B8 | Kleinigkeiten: `DiscordAdapter.getBotId()` leitet die Bot-ID aus dem Token ab (funktioniert, ist aber ein bekannter Trick statt `/users/@me`-Cache); `onTyping`-Callback deklariert aber ungenutzt; WhatsApp-Baileys liegt in `devDependencies`, wird aber zur Laufzeit dynamisch importiert (npm-Publish ohne devDeps bricht den Adapter). | Robustheit |

### 2.4 Urteil zu Frage 1

> **Ja, prinzipiell ordentlich und modular — mit einer klaren Schieflage.** Die Fachschicht (Adapter, Sessions, Security, Background) ist gut getrennt, benannt und dokumentiert; ein erfahrener TypeScript-Entwickler kann das System in kurzer Zeit verstehen und neue Adapter bauen. Die **Kernschicht (`index.ts`) ist dagegen ein Monolith** mit globaler State, `any`-RPC-Typisierung und ohne DI, was Änderungen am Message-Pfad riskant macht. Dazu kommen die Befunde B1–B7: Das System ist „funktionierend, aber nicht ganz das, was die README verspricht“. Für eine Weiterentwicklung (Attachments, Nextcloud) ist der Zustand **gut genug**, weil die relevanten Erweiterungspunkte (Adapter-Schnittstelle, Config, HTTP-Server) sauber exponiert sind.

---

## 3. Frage 2: File-Attachments

### 3.1 Ist-Zustand: **Keine Attachment-Unterstützung**

Das zentrale Datenmodell `PlatformMessage` (`src/adapters/base.ts`) enthält **nur** `content: string` — kein Feld für Dateien, Medien oder Binärdaten:

```ts
export interface PlatformMessage {
  id: string;
  platform: string;
  channelId: string;
  userId: string;
  content: string;        // ← der einzige Inhalt
  timestamp: number;
  metadata?: Record<string, unknown>;
}
```

Verhalten pro Adapter (eingehend):

| Plattform | Was verarbeitet wird | Was verworfen wird |
|---|---|---|
| Telegram | `msg.text \|\| msg.caption` | Photos, Dokumente, Audio/Voice, Video, Sticker, Standort, alles ohne Text → `if (!content) return;` |
| Discord | `data.content` | `data.attachments`, Embeds, Sticker |
| WhatsApp | `conversation`, `extendedTextMessage.text`, `imageMessage.caption` | Bilder **ohne** Caption, Dokumente, Voice, Video |
| Slack | (nicht verdrahtet, B5) | — |
| Twitch | nur Stream-Events | Chat-Attachments (Chat kommt gar nicht an) |

Verhalten (ausgehend):

| Plattform | Text | Medien |
|---|---|---|
| Telegram | `sendMessage` (HTML), `sendButtons` | `sendPhoto` existiert, ist aber **nur URL-basiert**, nicht Teil des Interfaces und nirgends im Kern aufgerufen. Kein `sendDocument`. |
| WhatsApp | `sendMessage` (mit Truncation) | `sendImage` (URL-basiert), `sendReaction`, `reply` — ebenfalls nicht im Kern genutzt |
| Discord | `sendMessage`/`editMessage` | kein Media-Senden |
| Slack | Webhook/Web-API | `postMessage` mit Blocks, aber kein File-Upload |

**Es existiert nirgends:** Download-Logik (kein `getFile`, kein Fetch von Attachment-URLs), temporärer Medien-Speicher, MIME-/Größen-Handling, oder ein Weg, eine Datei an den Agent zu übergeben. Der pi-RPC-Prompt ist zudem rein textuell (`{type:"prompt", message: string}`) — selbst wenn ein Adapter eine Datei hätte, gäbe es keinen Transportkanal.

### 3.2 Konsequenz

Ein User, der dem Bot auf Telegram/Discord/WhatsApp eine Datei schickt, erhält **keine Reaktion** (die Nachricht wird stumm verworfen). Das ist die aktuell wichtigste funktionale Lücke des Gateways.

### 3.3 Ausbaustufe (Design-Skizze)

Das Adapter-Pattern macht den Ausbau überschaubar — empfohlen in 3 Schichten:

```
┌──────────────┐   ┌─────────────────────┐   ┌──────────────────────────────┐
│ Adapter-Layer│   │ Media-Layer (neue)  │   │ Prompt-Materialisierung      │
│              │   │ src/media/store.ts  │   │                              │
│ extract +    │──►│ • download()        │──►│ content +=                   │
│ download     │   │ • Speicher unter    │   │ "[Attachment: /path/file.pdf]"│
│ (pro Platf.) │   │ ~/.pi/gateway/media │   │ (+ pi-Read-Tool kann die     │
└──────────────┘   │ • Größen-/MIME-Caps │   │  Datei dann selbst lesen)    │
                   └─────────────────────┘   └──────────────────────────────┘
```

1. **`PlatformMessage` erweitern:** `attachments?: Array<{ type: "image"|"document"|"audio"|"video"; fileName?: string; mimeType?: string; sizeBytes?: number; localPath?: string }>` — backward-kompatibel (optional).
2. **Neues Modul `src/media/`:** zentrale Download-/Speicher-Logik (Puffer → `~/.pi/gateway/media/<platform>/<chatId>/<msgId>-<name>`, Größen-Limit z. B. 50 MB, MIME-Whitelist, TTL-Cleanup im bestehenden Cron). Pro Adapter nur die Extraktion:
   - **Telegram:** `document`/`photo`/`voice` aus dem Update → `getFile` → `https://api.telegram.org/file/bot<token>/<file_path>` (einfachster Fall, Bot-Token genügt).
   - **Discord:** `data.attachments[].url` direkt per fetch (kein Auth nötig).
   - **WhatsApp:** Baileys `downloadMediaMessage()` (nutzt die bestehende Session).
3. **Prompt-Materialisierung:** Der Gateway hängt dem Prompt den lokalen Pfad an („Der Nutzer hat diese Datei angehängt: `/…/file.pdf` — lies sie mit deinem Read-Tool.“). Damit funktioniert es **ohne jede pi-RPC-Änderung**, weil pi ohnehin `read`/`bash` für Dateien hat. Optional später: eigener Tool-Call oder Binärkanal im RPC.
4. **Ausgehend (optional, Phase 2):** `sendFile(channelId, localPath)` in `BaseAdapter` + Telegram `sendDocument` (multipart), Discord `attachments[]` (multipart), WhatsApp `document`. Heute fehlt das komplett.

**Aufwandschätzung:** Phase 1 (eingehend, Text-Pfade + Telegram/Discord/WhatsApp) ≈ **2–4 Tage**; inkl. Ausgehend und Limits/Hardening ≈ **1 Woche**. Risiko: niedrig-mittel (isoliert im neuen Modul + Adapter-Patches); der zentrale Message-Pfad in `index.ts` bleibt fast unangetastet.

---

## 4. Frage 3: Telegram-Modus — Webhook vs. Long-Polling

### 4.1 Ist-Zustand: **Beide Modi existieren und sind abstrahiert**

`TelegramAdapter` (`src/adapters/telegram.ts`) kapselt beide Transportmodi vollständig; der Kern sieht in beiden Fällen nur `PlatformMessage`:

| Aspekt | Implementierung | Bewertung |
|---|---|---|
| **Modus-Auswahl** | Auto-Detection: `webhookUrl` gesetzt → Webhook, sonst Long-Polling (`initialize()` + `start()`) | ✅ Genau das gewünschte Verhalten; dokumentiert in README |
| **Long-Polling** | POST `/getUpdates` mit `timeout: 30` (Telegram hält die Verbindung), Offset-Tracking (`update_id + 1`), Backoff 1 s → 30 s bei Fehlern, `AbortSignal.timeout(35s)` | ✅ Solide. Korrektes Verständnis, dass Long-Polling **nicht** Intervall-Polling ist (Kommentar im Code) |
| **Update-Handling** | Fire-and-forget (`handleUpdate(...).catch(...)`) mit expliziter Begründung: Await würde den Poll-Loop blockieren, weil Prompts bis zu 5 min auf `agent_end` warten | ✅ Bewusste, dokumentierte Entscheidung (aber s. B4: ermöglicht parallele Prompts) |
| **Webhook** | `setWebhook` in `initialize()` (+ optionaler `secret_token`); HTTP-Route `POST /webhook/telegram` in `index.ts` → `handleWebhookUpdate()` | ⚠️ Funktioniert, aber mit Lücken (unten) |
| **Interaktive UI** | Inline-Keyboards (`ui:s:`/`ui:c:` Callback-Daten, 64-Byte-Limit beachtet), ForceReply für Inputs, `answerCallbackQuery`, Keyboard-Cleanup | ✅ Ausgereift, inkl. Legacy-Fallback-Format |

### 4.2 Antwort auf die Kernfrage

> **Ja — der Code ist so abstrahiert, dass eine Umstellung von Webhooks auf Long-Polling reine Konfiguration ist.** In `~/.pi/gateway/config.json` `platforms.telegram.webhookUrl` entfernen (oder leer lassen) → beim nächsten Start nutzt der Adapter automatisch `getUpdates`. Damit ist der Gateway **ohne öffentliche URL erreichbar** — genau das Ziel. Es gibt keinen Webhook-spezifischen Code im Kern: Die `/webhook/telegram`-Route ist ein dünner Forwarder an den Adapter, und alle übrigen Plattformen (Discord WS, WhatsApp Baileys, Twitch EventSub) arbeiten ohnehin ausgangsorientiert ohne eingehende öffentliche Endpunkte.

### 4.3 Offene Lücken (falls Webhook-Modus genutzt wird)

| # | Lücke | Detail |
|---|---|---|
| T1 | **Webhook-Secret-Verifikation ist ein Stubb:** `handleWebhookUpdate()` enthält `if (this.config.webhookSecret) { // Verify secret here }` — leer. | Jeder, der die URL kennt, kann gefälschte Updates POSTen (der Endpoint steht vor der Bearer-Auth). |
| T2 | **Keine Deduplizierung im Webhook-Modus:** Telegram liefert Updates ggf. mehrfach/verspätet; ohne `update_id`-Caching drohen Doppelantworten. Im Polling-Modus schützt das Offset davor. | mittel |
| T3 | `connected`-Flag wird beim Polling-Start gesetzt, aber nie an den echten Verbindungsstatus gekoppelt → `getStatus()` ist unzuverlässig. | Kosmetik/Debugging |
| T4 | Kein `deleteWebhook` bei Moduswechsel (alter Webhook bleibt auf Serverseite, wenn `webhookUrl` aus der Config entfernt wird). | Betriebs-Hygiene |

**Empfehlung:** Für den „ohne öffentliche URL“-Betrieb Long-Polling als Standard belassen und T1/T2 nachrüsten, falls doch Webhooks zum Einsatz kommen (HMAC-Check via `X-Telegram-Bot-Api-Secret-Token` + in-Memory `update_id`-LRU).

---

## 5. Frage 4: Nextcloud Talk Integration

### 5.1 Architektonische Passung

Das Gateway hat **exakt das Provider-Pattern**, das dafür gebraucht wird:

- Neuer Adapter = neue Datei `src/adapters/nextcloud-talk.ts` mit `extends BaseAdapter`, registriert in `initializeAdapters()` (`index.ts`) + Config-Block `platforms.nextcloudTalk` + Eintrag in der `Platform`-Union (dort auch B3 beheben).
- Security (Allowlist/Admins/Tool-Policy), Sessions, Streaming, Interactive-UI kommen **kostenlos** über den bestehenden `onMessage`-Pfad — solange der Adapter eingehende Events als `PlatformMessage` emittiert und `sendMessage(channelId, text)` implementiert.
- Einzige Kernänderung: die Adapter-Registry (~10 Zeilen). Alles andere ist Modul-intern.

### 5.2 Recherche: Nextcloud Talk API-Optionen (Stand 2026-08)

> **Versionshinweis:** In der Aufgabe war „v23/Hub 26“ genannt. Ich interpretiere das als *Nextcloud Server 23 bzw. 26* und/oder *Talk 23*. Die folgende Matrix deckt alle Fälle ab; bitte die tatsächliche Instanz-Version prüfen (`ocs/v2.php/cloud/status` oder Admin-Bereich).

| API | Verfügbar ab | Auth | Eingehend | Ausgehend | Öffentliche URL nötig? |
|---|---|---|---|---|---|
| **A. Talk Bot API** (`/ocs/v2.php/apps/spreed/api/v1/bot/{token}/…`) | **NC 27.1 / Talk 17.1** (Capability `bots-v1`) | Bot-Registerung via `occ talk:bot:install <name> <secret> <webhook-url>`; HMAC-SHA256-Signatur pro Request | **Push/Webhook**: ActivityStreams-2.0-JSON (`object.content` = Text, Anhängen als Rich-Objects), Reaktionen seit Talk 21 | `POST /bot/{token}/message` (≤ 32.000 Zeichen); Reaktions-Endpoints | **Ja** (Nextcloud muss den Gateway-Webhook erreichen) |
| **B. OCS Chat-API als User** (`/ocs/v2.php/apps/spreed/api/v1/chat/{roomToken}`) | NC 13+ (Chat-API), Long-Polling-Parameter `lookIntoFuture` seit NC ~20 | Basic Auth mit **App-Password** eines dedizierten NC-Users | **Long-Polling**: `GET /chat/{token}?lookIntoFuture=1&timeout=30&lastKnownMessageId=N` — Server hält die Request bis neue Messages oder Timeout (max 60 s); identisch zum Telegram-Muster des Gateways! | `POST /chat/{token}` (Message), `PUT` (Edit, 24 h Limit), `DELETE`, Reaktionen, **Dateien teilen** (`shareType=10` via files_sharing) | **Nein** — rein ausgangsorientiert |
| C. NC-App mit PHP-Events | je nach NC | App auf dem Server installieren | Events | — | Nein, aber **Server-Zugriff + PHP-App-Betrieb** nötig |

**Wichtige Detail-Fakten (Quelle: Nextcloud Talk API-Doku, Stand 2026-08):**

- Bot-API-Incoming-Payload ist ActivityStreams 2.0: `{"object":{"type":"Message","content":"text","actor":{...},"parameters":{"file":{...}}}}`. Text liegt in `object.content`; Anhängen als Rich-Objects unter `object.parameters` (z. B. `file` mit `id`, `name`, `size`, `link` — `link` ist ein Public-Share `/f/<id>`).
- **Bot-API kann keine Dateien herunterladen** (kein Bot-WebDAV; nur der öffentliche Share-Link, der ohne Auth erreichbar sein muss) und **keine Medien senden** — Drittanbieter (z. B. OpenClaw) lösen das mit Text-Zeilen „Attachment: <url>“. Für pi-gateway ist das unkritisch, solange Attachment-Handling (§3) den Pfad ans Read-Tool übergibt.
- OCS Chat-API liefert bei Long-Polling HTTP 200 mit `ocs-data.messages` (Array, aufsteigend) und `lastKnownMessageId`; bei Timeout ohne neue Messages: leeres Array. Message-Typen: `message`, `system`, `delete`, `reaction`; `actorType` unterscheidet `users`/`bots`/`guests` — **der eigene Bot-User muss gefiltert werden** (kein Echo), analog zum Telegram-`is_bot`-Check.
- Room-Auflösung: `GET /api/v1/room?roomID=<id>` bzw. Room-Token aus der Talk-URL (`…/call/<token>`); für 1:1-Chats mit dem dedizierten User reicht `GET /api/v1/room` (Liste) + Matching.

### 5.3 Entscheidungs-Matrix A vs. B

| Kriterium | A: Bot API | B: OCS User-Polling |
|---|---|---|
| Öffentliche URL für Gateway | **erforderlich** (Webhook) | nicht nötig ✅ |
| Instanz-Voraussetzung | NC ≥ 27.1 + `occ`-Zugriff zur Bot-Installation | NC ≥ 13, nur ein User-Account + App-Password ✅ |
| Identität | echter Bot (eigener Name/Avatar, `actorType=bots`) ✅ | gewöhnlicher User (sieht aus wie ein Kollege) |
| Echtzeitigkeit | Push (sofort) ✅ | Long-Polling ≤ 60 s Latenz (praktisch sofort, da Server hält) ✅ |
| Dateianhänge eingehend | Rich-Object-Metadaten + Share-Link (Parsing-Gaps in der Community bekannt) | Vollständiges Message-Objekt inkl. `messageType=51` (Datei) mit Share-Metadaten ✅ |
| Dateien senden | nicht nativ | via files_sharing `shareType=10` ✅ |
| HMAC-Signatur / Sicherheit | Signatur verifizierbar ✅ | TLS + App-Password (genug für Self-Hosting) |
| Betrieb/Setup-Aufwand | occ-Befehl + Webhook-Route + Signature-Check | nur Config (URL, User, App-Passwort, Room-Token) ✅ |
| Passung zum Gateway-Ziel „ohne öffentliche URL“ | ❌ | ✅ |

**Empfehlung:** **Option B als primärer Modus** (passt zum erklärten Ziel „ohne öffentliche URL“, kleinerer Footprint, bessere Datei-Metadaten), **Option A als optionaler zweiter Modus**, falls die Instanz NC ≥ 27.1 hat und eine Bot-Identität gewünscht ist — das Gateway kann beide in einem Adapter mit `mode: "polling" | "bot-webhook"` anbieten (exakt wie bei Telegram heute). Für „v23“ (NC 23) oder „Hub 26“ (falls = NC 26) kommt **nur Option B** infrage, da die Bot-API erst ab NC 27.1 existiert.

### 5.4 Konkreter Implementierungsplan (Option B)

```
Config: platforms.nextcloudTalk = {
  enabled, baseUrl (https://nc.example.com),
  username, appPassword,            // dedizierter NC-User + App-Password
  roomToken,                        // aus Talk-URL; alternativ roomId
  lookIntoFuture: true, pollTimeout: 30,
  maxMessageLength: 32000           // NC-Splitting wie bei Telegram/Discord
}

src/adapters/nextcloud-talk.ts (extends BaseAdapter):
  start():
    1. Room auflösen (Token → roomId, Teilnehmer-Liste für Allowlist-Mapping)
    2. Poll-Loop: GET /chat/{token}?lookIntoFuture=1&timeout=30
       &lastKnownMessageId=<maxId>   (Basic Auth, AbortSignal.timeout(35s))
    3. Neue Messages filtern: actorType=="users" && actorId != ownUser
       → PlatformMessage{ channelId: roomToken, userId: actorDisplayName/actorId,
          content: message (messageType 1=Text; 51=Datei → Metadaten-Zeile),
          metadata: { messageId, messageType } }
    4. Backoff wie Telegram (1s→30s) bei Fehlern; Reconnect-Loop
  sendMessage(): POST /chat/{token} { message, actorDisplayName? } (200 → messageId)
  editMessage(): PUT /chat/{token}/{messageId} (24-h-Limit beachten → sonst delete+send)
  setTyping(): kein NC-Äquivalent → No-Op (Gateway muss damit leben; Telegram hat es auch nur als Bonus)
  sendInteractive(): Option B: nicht verfügbar → Fallback auf plain-text Prompt
                     (BaseAdapter liefert generischen Fallback — siehe base.ts); 
                     Option A: ebenfalls nicht nativ → gleicher Fallback
```

**Aufwandschätzung:**

| Teil | Aufwand |
|---|---|
| Adapter Option B (Polling + Senden + Edit) | **1–2 Tage** |
| Config-Plumbing + Registry + Platform-Union + README | 0,5 Tag |
| Dateianhänge eingehend (messageType 51 → Metadaten/Pfad, vgl. §3) | 0,5–1 Tag |
| Option A (Bot-API: Webhook-Route, HMAC-Verifikation, ActivityStreams-Parsing, `POST /bot/{token}/message`) | **1–2 Tage** |
| Tests (Poll-Loop mit Mock-Server, Payload-Parsing) | 0,5–1 Tag |
| **Gesamt (B + A)** | **~4–7 Tage**, Risiko niedrig-mittel |

**Risiken:** (1) NC-Version der Zielinstanz unbekannt → zuerst `ocs/v2.php/cloud/status` prüfen; (2) Long-Polling-Timeout verhält sich je nach Reverse-Proxy (Proxy muss ≥ 60 s halten, sonst kurzer Intervall-Fallback); (3) Room-Token in Logs/Config unverschlüsselt (wie alle anderen Tokens im Gateway — bestehendes Muster, aber für NC mit Account-Zugleich relevant);

---

## 6. Empfehlungen & Nächste Schritte (Action Items)

| Priorität | Action | Aufwand |
|---|---|---|
| P0 | **Telegram auf Long-Polling umstellen** (Config: `webhookUrl` entfernen) — Ziel „ohne öffentliche URL“ sofort erreicht, kein Code | Minuten |
| P0 | **Nextcloud-Talk-Adapter (Option B)** nach §5.4 implementieren | 1–2 Tage |
| P1 | **File-Attachments Phase 1** nach §3.3 (Telegram + Discord + WhatsApp eingehend) | 2–4 Tage |
| P1 | **B4 fixen:** Completion-Korrelation (Prompt-ID statt FIFO-Queue) — Voraussetzung für parallele Chats, auch NC-Talk mit mehreren Rooms | 0,5–1 Tag |
| P2 | B1: `checkRateLimit` im Message-Pfad aufrufen (oder Feature aus README streichen) | 0,5 h |
| P2 | T1/T2: Webhook-Secret-Verifikation + Deduplizierung nachrüsten | 0,5 Tag |
| P2 | B3: `Platform`-Union bereinigen (twitch ergänzen, nicht-existierende entfernen) | 0,5 h |
| P2 | `strict: true` schrittweise aktivieren (pro Modul), Linter/Formatter einführen | 1–2 Tage |
| P3 | B7 konzeptionell klären: echte Session-Isolation (Session-ID in RPC übergeben / pro-Chat-RPC-Prozess) oder README korrigieren | Design-Entscheidung |
| P3 | Test-Framework (z. B. vitest) + Coverage für Security/Sessions/Adapter-Parsing | 2–3 Tage |

---

## Quellen

**Code (lokal, gelesen am 2026-08-18):** alle Dateien unter `~/pi-gateway/src/`, `tests/index.ts`, `package.json`, `tsconfig.json`, `README.md`, `config/config.default.json`.

**Nextcloud Talk API (web, Stand 2026-08):**

1. Nextcloud Talk *Bot API* Doku — Endpunkte `/ocs/v2.php/apps/spreed/api/v1/bot/{token}/message`, Reactions; Capability `bots-v1` ab NC 27.1/Talk 17.1; Bot-Installation via `occ talk:bot:install <name> <secret> <webhook-url>`; HMAC-SHA256-Signatur; ActivityStreams-2.0-Incoming-Payload. (nextcloud.com/talk bot API Doku, abgerufen 2026-08-18)
2. Nextcloud Talk *Chat API* (OCS) Doku — `GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}` mit `lookIntoFuture=1`, `timeout` (default 30 s, max 60 s), `lastKnownMessageId`; `POST`/`PUT`/`DELETE` am selben Endpunkt; Basic Auth. (nextcloud.com/talk chat API Doku, abgerufen 2026-08-18)
3. Nextcloud Talk Changelog — Talk 23 (NC 33, Feb 2026): Bugfix Attachment-Dateiname in Bot-API-Payload; Talk 25 (NC 35). Bestätigt Versionsmatrix und dass die Bot-API erst spät eingeführt wurde. (nextcloud.com/talk changelog, abgerufen 2026-08-18)
4. OpenClaw Nextcloud-Talk-Anbindung (Community-Referenz) — bestätigt: Bot-API kann keine Dateien senden; eingehende Anhängen als Rich-Objects mit Parsing-Gaps; übliche Lösung = Text-Zeile mit Share-URL. (openclaw issue/discussion, abgerufen 2026-08-18)

**Annahmen & Einschränkungen:**

- „v23/Hub 26“ wurde als NC-Server-Version interpretiert; die tatsächliche Instanz-Version ist unbekannt und bestimmt, ob Option A verfügbar ist (NC ≥ 27.1).
- Zeilenzahlen sind gerundete Approximationen aus dem Datei-Lesen.
- Der pi-RPC-Protokoll (peer `@earendil-works/pi-coding-agent`) wurde nicht separat verifiziert — die Aussagen zu B7 (Session-ID wird nicht übergeben) basieren ausschließlich auf dem Gateway-Code (`sendPromptRpc` sendet nur `{type:"prompt", message}`).

