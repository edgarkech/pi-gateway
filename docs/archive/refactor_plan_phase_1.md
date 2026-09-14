# pi-gateway — Refactoring-Plan Phase 1.1 (W1: Modularisierung der `index.ts`)

**Task:** architect-20260818-174347
**Datum:** 2026-08-18
**Basis:** Vollständige Analyse von `src/index.ts` (2578 Zeilen, 5 Chunk-Lesungen) + Bestandsmodule + `ROADMAP.md` (Phase 1, Item W1)
**Status:** Entwurf zur Freigabe

---

## 1. Ausgangslage

### 1.1 Projekt-Kontext

| Attribut | Wert |
|---|---|
| Paket | `@gamalan/pi-gateway` v1.10.1 |
| Sprache/Build | TypeScript (ES2022, ESM, `strict: false`) → `tsc` → `dist/` |
| Entry Points | ① Pi-Extension via Default-Export (`pi.extensions` → `dist/index.js`), ② Detached Daemon (`node dist/index.js --daemon`), ③ CLI (`dist/cli.js`, importiert nur `./status.js`) |
| Runtime-Konfiguration | `~/.pi/gateway/config.json` (Seed: `config/config.default.json`) |
| Externe Abhängigkeiten | `ws`, `better-sqlite3`; Peer: `@earendil-works/pi-coding-agent`, `@sinclair/typebox` |

**Wichtig für die Refactoring-Sicherheit:** Kein externer Code importiert Interna von `index.ts`. Die einzigen öffentlichen Oberflächen sind der Default-Export (Pi-Extension) und der Daemon-Bootstrap. Interne Funktionen können frei verschoben werden, ohne dass Import-Pfade anderer Dateien brechen.

### 1.2 Bestehende Modulstruktur (bereits modularisiert)

```
src/
├── index.ts                  ← MONOLITH (2578 Zeilen) — Refactoring-Ziel
├── cli.ts                    ← standalone CLI (nur status.js)
├── logger.ts                 ← Logging
├── paths.ts                  ← GATEWAY_CONFIG_DIR/FILE, getPackageRoot()
├── status.ts                 ← Health-Check, PID-File-Helfer, Status-Reports
├── interactive.ts            ← UI-Bridge (extension_ui_request ↔ Adapter), Callback-Injection
├── sessions/store.ts         ← SQLite-Session-Store (initSessionStore, getOrCreateSession, …)
├── security/auth.ts          ← Allowlist, Pairing, Admins (SQLite + Config)
├── security/tool-policy.ts   ← Tool-Policies (buildPolicyGuard, …)
├── background/manager.ts     ← Background Tasks
└── adapters/                 ← base.ts + discord/twitch/telegram/slack/whatsapp
```

### 1.3 Strukturanalyse `src/index.ts` (komplette Inventur)

Zeilenangaben sind Näherungen aus der Vollanalyse (`~`).

#### A. Typen & Interfaces

| Symbol | Zeilen (~) | Art |
|---|---|---|
| `GatewayConfig` | 98–160 | Interface — komplettes Config-Schema (port, host, tokens, cors, security, sessions, platforms ×5) |
| `GatewayState` | 162–167 | Interface — running, adapters/clients/sessions Maps |
| `PendingRequest` | 247–253 | Interface — RPC-Request (id, resolve, reject) |
| `PendingCompletion` | 255–263 | Interface — Prompt-Completion (resolve, reject, timer, onStream, streamedText) |

#### B. Konstanten & globaler State (Modul-Ebene)

| Symbol | Zeilen (~) | Wert/Typ |
|---|---|---|
| `DEFAULT_CONFIG` | 169–195 | const — Defaults (Port 3847, allowAll, idle 1440 min, promptTimeoutMs 300000) |
| `config` | 197 | let `GatewayConfig` — wird bei Start/Reload neu zugewiesen |
| `state` | 198 | let `GatewayState` |
| `server` | 199 | let `http.Server \| null` |
| `wss` | 200 | let `WebSocketServer \| null` |
| `rpcProcess` | 201 | let `ChildProcess \| null` |
| `globalCtx` | 202 | let `ExtensionContext \| null` (Pi-UI-Kontext) |
| `cronInterval` | 203 | let `Timeout \| null` |
| `statusRefreshInterval` | 204 | let `Timeout \| null` |
| `lastGatewayStatusText` | 205 | let `string \| null` |
| `statusUpdateGeneration` | 206 | let `number` (Stale-Update-Guard) |
| `lastDetachedHealthConfig` | 207 | let `GatewayConfig \| null` |
| `configReloadQueue` | 208 | let `Promise<void>` (serialisierte Reloads) |
| `daemonShuttingDown` | 209 | let `boolean` |
| `STATUS_REFRESH_INTERVAL_MS` | 217 | const = 2000 |
| `PID_FILE` | 220 | const — `~/.pi/gateway/gateway.pid` |
| `pendingRequests` | 253 | const `PendingRequest[]` (FIFO-Array) |
| `pendingCompletions` | 263 | const `PendingCompletion[]` (FIFO-Array) |
| `adapterCallbacks` | 632–1078 | const `AdapterCallbacks` — **größter Block der Datei** |
| `IS_DAEMON` | 2407 | const — `process.argv.includes("--daemon")` |

#### C. Funktionen (in Reihenfolge des Auftretens)

