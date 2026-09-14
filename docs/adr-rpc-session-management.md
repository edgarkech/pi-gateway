# ADR: RPC Session Management — von FIFO-Array zu Map-basiertem Multiplexing per `sessionId`

- **Status:** Proposed
- **Datum:** 2026-08-19
- **Entscheidung:** Ja (empfohlen) — Design-Entscheidung, kein Feature-Flag
- **Betroffene Komponenten:** `src/core/rpc.ts`, `src/core/interactive.ts`, `src/adapters/*`, `src/types.ts`, `src/server.ts`, `src/sessions/store.ts`
- **Voraussetzung (Upstream):** Pi RPC Protocol v? — benötigt optionale `sessionId`-Echos in Events (siehe §1.5)

---

## Kontext

Der Gateway (`pi-gateway`, im Folgenden "der Gateway") verbindet mehrere Plattform-Kanäle
(Telegram, Discord, Slack, …) mit einem einzigen Pi-Coding-Agent-RPC-Prozess.

Die heutige Implementierung in `src/core/rpc.ts` verwaltet **alle** ausstehenden Prompts in
**zwei globalen, FIFO-basierten Arrays**:

- `pendingRequests: PendingRequest[]` — korreliert RPC-**ACKs** über das `id`-Feld.
- `pendingCompletions: PendingCompletion[]` — hält die **volle Completion** (inkl. `streamedText`),
  bis `agent_end` eintrifft.

Zusätzlich existiert im `interactive.ts` ein **einziges globales** `activeChannel`-Singleton.

### Ursachen / Probleme (Ist-Zustand)

1. **`agent_end` löst immer das FIFO-Headelement auf:**
   ```ts
   const completion = pendingCompletions.shift(); // immer Index 0
   ```
   Diese Annahme *"der erste gesendete Prompt ist der erste fertige Prompt"* ist nur bei einem
   einzigen, streng seriellen Stream korrekt. Sobald zwei Kanäle Prompts senden und die
   `agent_end`-Reihenfolge von der Sende-Reihenfolge abweicht (Queueing via `streamingBehavior`,
   Steering, `willRetry`, Compaction), werden **Completions dem falschen Kanal zugeordnet**.

2. **`message_update` (text_delta) hängt immer an `pendingCompletions[0]`:**
   ```ts
   const completion = pendingCompletions[0]; // nur das aktive Element
   ```
   Streaming-Deltas können nicht robust den passenden Kanal finden.

3. **`activeChannel` ist ein Singleton** — eine zweite Kanal-Anfrage überschreibt die erste.
   `extension_ui_request` und `cleanupPendingUiRequests()` (auf `agent_end`) beziehen sich damit
   potenziell auf den falschen Kanal.

4. **`peekActiveCompletion()` / `resetActiveStream()`** lesen/schreiben `pendingCompletions[0]`
   — rein FIFO, kein Bezug zu einem echten aktiven Kanal bei Mehrkanal-Betrieb.

5. **Keine echte Parallelität:** Alle Kanäle teilen sich einen Prozess & einen linearen Stream;
   Prompts werden seriell bearbeitet. Es gibt kein Modell, mehrere Agent-Turns **gleichzeitig**
   und **zuordnungsfähig** zu führen.

### Ziel

Kommunikation robust und parallelisierbar machen:
- Kanalzuordnung über eine **`sessionId`** statt über Array-Positionen.
- **Mehrere Channels gleichzeitig** bedienen (echte Nebenläufigkeit der Agent-Turns).
- `peekActiveCompletion()` & Streaming-Deltas korrekt je aktivem Kanal auflösen.

---

## Entscheidungsoptionen