| # | Funktion | Zeilen (~) | Zeilen | Verantwortung |
|---|---|---|---|---|
| 1 | `readDaemonPid()` | 222–245 | 24 | PID-File lesen + Liveness-Check (signal 0) |
| 2 | `mergeGatewayConfig()` | 266–325 | 60 | Config validieren/mergen (health, security, sessions, resetPolicy) |
| 3 | `loadConfig()` | 327–352 | 26 | Config laden, Default-Seed kopieren |
| 4 | `verifyToken()` / `authenticate()` | 354–368 | 15 | Bearer-Token-Auth (HTTP/WS) |
| 5 | `sendWs()` / `broadcastClients()` | 370–380 | 11 | WS-Helfer |
| 6 | `createRpcProcess()` | 382–525 | 144 | `pi --mode rpc` spawnen; stdout-Line-Parser: RPC-Antworten matchen, `agent_end` → Completion, `extension_ui_request` → Interactive-Bridge, `text_delta` → Streaming, Broadcast; Exit-Handler (Buffer-Flush, Rejects) |
| 7 | `sendRpc()` | 527–555 | 29 | Request/Response mit ID + 30 s Timeout |
| 8 | `extractAgentEndText()` | 557–577 | 21 | Assistant-Text aus `agent_end.messages` extrahieren |
| 9 | `sendPromptRpc()` | 579–630 | 52 | Prompt senden → ACK warten → `agent_end` mit Timeout + Streaming-Callback |
| 10 | `adapterCallbacks.onMessage` | 634–1075 | ~440 | **Message-Pipeline:** Session get/create, Allowlist-Check, `/model` (list/switch/inline-callback), `/restart`, Prompt-Flow (Typing-Heartbeat, Placeholder, 400-ms-Edit-Throttle, Flush/Stream-Redirect-Handler, preText-Strip, Error-Handling) |
| 11 | `adapterCallbacks.onInteractiveResponse` / `.onDisconnect` | 1075–1078 | 4 | Delegation an interactive.ts bzw. `updateStatus()` |
| 12 | `initializeAdapters()` | 1080–1174 | 95 | 5 Adapter aus Config instantiieren + starten |
| 13 | `startCron()` / `stopCron()` | 1176–1210 | 35 | 60-s-Loop: Background-Ergebnisse liefern, Sessions touchen |
| 14 | `handleHttpRequest()` | 1212–1305 | 94 | CORS, Telegram-Webhook (unauthentifiziert!), Auth, `/api/{status,sessions,background,allowlist,pairing}` |
| 15 | `handleWebSocket()` | 1307–1365 | 59 | WS-Auth, Client-Registry, Message-Typen prompt/background/ping |
| 16 | `updateStatus()` | 1367–1388 | 22 | Pi-Footer-Status via `ctx.ui.setStatus` mit Generation-Guard |
| 17 | `readDetachedHealthConfig()` | 1390–1405 | 16 | Health-Config für Detached-Probe (mit Fallback auf letzte valide Config) |
| 18 | `getDetachedGatewayHealth()` | 1407–1409 | 3 | `fetchGatewayHealth(readDetachedHealthConfig(), pid)` |
| 19 | `export default function (pi)` | 1410–2343 | ~930 | **Extension-Entry:** Init + Stores, `registerCommand("gateway")` (~625 Zeilen: start/stop/restart/status/pair/allow/revoke/admin/sessions/tasks/config/tool-policy/help), 5× `registerTool` (~270 Zeilen: gateway_status/sessions/background_tasks/pairing/tool_policy), `pi.on(session_start/shutdown)` (Footer-Refresh) |
| 20 | `reloadDaemonConfig()` | 2348–2385 | 38 | Config-Reload mit Listener-Rollback (host/port changed → stop/start, Fehlschlag → alte Config + Datei-Restore) |
| 21 | `startConfigWatcher()` | 2387–2405 | 19 | `watchFile` + serialisierte Reload-Queue |
| 22 | Daemon-Dispatch | 2407–2411 | 5 | `if (IS_DAEMON) detachAndRun()` (Top-Level) |
| 23 | `detachAndRun()` | 2413–2490 | 78 | Daemon-Bootstrap: PID-File akquirieren, Shutdown-Handler (SIGTERM/SIGINT/uncaughtException), SIGHUP-Reload, Start, Config-Watcher |
| 24 | `startGatewayServer()` | 2492–2517 | 26 | HTTP + WSS + RPC + Adapter + Cron starten |
| 25 | `stopGatewayServer()` | 2519–2578 | 60 | Shutdown-Nachrichten an Kanäle (direkter DB-Query!), Adapter/WS/Server/RPC stoppen |

#### D. Funktionsflächen-Budget (Zusammenfassung)

| Fläche | Zeilen (~) | Anteil |
|---|---|---|
| Message-Pipeline (`adapterCallbacks`) | 447 | 17 % |
| Extension-Entry (Command + Tools + Hooks) | 930 | 36 % |
| RPC-Layer | 247 | 10 % |
| Daemon-Modus (reload/watcher/detach/dispatch) | 130 | 5 % |
| Server-Lifecycle + HTTP/WS/Cron | 215 | 8 % |
| Config (Types, Defaults, merge, load, health-config) | 125 | 5 % |
| Globaler State + Konstanten | 45 | 2 % |
| Status-Footer | 25 | 1 % |
| Adapter-Init | 95 | 4 % |
| Imports/Header | 96 | 4 % |

### 1.4 Koppelungs-Hotspots (Analyse-Ergebnis)

1. **Globaler mutabler State** (`config`, `state`, `server`, `wss`, `rpcProcess`, Intervals, Flags) wird von allen Flächen gelesen/geschrieben — heute als Modul-Globals, das ist der Hauptgrund für die Monolith-Struktur.
2. **`pendingCompletions[0]` wird direkt aus der Message-Pipeline gegriffen** (Flush-Handler liest `streamedText`, Stream-Redirect setzt ihn auf `""`). RPC-interne Struktur wird von außen manipuliert.
3. **RPC ↔ Interactive-Bridge:** `createRpcProcess()` injiziert den Stdin-Writer in `interactive.ts` und ruft deren Handler aus dem stdout-Parser (Pattern existiert bereits, soll standardisiert werden).
4. **RPC → WS-Broadcast:** stdout-Parser broadcastet `response`/`event`/`agent_disconnected` direkt an `broadcastClients()`.
5. **`stopGatewayServer()` queryt die Session-DB direkt** (`initSessionStore().prepare("SELECT DISTINCT platform, channel_id …")`) — Store-Logik im Server-Code.
6. **Zwei Bootstrap-Pfade** (inline Extension + Daemon) duplizieren Initialisierung (`loadConfig`, State-Fresh-Maps, `init*Store()` ×3).
7. **`IS_DAEMON`** wird an drei entfernten Stellen referenziert (onMessage `/restart`, HTTP `/api/status`, Top-Level-Dispatch).
8. **Duplikat in `cli.ts`:** eigene Kopie der PID-Logik (`isRunning`) und des Health-Config-Loadings — Follow-up, nicht W1.

---

## 2. Ziele & Constraints

### 2.1 Ziele (W1)

- `src/index.ts` auf **< ~100 Zeilen** reduzieren (nur noch Entry-Point + Daemon-Dispatch).
- Monolith in die in der Roadmap skizzierten Module aufbrechen: `src/core/server.ts`, `src/core/rpc.ts`, `src/core/commands.ts`, `src/core/daemon.ts` — ergänzt um weitere, aus der Analyse abgeleitete Module (s. §3).
- **Verhaltensneutral:** Keine Logikänderungen, keine Bugfixes, keine Typverbesserungen (das ist Phase 2: B1–B8, W2–W6).
- **Stabilität während des Refactorings:** Nach jedem Schritt muss `npm run build` fehlerfrei durchlaufen und der Gateway funktionsfähig sein (Smoke-Test).

### 2.2 Constraints & Annahmen

- **C1:** `strict: false` bleibt (W2 ist Phase 2). Neue Module dürfen also im bestehenden Typ-Stil geschrieben werden.
- **C2:** Der Daemon spawnt `dist/index.js --daemon` → Build-Artefakt bleibt unverändert in Struktur und Entry-Point.
- **C3:** Pi lädt `dist/index.js` als Extension → Default-Export-Signatur `default (pi: ExtensionAPI)` bleibt identisch.
- **A1 (Annahme):** Es läuft maximal ein Gateway (inline ODER Daemon) — wie heute; keine Multi-Instance-Erfordernisse.
- **A2 (Annahme):** FIFO-Semantik von `pendingCompletions` bleibt in W1 unverändert. Roadmap **B4** (FIFO → `Map<sessionId, …>`) und **B7** (sessionId im RPC) werden dadurch *vorbereitet*, aber nicht implementiert: Sie sind danach Änderungen innerhalb eines einzigen Moduls (`core/rpc.ts`), nicht wieder quer durch die Codebase.
- **A3 (Annahme):** `interactive.ts` bleibt unverändert (seine Callback-Injection ist das Vorbild für das neue Hook-Pattern).

---

## 3. Ziel-Architektur

### 3.1 Neue Verzeichnisstruktur

```
src/
├── index.ts                    # NEU: dünner Entry-Point (~80 Zeilen)
│                               #   Default-Export + Daemon-Dispatch + Store-Init
├── cli.ts                      # unverändert (Follow-up: PID-Duplikat, Phase 2)
├── types.ts                    # NEU: GatewayConfig, GatewayState, geteilte Typen
├── config.ts                   # NEU: DEFAULT_CONFIG, mergeGatewayConfig, loadConfig,
│                               #   readDetachedHealthConfig, getDetachedGatewayHealth
├── state.ts                    # NEU: GatewayRuntime-Container (zentraler Shared State)
├── logger.ts                   # unverändert
├── paths.ts                    # unverändert
├── interactive.ts              # unverändert
├── status.ts                   # unverändert
├── sessions/
│   └── store.ts                # + NEUE Funktion: listActiveChannels() (aus stopGatewayServer)
├── security/
│   ├── auth.ts                 # unverändert
│   └── tool-policy.ts          # unverändert
├── background/
│   └── manager.ts              # unverändert
├── adapters/
│   ├── base.ts                 # unverändert
│   ├── registry.ts             # NEU: initializeAdapters() (Adapter-Registry — Phase-4-tauglich)
│   └── discord/twitch/telegram/slack/whatsapp.ts   # unverändert
└── core/
    ├── server.ts               # NEU: HTTP+WS-Server, start/stopGatewayServer, Cron,
    │                           #   broadcast/sendWs, verifyToken/authenticate
    ├── rpc.ts                  # NEU: pi-RPC-Prozess, sendRpc/sendPromptRpc,
    │                           #   pendingRequests/pendingCompletions (kapselt FIFO),
    │                           #   startRpc/stopRpc/restartRpc/isAgentRunning,
    │                           #   peekActiveCompletion/resetActiveStream
    ├── message-pipeline.ts     # NEU: adapterCallbacks (onMessage: Security, /model,
    │                           #   /restart, Streaming-Flow; onInteractiveResponse; onDisconnect)
    ├── commands.ts             # NEU: registerGatewayCommand(pi) — alle /gateway-Subcommands
    ├── tools.ts                # NEU: registerGatewayTools(pi) — die 5 Pi-Tools
    ├── status-footer.ts        # NEU: updateStatus + registerStatusFooter(pi)
    │                           #   (session_start/shutdown-Hooks, Refresh-Interval)
    └── daemon.ts               # NEU: PID_FILE, readDaemonPid, isDaemonMode,
                                #   reloadDaemonConfig, startConfigWatcher, detachAndRun,
                                #   spawnDetachedDaemon, bootstrapIfDaemon
```

### 3.2 Modul-Verantwortlichkeiten (Ziel-Zeilenbudget)

| Modul | Verantwortlichkeit | Ziel-Zeilen (~) |
|---|---|---|
| `index.ts` | Default-Export: `initRuntime()`, Store-Init, `registerGatewayCommand/Tools/Footer(pi)`, `bootstrapIfDaemon()` | 80 |
| `types.ts` | `GatewayConfig`, `GatewayState` (wörtlich verschoben) | 75 |
| `config.ts` | Config-Defaults, Merge/Validierung, Laden, Detached-Health-Config + Health-Probe | 130 |
| `state.ts` | `GatewayRuntime`-Interface + Singleton + `initRuntime()` | 70 |
| `core/rpc.ts` | RPC-Prozess-Lifecycle, Request/Response, Prompt-Completions (FIFO), Streaming-Peek/Reset | 280 |
| `core/message-pipeline.ts` | `adapterCallbacks` (wörtlich verschoben, State-Zugriffe umgeschrieben) | 460 |
| `core/server.ts` | Server-Lifecycle, HTTP-Handler, WS-Handler, Cron, Broadcast, Token-Auth | 280 |
| `core/commands.ts` | `/gateway`-Command (alle Subcommands, wörtlich verschoben) | 650 |
| `core/tools.ts` | 5× `registerTool` (wörtlich verschoben) | 290 |
| `core/status-footer.ts` | Footer-Status + Pi-Session-Hooks | 70 |
| `core/daemon.ts` | Daemon-Bootstrap, PID, Config-Watcher/Reload, Detached-Spawn | 200 |
| `adapters/registry.ts` | `initializeAdapters()` (wörtlich verschoben) | 100 |
| `sessions/store.ts` (+) | `listActiveChannels()` neu | +15 |