| Option | Beschreibung | Echte Parallelität | Robustheit | Kosten |
|--------|--------------|--------------------|-----------|--------|
| **A. Ein RPC-Prozess pro Session + `Map<sessionId, SessionRuntime>`** | Pro Gateway-Session wird ein isolierter Pi-Prozess gestartet; die `sessionId` ist Registerschlüssel. | ✅ Voll (Prozess-isoliert) | ✅ Hoch (Prozess = Korrelation) | Moderate Ressourcen pro Kanal |
| B. Ein Prozess, Events über `sessionId` mitschicken | Ein Prozess, `sessionId` in jedem Event für Multiplexing. | ❌ Begrenzt (Pi-Queue bleibt seriell) | ⚠️ Mittel (Event-Echo nötig) | Gering |
| C. Hybrid (empfohlen) | **A als Basis**, plus **optionale `sessionId`-Echos** (§1.5) als Belastbarkeits-Fallback für Fortsetzungs-Turns innerhalb einer Session. | ✅ Voll | ✅ Sehr hoch | A-Kosten + kleiner Protokoll-Aufwand |

> **Entscheidung: Option C (Hybrid).** A liefert echte Parallelität und macht die Korrelation
> träge (durch die Prozess-Zugehörigkeit), ohne dass zwingend eine Event-Protokoll-Änderung nötig
> ist. Die optionale `sessionId`-Echobehandlung (§1.5) wird prospektiv aufgenommen, falls Pi
> künftig mehrere `prompt`-Turns innerhalb eines Prozesses ohne `streamingBehavior` enge Kopplung
> erlaubt. Sie ist **nicht** Killerkriterium für die Migration.

---

## Design

### 1. Protokoll-Design (Nachrichten & `sessionId`)

#### 1.1 Generelles Rahmenwerk

Der Gateway sendet an Pi **pro Session** einen eigenen Prozess. Die `sessionId` ist die
Gateway-seitig persistente Session-ID aus `sessions/store.ts` (Format `sess-<ts>-<rand>`).
Sie wird deterministisch als Schlüssel der Laufzeit-Map verwendet und in die `prompt`-Payload
aufgenommen, um Gateway-seitig nachvollziehbar zu bleiben.

#### 1.2 `prompt` (Gateway → Pi)

```jsonc
{
  "id": "req-<rand32hex>",          // RPC-ACK-Korrelation (bestehend)
  "type": "prompt",
  "message": "Erkläre die Architektur",
  "sessionId": "sess-1724080000000-abc123",   // NEU: Gateway-Session
  "streamingBehavior": "steer"                 // bei laufendem Turn (optional)
}
```

**Semantik:** `sessionId` ist rein bookkeeping/seitig zum Verfolgen des Turns. Der eigentliche
Routing-Schlüssel auf Empfänger-Seite ist **die Prozess-Zugehörigkeit** der Session (siehe §3).

#### 1.3 `message_update` (Pi → Gateway, Streaming)

Der Gateway identifiziert die Session über den **Prozess**, von dem das Event stammt.
Sobald Pi optionale Session-Echos unterstützt, werden sie ergänzt:

```jsonc
{
  "type": "message_update",
  "sessionId": "sess-1724080000000-abc123",   // OPTIONAL (Pi-Echo), siehe §1.5
  "usage": { /* ... */ },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

Der Gateway respektiert **immer**: Wird `sessionId` geliefert, wird sie als primärer Key verwendet;
andernfalls fällt er auf die Prozess-Zuordnung zurück.

#### 1.4 `agent_end` (Pi → Gateway)

```jsonc
{
  "type": "agent_end",
  "sessionId": "sess-1724080000000-abc123",   // OPTIONAL (Pi-Echo)
  "messages": [ /* AgentMessage[] */ ],
  "willRetry": false
}
```

Der Gateway löst die Completion über `sessionId` (falls vorhanden) bzw. Prozess auf. Die
bestehende Extraktion `extractAgentEndText(msg)` bleibt unverändert gültig.

#### 1.5 Upstream-Ergänzung (Pi RPC Protocol — Feature-Request)

Damit die Robustheit nicht allein von der Prozess-Zuordnung abhängt, wird **beim Pi-Projekt**
angeregt, die Events `message_update` und `agent_end` mit einem optionalen `sessionId`-Feld zu
versehen, das die `sessionId` des zugehörigen `prompt`-Requests widerspiegelt (analog zu
`bash_execution_update`, das bereits den `id` des Ursprungs-Bash-Kommandos echoet).

**Begründung:** Die Pi-Doku hält fest, "Events do not generally include an id field" — aber
`bash_execution_update` setzt hier bereits einen Präzedenzfall für die Korrelation von Events zu
einem Ursprungs-Request. `sessionId` erweitert denselben Mechanismus.

> **Risiko:** Ohne dieses Pi-Echo verlässt sich der Gateway vollständig auf die Prozess-Isolation
> (Option A). Das ist für die geplante Architektur ausreichend, schmälert aber die Flexibilität
> für künftige Mehrturns-Prozesse.

---

### 2. Agenten-Verhalten (wie Pi die `sessionId` handhabt)

Der Pi-Agent (Coding-Agent) empfängt die `prompt`-Payload **unverändert** — `sessionId` ist ein
für Pi unbekanntes, toleriertes Zusatzfeld und wird nicht negativ interpretiert.

Konkretes Verhalten:

1. **Empfang:** Die `prompt`-Command-Payload enthält `sessionId`; Pi akzeptiert die Nachricht
   (ACK, `success: true`) wie bisher. Unbekannte Felder sind im Pi-RPC-Protokoll permissiv.

2. **Antwort-Events transparenter:** `agent_end` und `message_update` verlassen Pi unverändert.
   Sofern nicht durch den Pi-Feature-Request (§1.5) ergänzt, **erzeugt Pi selbst keinen
   `sessionId`-Back-Transport**. Die Zuordnung übernimmt ausschließlich der Gateway (→ §3).

3. **Kein Einsortieren in `messages`:** `sessionId` wird NICHT in `AgentMessage.content` oder als
   Message-Inhalt geschrieben. Sie bleibt reine Metadaten auf Event-/Command-Ebene.

> **Klartext für Implementierung:** "Wie der Pi-Agent die `sessionId` wieder mitschickt" wird beim
> aktuellen Upstream-Protokoll **nicht** durch Pi erbracht, sondern durch den Gateway via
> Prozess-Isolation. Der ADR spezifiziert beide Pfade (prozess-basiert jetzt, `sessionId`-Echo
> optional), damit die Implementierung unabhängig vom Upstream-Termin starten kann.

---

### 3. Concurrency-Management — `Map<sessionId, SessionRuntime>`

Das Herzstück: Ersetze die zwei Arrays + das `activeChannel`-Singleton durch eine zentrale,
`sessionId`-geschlüsselte Map.

#### 3.1 Neue Typen (Vorschlag, in `src/core/rpc.ts` bzw. neu `src/core/runtime-registry.ts`)

```ts
/** Laufzeit-Zustand einer einzelnen aktiven Session. */
interface SessionRuntime {
  sessionId: string;                 // = sessions.store id
  platform: string;                  // "telegram" | "discord" | ...
  channelId: string;                 // Ziel-Kanal
  userId: string;                    // (für Session-Store / UI-Korrelation)
  proc: ChildProcess;                // der ISOLIERTE Pi-RPC-Prozess dieser Session
  adapter: BaseAdapter;              // Plattform-Adapter zum Senden
  ack?: PendingRequest;              // offener ACK (id-Korrelation) — optional
  completion?: PendingCompletion;    // aktive Completion (Resolver + Timer + streamedText)
  ui: Map<string, PendingUiRequest>; // pro-Session interaktive Requests (Neu)
}
```

```ts
const sessionRuntimes = new Map<string, SessionRuntime>();  // ersetzt pendingCompletions[] + activeChannel + pendingUiRequests
```

#### 3.2 Mapping-Regeln

- **`sessionId` ↔ Kanal:** Die `sessionId` ist die persistente Session-ID aus
  `sessions/store.ts` (per Kanal via `getOrCreateSession(platform, channelId, userId, config)`).
  Damit entsteht eine 1:1-Beziehung `sessionId ⇄ (platform, channelId, userId)`.
- **`sessionId` ↔ Prozess:** Pro Session genau **ein** Pi-RPC-Prozess. `startRpc()` wird nach
  Session parametrisiert und registriert den Prozess unter der `sessionId` in der Map.
- **`sessionId` ↔ aktive Completion:** Wird ein Prompt an eine Session gesendet, wird die
  Completion unter der `sessionId` abgelegt; `agent_end` bzw. `message_update` lösen sie über
  die Prozess-Zuordnung (bzw. optional über das `sessionId`-Echo) auf.

#### 3.3 Lifecycle

| Ereignis | Verhalten |
|----------|-----------|
| Erste Nachricht eines Kanals | `getOrCreateSession` → falls keine Session läuft: `startRpcFor(sessionId)` starten, `SessionRuntime` anlegen, in Map registrieren. |
| `sendPromptRpc(sessionId, msg, onStream)` | Completion unter `sessionId` registrieren (Resolve/Reject/Timer/streamedText); Prompt an den Session-Prozess senden |
| `message_update` (text_delta) | `sessionId` (Fallback: Prozess) → `runtime.completion.streamedText += delta`; `onStream(streamedText)` |
| `agent_end` | `sessionId`/Prozess → `runtime.completion` auflösen; `pendingUiRequests` dieser Session bereinigen |
| Prozess-`exit` | Alle offenen Completions **dieser** Session ablehnen; `sessionRuntimes.delete(sessionId)`; Adapter-Notify |
| Idle-Reset / Abort | `abortRpc(sessionId)` → Prozess killen + Map-Eintrag entfernen (Session wird von Store als neu/reset behandelt) |

#### 3.4 `peekActiveCompletion()` & Deltas in Multi-Channel

`peekActiveCompletion()` ist heute ohne Kontext (`pendingCompletions[0]`). Neue Signatur:

```ts
export function peekActiveCompletion(sessionId: string): { streamedText: string } | null {
  const rt = sessionRuntimes.get(sessionId);
  return rt?.completion ? { streamedText: rt.completion.streamedText } : null;
}
export function resetActiveStream(sessionId: string): void {
  const rt = sessionRuntimes.get(sessionId);
  if (rt?.completion) rt.completion.streamedText = "";
}
```

**Übergangs-Kompatibilität:** Solange Aufrufer (z. B. `flushHandler` in `interactive.ts`) noch
ohne `sessionId` arbeiten, stellt der Gateway eine **Default-Session** bereit (z. B. den zuletzt
aktiven Kanal). Ziel ist, alle Aufrufer auf `sessionId` umzustellen (→ §4).

#### 3.5 Was wird dadurch robust?

- **Kein falscher Kanal:** `agent_end` löst nie mehr den falschen Channel auf, weil die
  Zuordnung pro Prozess/Session erfolgt und nicht über Array-Position.
- **Echte Parallelität:** `Kanal A` und `Kanal B` haben getrennte Pi-Prozesse; beide streamen
  und enden unabhängig. Der Gateway multiplexet die Events über die Map.
- **Streaming-Deltas sauber:** Jedes `message_update` landet beim passenden Channel.

---

### 4. Impact-Analyse (was konkret geändert werden muss)

| # | Datei | Symbol/Ort | Änderung |
|---|-------|-----------|----------|
| 1 | `src/core/rpc.ts` | `pendingCompletions: PendingCompletion[]` | **Ersetzen** durch `Map<string, SessionRuntime>` (bzw. `Map<string, PendingCompletion>`), Key = `sessionId` |
| 2 | `src/core/rpc.ts` | `pendingRequests: PendingRequest[]` | Für ACK-Korrelation innerhalb einer Session: **pro Session** führen (oder weiterhin global via `id`, aber Session-Zuordnung in `SessionRuntime.ack`). Empfohlen: gebündelt in `SessionRuntime.ack`. |
| 3 | `src/core/rpc.ts` | `startRpc()` | **Parametrisieren:** `startRpc(sessionId, platform, channelId)` startet einen Prozess pro Session und registriert ihn. `runtime.rpcProcess` (Singleton) wird **ersetzt** durch `runtime.rpcProcesses: Map<sessionId, ChildProcess>` oder entfällt. |
| 4 | `src/core/rpc.ts` | `sendRpc()` / `sendPromptRpc()` | Um `sessionId`-Parameter erweitern; Ziel-Prozess über die Map wählen. |
| 5 | `src/core/rpc.ts` | `agent_end`-Handler | `pendingCompletions.shift()` → Aussprache per `sessionId`/Prozess. Statt `cleanupPendingUiRequests()` global → **pro Session**. |
| 6 | `src/core/rpc.ts` | `message_update`-Handler | `pendingCompletions[0]` → `sessionId`-Lookup. |
| 7 | `src/core/rpc.ts` | `peekActiveCompletion()` / `resetActiveStream()` | Signatur um `sessionId` erweitern (bzw. Default-Kanal-Fallback). |
| 8 | `src/core/rpc.ts` | `restartRpc()` / `stopRpc()` / `isAgentRunning()` | Statt eines Prozesses: **alle** Session-Prozesse iterieren (Kill/Reject/Status). |
| 9 | `src/core/interactive.ts` | `activeChannel: ActiveChannel \| null` (Singleton) | **Ersetzen** durch Session-gebundenen Kontext; `handleExtensionUiRequest`/`handleInteractiveResponse` bekommen `sessionId`; `pendingUiRequests` → pro `SessionRuntime.ui`. |
| 10 | `src/core/interactive.ts` | `setActiveChannel` / `getActiveChannel` | Signatur/Wirkung auf Session-Basis umstellen (entfällt oder wird Session-gebunden). |
| 11 | `src/core/interactive.ts` | `cleanupPendingUiRequests()` | Statt alles zu räumen: nur die zur `sessionId` (bzw. zum Prozess) gehörigen Requests. |
| 12 | `src/state.ts` | `GatewayRuntime.rpcProcess: ChildProcess \| null` | **Ersetzen** durch `Map<string, ChildProcess>` (oder delegen auf die Session-Registry). `GatewayState` bleibt unverändert. |
| 13 | `src/server.ts` | WebSocket-`prompt`-Handler (`sendRpc("prompt", …)`) | `sessionId` aus Nachricht durchreichen; Kanal-Zuordnung herstellen. |
| 14 | `src/types.ts` | `GatewayConfig` (falls Ressourcen-Parameter gewünscht) | Optionales Feld z. B. `rpc.maxSessionProcesses?: number` für Obergrenze paralleler Session-Prozesse. |
| 15 | `src/sessions/store.ts` | `getOrCreateSession` | **Keine Änderung** — wird als Quelle der `sessionId` konsumiert; ggf. `touchSession` pro Aktivität verfeinern. |
| 16 | `src/extensions/pi-gateway-ask-user-rpc.ts` | Extension | **Keine protokoll-kritische Änderung**; sollte aber `ctx.ui.*`-Aufrufe session-unabhängig lassen (prozess-gebunden). |
| 17 | **Tests** (`tests/`) | RPC/Streaming-Tests | Neue Tests für: parallele Session-Completions, `agent_end`-Zuordnung pro Session, `peekActiveCompletion(sessionId)`, Prozess-Exit-Rejects. |

#### 4.1 Neue Module (optional, empfohlen)

- `src/core/runtime-registry.ts` — zentrale `Map<string, SessionRuntime>` inkl. Typen, getter/setter.
- `src/core/rpc-factory.ts` — Prozess-Spawn/Registry (`startRpcFor(sessionId, …)`, `abortRpc(sessionId)`).

---

## Konsequenzen

### Positiv
- **Robuste Kanalzuordnung:** Kein falsches Auflösen von Completions durch FIFO-Annahmen.
- **Echte Parallelität:** Mehrere Channels laufen gleichzeitig in isolierten Prozessen.
- **Streaming & `peekActiveCompletion` korrekt je aktivem Kanal.**
- **Isolation/Fehlerkapselung:** Ein hängender Kanal-Prozess blockiert nicht andere.
- **Session-Modell passt zum bestehenden Session-Store** (1 Session = 1 Prozess = 1 Kanal).

### Negativ / Trade-offs
- **Ressourcen:** Pro parallelem Kanal ein zusätzlicher Pi-Prozess (RAM/CPU/Memory). Durch
  Obergrenze (z. B. `rpc.maxSessionProcesses`) und Idle-Teardown (`abortRpc`) begrenzen.
- **Kontext-Reset:** Ein Kanal, der lange läuft, hält seinen Prozess & LLM-Kontext; Idle-Reset
  im Store muss auch den Prozess teardownen (sonst Ressourcen-Leak).
- **Upstream-Abhängigkeit (nur für Zusatz-Qualität):** Optionales `sessionId`-Echo in Events
  (§1.5) ist ein Pi-Feature-Request; Kernfunktion ist davon unabhängig (prozessbasiert).
- **Migrationsaufwand:** Umstellung aller Aufrufer von `peekActiveCompletion`/`activeChannel`
  auf `sessionId`-Parametrisierung; Phase mit Default-Session-Fallback vorgesehen.

---

## Nächste Schritte (Action Items)

1. [ ] `SessionRuntime`-Typ & `runtime-registry.ts` anlegen; `state.ts` von Singleton-Prozess auf `Map` umstellen.
2. [ ] `startRpc(sessionId, platform, channelId)` implementieren; `startGatewayServer` nutzt künftig Pro-Session-Spawn statt singulärem `startRpc()`.
3. [ ] `agent_end`-/`message_update`-Handler auf `sessionId`/Prozess-Lookup umstellen; `pendingCompletions.shift()`/`[0]` entfernen.
4. [ ] `interactive.ts` vom `activeChannel`-Singleton auf Session-Kontext migrieren; `pendingUiRequests` pro `SessionRuntime.ui` führen.
5. [ ] `peekActiveCompletion/resetActiveStream` auf `sessionId`-Signatur umstellen; Default-Session-Fallback für Migration bereitstellen.
6. [ ] Idle-/Reset-/Shutdown-Teardown: `restartRpc`/`stopRpc` iterieren alle Session-Prozesse.
7. [ ] Konfig: optionale Obergrenze `rpc.maxSessionProcesses` ergänzen (§4/14).
8. [ ] Pi-Feature-Request für `sessionId`-Echo in `message_update`/`agent_end` eröffnen (§1.5).
9. [ ] Tests: parallele Session-Completions, korrekte Zuordnung, Exit-Rejects (§4/17).

---

## Referenzen

- Ist-Code: `src/core/rpc.ts` (`pendingCompletions`, `pendingRequests`, `startRpc`, `sendPromptRpc`, `peekActiveCompletion`).
- Ist-Code: `src/core/interactive.ts` (`activeChannel`-Singleton, `pendingUiRequests`, `cleanupPendingUiRequests`).
- Ist-Code: `src/sessions/store.ts` (`getOrCreateSession`, `generateSessionId`, `touchSession`).
- Ist-Code: `src/state.ts` (`runtime.rpcProcess`), `src/server.ts` (Singleton `startRpc()`).
- Pi RPC Protocol (offiziell): https://pi.dev/docs/latest/rpc — Events/`message_update`/`agent_end`, `bash_execution_update`-Echo-Präzedenzfall.