### 3.3 Shared-State-Design (Kernentscheidung)

**Problem:** 13+ Modul-Globals werden heute quer durch alle Flächen geteilt. Beim Aufteilen in Module entsteht die Frage, wie der State weiter geteilt wird.

**Entscheidungs-Matrix:**

| Option | Beschreibung | Pro | Contra | Entscheidung |
|---|---|---|---|---|
| **A: Modul-Globals pro Datei** | Jedes Modul hält eigene `let`-Variablen, andere importieren Getter/Setter | Keine Strukturänderung | 13+ Getter/Setter-Paare; Mutationen schwer nachvollziehbar; gleiche Fragilität wie heute | ❌ |
| **B: Runtime-Container (Singleton-Objekt)** | Ein `runtime`-Objekt in `state.ts`; alle Module importieren es und greifen auf Felder zu | 1:1-Verhalten zu heute (alle lesen/schreiben dasselbe Objekt); zentrale Übersicht; kein Import-Zykel-Risiko; trivial zu testen (Reset) | Mutation bleibt möglich (wie heute) — per Review-Regel begrenzen | ✅ **gewählt** |
| **C: Gateway-Klasse** | Alles in einer Klasse kapseln, Instanz wird herumgereicht | Maximale Kapselung | Stilbruch (Codebase ist funktional); größter Refactoring-Aufwand; höchstes Verhaltensrisiko in W1 | ❌ (Kandidat für spätere Phase) |

**Implementierung (Option B):**

```ts
// src/state.ts
import type { GatewayConfig, GatewayState } from "./types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import type { WebSocketServer } from "ws";

/** Hooks, die zur Laufzeit von anderen Modulen gesetzt werden (vermeidet Import-Zyklen). */
export interface GatewayHooks {
  /** Gesetzt von core/server.ts beim Start — wird vom RPC-Layer für Broadcasts genutzt. */
  broadcast?: (event: string, data: unknown) => void;
}

export interface GatewayRuntime {
  config: GatewayConfig;
  state: GatewayState;
  server: Server | null;
  wss: WebSocketServer | null;
  rpcProcess: ChildProcess | null;
  globalCtx: ExtensionContext | null;
  cronInterval: ReturnType<typeof setInterval> | null;
  statusRefreshInterval: ReturnType<typeof setInterval> | null;
  lastGatewayStatusText: string | null;
  statusUpdateGeneration: number;
  lastDetachedHealthConfig: GatewayConfig | null;
  configReloadQueue: Promise<void>;
  daemonShuttingDown: boolean;
  hooks: GatewayHooks;
}

export const runtime: GatewayRuntime = { /* alle Felder initial null/leer */ };

/** Initialisiert Config + frische State-Maps (ersetzt die heutige Inline-Init in
 *  default-export und detachAndRun — beseitigt Duplikat #6 aus §1.4). */
export function initRuntime(): void { /* config = loadConfig(); state = fresh; … */ }
```

**Regel für das Review:** Nach W1 darf es **keine neuen modul-ebenen mutablen Globals** geben (Ausnahme: `runtime` in `state.ts`, `IS_DAEMON`/`PID_FILE` als `const` in `daemon.ts`). Alles Mutable wandert in `runtime`.

### 3.4 Kommunikationsmodell & Abhängigkeitsgraph

**Prinzipien:**
1. **Datenfluss über den `runtime`-Container** (Shared State) — keine neuen Globalen.
2. **Funktionen werden importiert, nie re-exported durch `index.ts`** (nichts externes hängt daran).
3. **Hook-Injection für Rückwärtskanten** (wie bereits in `interactive.ts`): Der RPC-Layer darf nicht den Server importieren (Server importiert RPC) → Broadcast kommt als `runtime.hooks.broadcast`.
4. **Kein Import-Zykel** (verifizierter Graph, s. unten).

```
                        ┌────────────────────────────────────────────┐
                        │                index.ts                    │
                        │  (Default-Export + bootstrapIfDaemon)      │
                        └───┬──────────┬──────────┬──────────┬───────┘
                            │          │          │          │
              ┌─────────────▼──┐   ┌───▼────────┐ │   ┌──────▼──────────────┐
              │ core/daemon.ts │   │core/commands│ │   │ core/status-footer  │
              │ PID, detach,   │   │    .ts      │ │   │ updateStatus, pi.on │
              │ watcher/reload │   └───┬──────┬──┘ │   └──────┬──────────────┘
              └───────┬────────┘       │      │    │          │
                      │                │      │    │          │
        ┌─────────────▼────────────────▼──────▼────▼──────────▼──────────┐
        │                        core/server.ts                          │
        │ start/stopGatewayServer, HTTP, WS, Cron, broadcast (setzt      │
        │ runtime.hooks.broadcast), verifyToken/authenticate             │
        └───────┬───────────────────────────────┬────────────────────────┘
                │                               │
   ┌────────────▼────────────┐     ┌────────────▼──────────────┐
   │ core/rpc.ts             │     │ adapters/registry.ts      │
   │ startRpc/stopRpc/       │     │ initializeAdapters()      │
   │ sendRpc/sendPromptRpc,  │     └────────────┬──────────────┘
   │ pending* (FIFO-kapselt) │                  │
   └────────────┬────────────┘     ┌────────────▼──────────────┐
                │                  │ core/message-pipeline.ts  │
                │                  │ adapterCallbacks          │
                │◄─────────────────┤ (sendPromptRpc, peek/     │
                │                  │  resetActiveStream, …)    │
                │                  └────────────┬──────────────┘
                │                               │
   ┌────────────▼────────────┐     ┌────────────▼──────────────┐
   │ interactive.ts (best.)  │     │ security/*, sessions/     │
   └─────────────────────────┘     │ store, background/manager │
                                   └───────────────────────────┘

   Querschneidende (zykel-freie) Module:
   types.ts ◄── config.ts ◄── state.ts   (status.ts, paths.ts, logger.ts wie heute)
```

**Zykel-Check (kritischste Kette):** `server → registry → message-pipeline → status-footer → config` und `daemon → server` — **kein Zykel**. Entscheidend dafür: `getDetachedGatewayHealth()` wandert nach `config.ts` (nicht `daemon.ts`), sonst würde `status-footer → daemon → server → … → status-footer` einen Zykel erzeugen.

**Import-Regeln je Modul:**

| Modul | Darf importieren (aus core/) | Darf NICHT importieren |
|---|---|---|
| `core/rpc.ts` | — (nutzt `interactive.ts`, `runtime.hooks.broadcast`) | server, registry, message-pipeline, daemon, commands, tools, status-footer |
| `core/message-pipeline.ts` | rpc, status-footer | server, daemon, commands, tools |
| `adapters/registry.ts` | message-pipeline | server, daemon, commands, tools |
| `core/server.ts` | rpc, registry, status-footer(nicht nötig), stores | daemon, commands, tools |
| `core/daemon.ts` | server, config | commands, tools, status-footer |
| `core/commands.ts` | server, daemon, config | — (außer state/types/status/stores) |
| `core/tools.ts` | daemon (nur `readDaemonPid`) | server, commands |
| `core/status-footer.ts` | config (`getDetachedGatewayHealth`) | daemon, server |

### 3.5 Neue API-Oberflächen (Kernstücke)

```ts
// src/core/rpc.ts — kapselt den heutigen FIFO-State (Vorbereitung für B4/B7)
export function startRpc(): ChildProcess;        // = heutige createRpcProcess()
export function stopRpc(): void;                 // kill + rpcProcess = null
export function restartRpc(): void;              // kill, pending rejecten, neu spawnen (= /restart-Logik)
export function isAgentRunning(): boolean;       // rpcProcess !== null
export function sendRpc(command: string, data?: Record<string, unknown>): Promise<unknown>;
export function sendPromptRpc(message: string, onStream?: (text: string) => void): Promise<string>;
export function peekActiveCompletion(): { streamedText: string } | null;  // ersetzt pendingCompletions[0]
export function resetActiveStream(): void;       // setzt streamedText des aktiven Complements auf ""
// intern (nicht exportiert): pendingRequests, pendingCompletions, extractAgentEndText

// src/core/daemon.ts
export const isDaemonMode: boolean;              // = IS_DAEMON
export function readDaemonPid(): number | null;
export function spawnDetachedDaemon(): { pid?: number } | null;  // für /gateway start -d + CLI-Follow-up
export function bootstrapIfDaemon(): void;       // Top-Level-Dispatch (ersetzt if (IS_DAEMON) …)

// src/sessions/store.ts (Zusatz)
export function listActiveChannels(): Array<{ platform: string; channelId: string }>;
// = heutiger direkter SQL-Query in stopGatewayServer()
```

---

## 4. Mapping — Symbol → Zielmodul

Legende: **V** = wörtlich verschieben (nur Importe/State-Zugriffe anpassen), **U** = umbauen (begründet), **N** = neu schreiben.

| Symbol (heute in `index.ts`) | Ziel | Art | Anmerkung |
|---|---|---|---|
| `interface GatewayConfig` | `types.ts` | V | |
| `interface GatewayState` | `types.ts` | V | |
| `DEFAULT_CONFIG` | `config.ts` | V | |
| `mergeGatewayConfig()` | `config.ts` | V | nutzt `normalizeGatewayHealthConfig` (status.ts) |
| `loadConfig()` | `config.ts` | V | nutzt paths.ts + logger |
| `readDetachedHealthConfig()` | `config.ts` | U | schreibt `runtime.lastDetachedHealthConfig` statt lokales `let` |
| `getDetachedGatewayHealth()` | `config.ts` | U | **bewusst nicht** in daemon.ts (Zykel-Vermeidung, §3.4) |
| `verifyToken()`, `authenticate()` | `core/server.ts` | V | nur von HTTP/WS genutzt |
| `sendWs()`, `broadcastClients()` | `core/server.ts` | U | `broadcastClients` wird zusätzlich als `runtime.hooks.broadcast` registriert |
| `PendingRequest`, `pendingRequests` | `core/rpc.ts` (privat) | V | |
| `PendingCompletion`, `pendingCompletions` | `core/rpc.ts` (privat) | U | FIFO bleibt; Zugriff von außen nur noch via `peekActiveCompletion()`/`resetActiveStream()` |
| `createRpcProcess()` | `core/rpc.ts` als `startRpc()` | U | Broadcast via `runtime.hooks.broadcast`; `setStdinWriter` wie heute an interactive.ts |
| `sendRpc()` | `core/rpc.ts` | V | |
| `extractAgentEndText()` | `core/rpc.ts` (privat) | V | |
| `sendPromptRpc()` | `core/rpc.ts` | U | liest `runtime.config.promptTimeoutMs` |
| — (neu) `stopRpc()`, `restartRpc()`, `isAgentRunning()` | `core/rpc.ts` | N | extrahiert aus `/restart`-Handler + `stopGatewayServer` (Logik 1:1 übernommen) |
| `adapterCallbacks` (gesamtes Objekt) | `core/message-pipeline.ts` | U | `pendingCompletions[0]` → rpc-API; `IS_DAEMON` → `isDaemonMode`; `config/state/rpcProcess` → `runtime.*`; `updateStatus`-Call → Import aus status-footer.ts |
| `initializeAdapters()` | `adapters/registry.ts` | V | importiert `adapterCallbacks` aus message-pipeline.ts |
| `startCron()`, `stopCron()` | `core/server.ts` | U | Lifecycle-Teil des Servers; nutzt background/manager + sessions/store |
| `handleHttpRequest()` | `core/server.ts` | V | Telegram-Webhook-Cast (`as any`) bleibt (Phase 2) |
| `handleWebSocket()` | `core/server.ts` | U | `sendRpc` via Import aus rpc.ts |
| `updateStatus()` | `core/status-footer.ts` | U | `globalCtx`/Generation/lastText → `runtime.*`; Health-Probe via config.ts |
| `STATUS_REFRESH_INTERVAL_MS` | `core/status-footer.ts` (lokal) | V | |
| `pi.registerCommand("gateway", …)` (alle Subcommands) | `core/commands.ts` als `registerGatewayCommand(pi)` | U | Spawn-Logik von `start -d` → `spawnDetachedDaemon()` aus daemon.ts; Rest wörtlich |
| 5× `pi.registerTool(…)` | `core/tools.ts` als `registerGatewayTools(pi)` | V | `listTasks(params.status as any)` bleibt (Phase 2) |
| `pi.on("session_start"/"session_shutdown")` | `core/status-footer.ts` als `registerStatusFooter(pi)` | U | Intervall/ctx → `runtime.*` |
| `PID_FILE` | `core/daemon.ts` (lokal const) | V | Duplikat in cli.ts = Follow-up |
| `readDaemonPid()` | `core/daemon.ts` | V | |
| `reloadDaemonConfig()` | `core/daemon.ts` | U | `config = nextConfig` → `runtime.config = …`; nutzt server.ts start/stop |
| `startConfigWatcher()` | `core/daemon.ts` | U | Queue/Flag → `runtime.*` |
| `IS_DAEMON` + Top-Level-Dispatch | `core/daemon.ts` (`isDaemonMode`, `bootstrapIfDaemon()`) | U | Dispatch bleibt **Top-Level in index.ts** (Evaluation-Ordnung wie heute) |
| `detachAndRun()` | `core/daemon.ts` | U | Init-Duplikat → `initRuntime()`; shutdown-Handler 1:1 |
| `startGatewayServer()` | `core/server.ts` | U | setzt `runtime.hooks.broadcast` **vor** `startRpc()`; nutzt registry + rpc + cron |
| `stopGatewayServer()` | `core/server.ts` | U | DB-Query → `listActiveChannels()` aus sessions/store.ts; RPC-Kill → `stopRpc()` |
| `export default function (pi)` | `index.ts` (dünn) | N | nur: `initRuntime()`, 3× `init*Store()`, `registerGatewayCommand/Tools/Footer(pi)`, Log-Zeile; danach Top-Level `bootstrapIfDaemon()` |
| globale `let`s (config, state, server, wss, rpcProcess, globalCtx, cronInterval, statusRefreshInterval, lastGatewayStatusText, statusUpdateGeneration, lastDetachedHealthConfig, configReloadQueue, daemonShuttingDown) | `state.ts` (`runtime.*`) | U | 1:1-Feldzuordnung (Tabelle §1.3 B) |

---

## 5. Implementierungs-Sequenz (für den Coder)

**Meta-Regeln (gelten für ALLE Schritte):**
- **R1 — Additive Migration:** Code wird pro Schritt *wörtlich* in das neue Modul kopiert, dort nur Importe + State-Zugriffe (`config` → `runtime.config` etc.) angepasst, und **im selben Schritt** aus `index.ts` gelöscht. Keine Zwischenstände mit Duplikaten über Step-Grenzen hinweg.
- **R2 — Build-Gate:** Nach JEDEM Schritt: `npm run build` muss 0 Errors liefern. Sonst: revertieren des Schritts, nicht weiter.
- **R3 — Smoke-Gate:** Nach jedem Schritt der zugehörige Smoke-Test (§6) ausführen.
- **R4 — Kein Scope-Creep:** Keine Bugfixes, keine Typänderungen, keine "kleinen Verbesserungen" während des Moves. `as any`-Casts und FIFO-Semantik bleiben exakt so.
- **R5 — Ein Commit pro Schritt** (Branch `refactor/w1-modularization`), Commit-Nachricht = Schrittname. Rollback = `git revert`.

### Schritt 0 — Baseline & Branch
1. `git checkout -b refactor/w1-modularization`
2. `npm run build` → dist/ ok
3. Baseline-Smoke: Gateway starten (inline), `/gateway status`, eine Telegram-Nachricht senden (Streaming + Antwort prüfen), Daemon-Modus testen (`/gateway start -d` → health ok → `/gateway stop`).
4. Ergebnis dokumentieren (Screenshot/Log-Auszug in Commit 0).

### Schritt 1 — Fundament: `types.ts` + `config.ts` + `state.ts`
1. `src/types.ts` anlegen: `GatewayConfig`, `GatewayState` wörtlich aus index.ts.
2. `src/state.ts` anlegen: `GatewayRuntime`-Interface, `runtime`-Singleton, `initRuntime()` (ersetzt beide Inline-Inits: Default-Export + detachAndRun).
3. `src/config.ts` anlegen: `DEFAULT_CONFIG`, `mergeGatewayConfig()`, `loadConfig()`, `readDetachedHealthConfig()`, `getDetachedGatewayHealth()`.
4. `index.ts`: verschobene Blöcke löschen; alle Referenzen auf `config`/`state`/`lastDetachedHealthConfig` → `runtime.*`; die beiden Init-Stellen → `initRuntime()`.
5. **Gate:** Build + Smoke (Status + 1 Nachricht).

### Schritt 2 — `core/rpc.ts`
1. `src/core/rpc.ts` anlegen: `PendingRequest`/`pendingRequests`, `PendingCompletion`/`pendingCompletions` (privat), `startRpc()` (= createRpcProcess, Broadcast via `runtime.hooks.broadcast`), `sendRpc()`, `extractAgentEndText()` (privat), `sendPromptRpc()`, neu: `stopRpc()`, `restartRpc()`, `isAgentRunning()`, `peekActiveCompletion()`, `resetActiveStream()`.
2. `index.ts`: `startGatewayServer` → `startRpc()`; `/restart`-Handler → `restartRpc()`; `stopGatewayServer` → `stopRpc()`; Status-Checks → `isAgentRunning()`; alte RPC-Blöcke löschen.
3. **Gate:** Build + Smoke mit **vollständigem Prompt-Rundlauf** (Telegram-Nachricht → gestreamte Antwort) — das ist der kritischste Pfad des ganzen Refactorings.

### Schritt 3 — `core/daemon.ts` (Teil 1) + `core/status-footer.ts` (Teil 1) + `core/message-pipeline.ts`
1. `src/core/daemon.ts` anlegen (Teil 1): `PID_FILE`, `isDaemonMode`, `readDaemonPid()`.
2. `src/core/status-footer.ts` anlegen (Teil 1): `updateStatus()` (State → runtime, Health via config.ts). *Begründung vorziehen:* `adapterCallbacks.onDisconnect` braucht `updateStatus` und message-pipeline darf index.ts nicht importieren.
3. `src/core/message-pipeline.ts` anlegen: `adapterCallbacks` wörtlich; Umstellungen: `pendingCompletions[0].streamedText` → `peekActiveCompletion()`, `.streamedText = ""` → `resetActiveStream()`, `IS_DAEMON` → `isDaemonMode`, `config/state/rpcProcess` → `runtime.*`, `updateStatus`-Import.
4. `index.ts`: Blöcke löschen, Referenzen umstellen.
5. **Gate:** Build + Smoke (Nachrichten-Pfad inkl. `/model list` und `/restart` als Admin).

### Schritt 4 — `adapters/registry.ts` + `sessions/store.ts` (+)
1. `src/sessions/store.ts`: `listActiveChannels()` hinzufügen (SQL-Query wörtlich aus stopGatewayServer).
2. `src/adapters/registry.ts` anlegen: `initializeAdapters()` wörtlich (importiert `adapterCallbacks` aus message-pipeline.ts).
3. `index.ts`: Block löschen.
4. **Gate:** Build + Smoke (alle konfigurierten Adapter starten, `/gateway status` zeigt Adapter).

### Schritt 5 — `core/server.ts`
1. `src/core/server.ts` anlegen: `verifyToken()`, `authenticate()`, `sendWs()`, `broadcastClients()` (+ `runtime.hooks.broadcast = broadcastClients` in `startGatewayServer`), `handleHttpRequest()`, `handleWebSocket()`, `startCron()`, `stopCron()`, `startGatewayServer()`, `stopGatewayServer()` (DB-Query → `listActiveChannels()`, RPC-Kill → `stopRpc()`).
2. `index.ts`: Blöcke löschen.
3. **Gate:** Build + Smoke (Start/Stop inline, HTTP-APIs `/api/*`, WS-Client ping, Cron-Verhalten).

### Schritt 6 — `core/daemon.ts` (Teil 2, vollständig)
1. In `src/core/daemon.ts` ergänzen: `reloadDaemonConfig()`, `startConfigWatcher()`, `detachAndRun()` (Init → `initRuntime()`), `spawnDetachedDaemon()`, `bootstrapIfDaemon()`.
2. `index.ts`: Daemon-Blöcke löschen; Top-Level: `bootstrapIfDaemon()` nach den Imports (Evaluation-Ordnung wie heute beibehalten).
3. **Gate:** Build + Smoke **Daemon-Kompletttest**: `/gateway start -d` → PID-File + health, Config-Edit → Watcher-Reload, SIGHUP-Reload, Listener-Rollback (Port ändern auf belegten Port), `pi-gateway stop` (verifizierter Kill), `pi-gateway status`.

### Schritt 7 — `core/status-footer.ts` (Teil 2)
1. In `src/core/status-footer.ts` ergänzen: `registerStatusFooter(pi)` mit den `pi.on("session_start"/"session_shutdown")`-Hooks + `STATUS_REFRESH_INTERVAL_MS`.
2. `index.ts`: Hooks löschen, `registerStatusFooter(pi)` aufrufen.
3. **Gate:** Build + Smoke (Footer in Pi-TUI aktualisiert sich, verschwindet bei session_shutdown sauber).

### Schritt 8 — `core/commands.ts`
1. `src/core/commands.ts` anlegen: `registerGatewayCommand(pi)` mit allen Subcommands wörtlich; `start -d`-Spawn → `spawnDetachedDaemon()`.
2. `index.ts`: Command-Block löschen, `registerGatewayCommand(pi)` aufrufen.
3. **Gate:** Build + Smoke (jeden `/gateway`-Subcommand einmal: start/stop/restart/status/pair/allow/revoke/admin/sessions/tasks/config/tool-policy).

### Schritt 9 — `core/tools.ts`
1. `src/core/tools.ts` anlegen: `registerGatewayTools(pi)` mit den 5 Tools wörtlich.
2. `index.ts`: Tool-Blöcke löschen, `registerGatewayTools(pi)` aufrufen.
3. **Gate:** Build + Smoke (jedes Tool einmal via Pi aufrufen).

### Schritt 10 — Abschluss & Verifikation
1. `index.ts` final prüfen: nur noch Imports, Default-Export (~15 Zeilen Logik), `bootstrapIfDaemon()`. Ziel: **< 100 Zeilen**.
2. Vollständiger Build + **kompletter Smoke-Katalog** (§6).
3. Import-Zykel-Check: `tsc`-Log sauber + manuelle Gegenprüfung der Regeln-Tabelle (§3.4).
4. `ROADMAP.md`: W1-Checkbox setzen, Kurzverweis auf diesen Plan.
5. Merge-PR mit Checkliste aus §6 im Description-Text.

---

## 6. Verifikationsplan (Smoke-Katalog)

| # | Test | Abdeckung | Ab Schritt |
|---|---|---|---|
| S1 | `npm run build` → 0 Errors | Kompilierung | alle |
| S2 | `/gateway start` (inline) → HTTP erreichbar, `/api/status` korrekt | Server, Config | 1 |
| S3 | Telegram-Nachricht → Typing → gestreamte Edit-Updates → finale Antwort | RPC, Pipeline, Streaming | 2 |
| S4 | `extension_ui_request` (z. B. select) → Prompt im Chat → Antwort geht an pi | interactive-Bridge, Hooks | 2 |
| S5 | `/model` (list + inline buttons), `/model provider/id` (Admin), Callback-Flow | Pipeline, Security | 3 |
| S6 | `/restart` (inline: pi-agent-Restart; Daemon: SIGHUP) | Pipeline, Daemon | 3/6 |
| S7 | Adapter starten/stoppbar, `/gateway status` zählt korrekt | Registry | 4 |
| S8 | WS-Client: connect/ping/prompt/background | Server, WS | 5 |
| S9 | Cron: Background-Task-Ergebnis wird nach ≤ 60 s geliefert | Cron, background | 5 |
| S10 | Daemon: start -d → PID + health; Config-Edit → Reload; belegter Port → Rollback; stop (verifiziert) | Daemon komplett | 6 |
| S11 | `pi-gateway` CLI: start/stop/status | CLI ↔ Daemon (unverändert, Regressionscheck) | 6 |
| S12 | Pi-Footer: Status erscheint/aktualisiert, bei session_shutdown weg | status-footer | 7 |
| S13 | Alle `/gateway`-Subcommands + alle 5 Tools | commands, tools | 8/9 |
| S14 | `stopGatewayServer` sendet Shutdown-Nachricht an aktive Kanäle | server + store-API | 5 |

---

## 7. Risiken & Mitigationen

| # | Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Verhaltensdrift beim wörtlichen Verschieben** (fehlende Referenz, falscher State-Zugriff) | mittel | hoch | R1/R4-Meta-Regeln; pro Schritt Build+Smoke; Code-Review mit Fokus auf `runtime.*`-Umstellungen |
| R2 | **Import-Zykel entsteht** (v. a. server ↔ rpc ↔ message-pipeline) | niedrig–mittel | hoch | Import-Regeln-Tabelle (§3.4) als Review-Checklist; Hook-Injection für Broadcast; `getDetachedGatewayHealth` bewusst in config.ts |
| R3 | **Module-Evaluation-Ordnung** (Top-Level-`bootstrapIfDaemon()` vor/after Default-Export-Aufruf) | niedrig | mittel | Dispatch bleibt Top-Level in index.ts exakt wie heute; Daemon-Smoke (S10) früh ab Schritt 6 |
| R4 | **FIFO-Rennbedingungen** bei `pendingCompletions` ändern sich durch Kapselung | niedrig | mittel | FIFO bleibt 1:1 (A2); `peekActiveCompletion`/`resetActiveStream` sind die einzigen neuen Zugriffe und ersetzen direkte Array-Indizes ohne Semantikänderung |
| R5 | **Laufender Daemon nutzt altes dist/** während des Refactorings | sicher (faktisch) | niedrig | Erst am Ende (Schritt 10) final rebuilden + `pi-gateway stop`/`start`; dazwischen läuft der alte, stabile Daemon weiter |
| R6 | **Schritt wird zu groß und untestbar** (v. a. Schritt 8: commands ~650 Zeilen) | mittel | mittel | commands.ts ist rein lesend/aufrufend (kein Lifecycle) → Risiko gering; falls nötig in `commands/security.ts` + `commands/lifecycle.ts` aufteilen (nur wenn Build/Review es erfordert) |
| R7 | **Session-DB-Zugriff in stopGatewayServer** verhält sich nach Extraktion anders | niedrig | mittel | SQL wörtlich übernehmen; S14 explizit getestet |

---

## 8. Out of Scope (bewusst nicht in W1)

| Item | Roadmap | Begründung |
|---|---|---|
| B4: FIFO → `Map<sessionId, PendingRequest>` | Phase 1 | Wird durch Kapselung in `core/rpc.ts` **vorbereitet** (Änderung dann auf 1 Modul begrenzt); Umsetzung separat, da Verhalten ändert |
| B7: sessionId pro RPC-Nachricht | Phase 1 | dito — API von `sendPromptRpc` bekommt danach optionalen Parameter |
| B1–B3, B6, B8 (Rate-Limit, Pairing-Flow, Platform-Union, Twitch, WhatsApp-Imports) | Phase 2 | Bugfixes/Stabilisierung |
| W2 (`strict: true`), W4 (Linter/Prettier), W5 (Unit-Tests), W6 (README) | Phase 2 | Code-Qualität |
| `cli.ts` PID/Health-Duplikat → gemeinsame Nutzung von `core/daemon.ts`/`config.ts` | Follow-up | cli.ts importiert heute nur status.js; Entduplizierung nach W1 trivial |
| Telegram-Webhook `as any`-Cast, `listTasks(status as any)` | Phase 2 (B3/B8) | bleibt wörtlich erhalten |

---

## 9. Nächste Schritte (Action Items)

1. **Reviewer:** Plan freigeben (dieses Dokument).
2. **Coder:** Schritt 0–10 aus §5 umsetzen (ein Task pro Schritt oder ein Kette-Task mit Gate-Checkliste aus §6; empfohlen: max. 2 Schritte pro Coder-Task, da Kontextgröße).
3. **Architect (Review):** Nach Schritt 2, 5 und 6 kurze Review der Diff-Struktur (Zykel-Check, runtime-Nutzung).
4. **Auditor:** Nach Abschluss W1: `ROADMAP.md` aktualisieren, Learnings aus Trace/Reflection einsammeln.

---

*Erstellt vom Architect-Worker (architect-20260818-174347). Basis: Volllesung von `src/index.ts` (5 Chunks), `ROADMAP.md`, `package.json`, `tsconfig.json`, `src/{cli,interactive,paths}.ts`, `src/adapters/base.ts`, `src/sessions/store.ts` (Auszug).*
