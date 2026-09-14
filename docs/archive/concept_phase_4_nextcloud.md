# Phase 4: Channel Expansion (Nextcloud Talk) — Technisches Konzept

**Projekt:** `pi-gateway` (`~/.pi/projects/pi-gateway/`)
**Status:** Entwurf zur Freigabe (vor Implementierung)
**Datum:** 2026-08-21
**Autor:** PiWorker (Rolle: Architect)
**Basis-Analyse:** `src/adapters/base.ts`, `src/adapters/registry.ts`, `src/adapters/telegram.ts`, `src/core/daemon.ts`, `src/core/message-pipeline.ts`, `src/config.ts`, `src/types.ts`, `src/state.ts`, `src/media/*` (Phase 3), `ROADMAP.md`, Nextcloud Talk API Doku (chat/conversation/constants, Stand 2026-08)

---

## 1. Executive Summary

Phase 4 erweitert `pi-gateway` um einen neuen Kommunikationskanal: **Nextcloud Talk**. Kern-Anforderung: Der Pi-Agent ist auch über einen Nextcloud-Talk-Chat erreichbar, **ohne eine öffentliche URL** — Betrieb im lokalen Netzwerk/VPN.

Das wird über **Option B (OCS User-Polling)** erreicht: Das Gateway meldet sich als regulärer Nextcloud-User (mit App-Token) an und **pollt** die Talk-OCS-API aktiv nach neuen Nachrichten. Es gibt keine eingehenden Webhooks, kein Signalisierungs-Server — das Gateway braucht nur *ausgehende* HTTPS-Verbindungen zur Nextcloud im LAN. Das passt exakt in die bestehende, adapter-basierte Architektur.

**Kernentscheidungen:**

| # | Entscheidung | Begründung (Kurzform) |
|---|---|---|
| D1 | **Long-Polling** (`lookIntoFuture=1&timeout=30`) als primärer Poll-Modus, Interval-Fallback + exponentieller Backoff | Effizient: ~1 offene HTTP-Verbindung pro Raum, nahezu 0 CPU-Last im Idle; kein Busy-Loop |
| D2 | **Explizite, konfigurierte Räume** (`rooms: [token,…]`) als MVP; `autoDiscoverRooms` optional | Vorhersagbar, ressourcenschonend, minimale Angriffsfläche; Auto-Entdeckung als Ausbaustufe |
| D3 | **Last-Seen-Wasserstand** = `lastKnownMessageId` (int) pro Raumräumen, persistiert in SQLite (`talk_state`) | Restart-resilient; keine Doppel-Verarbeitung, kein Überspringen; Server liefert Offset über `X-Chat-Last-Given` und `lastKnownMessageId`-Param |
| D4 | **Filter auf eigene Nachrichten ist Pflicht** (sonst Endlos-Loop): `actorId === userId` (Bot) + `systemMessage ≠ ""` werden verworfen | Kritische Korrektheit: Gateway antwortet als derselbe OCS-User; ohne Filter würde jede Bot-Antwort erneut als Eingabe verarbeitet |
| D5 | **Poller als eigenes, testbares Modul** (`src/adapters/nextcloud/poller.ts`) + `OcsClient` (`ocs.ts`); Adapter orchestriert, Daemon-Lifecycle steuert Start/Stop | Entkoppelt Polling-Rohloops von Adapter/UI; unit-testbar ohne Netzwerk |
| D6 | **`NextcloudTalkAdapter extends BaseAdapter`**, transformiert Talk-Chat-Messages → `PlatformMessage` und emittiert via bestehendem `emitMessage` | Nahtlose Pipeline-Integration (Sessions, Rate-Limit, Allowlist, Interactive) ohne Pipeline-Änderungen |
| D7 | **Medien: Inbound via WebDAV-Download** (`remote.php/dav/files/{userId}/{path}`) + bestehendes `mediaManager.ingest()` (Magic-Byte-Sniffing, Quota, TTL) | Wiederverwendung des kompletten Phase-3-Media-Stacks; 0 neue Security-Logik |
| D8 | **Credentials als App-Token** (`appToken`) statt Hauptpasswort; Konfig in `config.json` (0600) / Env-Override; nie in Logs | App-Passwörter sind widerrufbar und scope-bar; Schutz vor Token-Leak |
| D9 | **DoS-Schutz der Nextcloud:** gedeckelte Anzahl offener Long-Polls, Client-basiertes Rate-Limit zwischen Polls, Backoff mit Circuit-Breaker | Kein Exzess an Requests; Last leichtgewichtig im Idle |

**Scope-MVP:** Eingehende Text-Nachrichten + Datei-/Bild-Anhänge aus Talk-Räumen; Antworten/Edit/Delete/Interactive als Text. **Out of Scope:** Outbound-Media (Agent sendet Dateien zurück), Typing-Indikator (kein REST-Endpoint ohne Signalisierung), Auto-Raum-Entdeckung (optional), Voice-Messages.

---

## 2. Ziel & Nicht-Ziele

### Ziele (Phase 4 MVP)
- **G1:** Der Pi-Agent ist über Talk-Chats erreichbar, ohne öffentliche URL (LAN/VPN-only ausgehende HTTPS).
- **G2:** Nachrichten aus konfigurierten Talk-Räumen erreichen den Agenten über die bestehende Pipeline (Sessions, Allowlist, Rate-Limit, Interactive).
- **G3:** Der Agent antwortet in den jeweiligen Raum, mit Streaming-Edit.
- **G4:** Datei-/Bild-Anhänge aus Talk werden über das bestehende Phase-3-Media-Modul verarbeitet.
- **G5:** Betriebsstabil im Daemon: Start/Stop sauber, Restart ohne Doppel-Verarbeitung, ballastfreies Idle-Polling.
- **G6:** Kein Endlos-Loop durch eigene Bot-Nachrichten.

### Nicht-Ziele (explizit)
- **N1:** Outbound-Media (Agent sendet Dateien in den Chat) → Folge-Phase (Design-Hooks in §4.5/§7).
- **N2:** Typing-Indikator → Talk stellt dafür keinen einfachen REST-Endpoint bereit (Signalisierungs-Server); `setTyping` = No-op.
- **N3:** Räume automatisch entdecken (alle Räume eines Users) im MVP → optional `autoDiscoverRooms` (§10).
- **N4:** Call-/Audio-/Webinar-Features von Talk → nur Chat + Datei-Sharing.
- **N5:** Benachrichtung über Talk-App-Push oder Notifications-API → Polling reicht für den Fall.
- **N6:** Webhook-/Bot-Setup auf der Nextcloud-Seite → bewusst nicht nötig (Option B).

---

## 3. Ist-Zustand & relevante Befunde

1. **`PlatformAdapter` / `BaseAdapter`** (`src/adapters/base.ts`) sind der stabile Vertrag: `initialize()`, `start(callbacks)`, `stop()`, `sendMessage`, `editMessage`, `deleteMessage`, `setTyping`, `getStatus`, `sendInteractive`, `cleanupInteractive`, geschütztes `emitMessage()`. `PlatformMessage` inkl. `attachments?: MediaAttachment[]` (§5.2 Phase 3). → Der neue Adapter implementiert genau dieses Interface; **keine Pipeline-Änderung nötig**.

2. **Telegram-Adapter** (`telegram.ts`) zeigt das Polling-Muster bereits: `start()` ruft `startLongPolling()`; ein while-Loop mit `offset` (Ort: `private offset`), Backoff on error, fire-and-forget-Verarbeitung. Der Nextcloud-Poller übernimmt dieses Muster, aber **multi-Room**, **persistiert den Offset** und nutzt die OCS-API.

3. **Daemon-Lifecycle** (`src/core/daemon.ts`): `detachAndRun()` initialisiert Stores → `bootstrapMediaManager` → `startGatewayServer` → `shutdown()` ruft `shutdownMediaManager()`. Adapter-Start passiert in `initializeAdapters()` (`registry.ts`). → Der Talk-Poller wird **innerhalb des Adapters** gestartet (`start()`) und im `shutdown()` über `adapter.stop()` abgeräumt; zusätzlich Shutdown-Hook für die Poll-State-DB. *(Erfüllt die Anforderung "neuer Background-Task im daemon.ts" — siehe §5.4.)*

4. **Media-Stack (Phase 3)** (`src/media/manager.ts`): `ingest({platform, messageId, channelId, userId, fileRef, fileName, declaredMime, declaredSizeBytes, kindHint, fetch})` streamt, sniffed Magic-Bytes, quota/t TTL. `runtime.media` ist der Singleton-Zugang. → Der Talk-Adapter reicht nur einen **WebDAV-Download-Closure** herein; das gesamte Phase-3-Sichtheitsmodell (Mime-Spoofing, Path Traversal via generierte Filenamen, Quota) greift unverändert.

5. **Config-Merge** (`src/config.ts` + `src/types.ts`): `DEFAULT_CONFIG` + `mergeGatewayConfig` + Validierung; neuer `platforms.nextcloudTalk`-Block folgt exakt diesem Muster (inkl. Validierung, §10).

6. **Registry** (`src/adapters/registry.ts`): `initializeAdapters()` instanziiert Adapter anhand `runtime.config.platforms.*`. → Ein `if (runtime.config.platforms.nextcloudTalk?.enabled …)`-Block + `runtime.state.adapters.set("nextcloudTalk", …)` reicht.

7. **Nextcloud Talk OCS API (verifiziert, 2026-08):**
   - Basis-Endpoint: `/ocs/v2.php/apps/spreed/api/v1` (Nextcloud ≥ 13); Auth: **Basic** (`user:password` bzw. `user:appToken`) + Header `OCS-APIRequest: true` + `Accept: application/json`.
   - Räume auflisten: `GET /room` (mit `modifiedSince` + Antwort-Header `X-Nextcloud-Talk-Modified-Before`).
   - **Chat empfangen (Long-Poll):** `GET /chat/{token}` mit `lookIntoFuture=1&timeout=30&limit=100&lastKnownMessageId=X&setReadMarker=1` → Antwort-Code `304 Not Modified` wenn nichts Neues (Long-Poll hält die Verbindung), `200` mit Nachrichten-Array und Header `X-Chat-Last-Given` (= nächster Offset). `lastKnownMessageId` wird quasi als "Last-Seen-ID" direkt vom Server verwaltet.
   - **Chat senden:** `POST /chat/{token}` mit `message`.
   - Chat editieren/löschen: `PUT`/`DELETE /chat/{token}/{messageId}` (nur eigene Nachrichten, Edit < 24 h).
   - Als gelesen markieren: `POST /chat/{token}/read`.
   - **Datei in den Chat teilen (Outbound, N1):** `POST ocs/v2.php/apps/files_sharing/api/v1/shares` mit `shareType=10`, `shareWith=<token>`, `path=<user-relative-pfad>`.
   - **Datei-Download (Inbound):** `remote.php/dav/files/{userId}/{path}` mit gleicher Basic-Auth.
   - Nachrichten-Elemente: `id, token, actorType, actorId, actorDisplayName, timestamp, systemMessage, messageType, message, messageParameters[]` (Rich Objects → Datei-Sharing erscheint als `file`-Objekt mit `id, name, path, mimetype, size, link`). Conversation-Typ: `3` = öffentlicher/gruppen-Chat, `1` = 1:1.

---

## 4. Architektur-Überblick (Zielzustand, Option B)

```
┌───────────────────────────── pi-gateway Prozess (Daemon) ─────────────────────────────┐
│                                                                                       │
│  ┌─ initializeAdapters() ─ registry.ts ─────────────────────────────────────┐        │
│  │  NextcloudTalkAdapter extends BaseAdapter                              │        │
│  │   ├─ OcsClient  (src/adapters/nextcloud/ocs.ts)                        │        │
│  │   │     HTTPS → <base>/ocs/v2.php/apps/spreed/api/v1 …                 │        │
│  │   │            → <base>/remote.php/dav/files/{userId}/… (Media)        │        │
│  │   └─ NextcloudTalkPoller (src/adapters/nextcloud/poller.ts)            │        │
│  │        pro Raum: Long-Poll GET /chat/{token}?lookIntoFuture=1…         │        │
│  │        + talk_state (SQLite) für lastKnownMessageId                    │        │
│  └──────────────▲──────────────────────────────────────────────────────────┘        │
│                 │ callbacks.onMessage(PlatformMessage)                             │
│  ┌──────────────┴──────────────────────────────────────────────────────────┐        │
│  │ core/message-pipeline.ts · Session → Rate-Limit → Allowlist → Meta     │        │
│  │ rpc.ts → sendPromptRpc(message, sessionId, images?, onStream)          │        │
│  └───────┬────────────────────────────────────────────────────────────────┘        │
│          ▼                                                                          │
│   pi-Agent (RPC) · Antwort → onStream → adapter.editMessage(token, msgId, text)     │
└──────────────────────────────────────────────────────────────────────────────────────┘
          │ (nur ausgehendes HTTPS ins LAN/VPN)
          ▼
   Nextcloud (Talk) — keine Webhooks, kein Signaling, keine öffentliche URL
```

**Eingang (Inbound):**
```
Talk-Raum: neue Nachricht
   └─► Long-Poll GET /chat/{token} liefert [msg…]  (HTTP 200, X-Chat-Last-Given)
        └─► poller.processBatch(): pro Nachricht filterPublishable()
             ├─ eigene (actorId===userId) / system / command → skip (nur Offset fortschreiben)
             └─ publishable → Adapter.handleTalkMessage(msg)
                  ├─ Text aus msg.message (Rich-Object-Platzhalter auflösen)
                  ├─ Medien: messageParameters[type=file] → WebDAV-Download-Closure → mediaManager.ingest()
                  └─ emitMessage(PlatformMessage { content, attachments, userId=actorId, channelId=token })
```

**Ausgang (Outbound):**
```
Pipeline-Antwort → adapter.sendMessage(token, text) → POST /chat/{token}
Streaming-Edit    → adapter.editMessage(token, messageId, text) → PUT /chat/{token}/{id}
```

---

## 5. Polling-Architektur (The Heart of Phase 4)

### 5.1 CPU-/Last-Steuerung — Long-Poll primär, Interval Fallback

**Primärmodus: Long-Polling.** Der Talk-OCS-Chat-Endpoint unterstützt nativ `lookIntoFuture=1&timeout=30` (0–60 s): Der Server hält die Verbindung offen und antwortet sofort, wenn eine Nachricht eintrifft, sonst nach `timeout` mit `304`. Im Leerlauf ist das **ein offener HTTP-Socket pro Raum** — nahezu null CPU, kein Timer-Loop. Das ist exakt das Telegram-Pattern (`timeout=30` Long-Poll), nur pro Raum.

**Fallback: Intervall-Polling.** Falls der Server `lookIntoFuture`/`timeout` nicht unterstützt (sehr alte Talk) oder der Admin es per Config erzwingt (`pollMode:"interval"`), wird mit `intervalMs` (Default 5000 ms) gepollt.

**Konkrete Loop-Steuerung (`poller.ts`):**

```
Poller.start(rooms)
 ├─ lade lastKnownMessageId pro Raum aus talk_state (D3)
 ├─ Starte pro Raum einen unabhängigen Loop (maxConcurrentPolls gedeckelt, D9)
 └─ Loop(room):
      while active:
        t0 = now
        try:
          res = ocs.receiveChat(room, { lookIntoFuture, timeout, lastKnown })
          latency = now - t0
          if res.status == 304:  continue            // nichts Neues → sofort wieder long-pollen
          batch = res.messages
          newLast = res.xChatLastGiven ?? max(batch.id)
          for msg in batch: 
            if publishable(msg): emit(msg)          // fire-and-forget
          persist(room, newLast)                     // erst NACH erfolgreicher Verarbeitung
          backoff = minBackoff                       // Erfolg → Backoff zurücksetzen
        catch err:
          if circuitOpen(err): break  /  suspend     // z.B. Auth 401, Server down
          backoff = min(backoff*2, maxBackoff)       // exponentieller Backoff
          sleep(backoff)                             // D1
```

**Regeln zur Lastbegrenzung:**
- **1 offener Request pro Raum** — nie parallel dasselbe `lastKnownMessageId` abfragen.
- **Maximale offene Polls** `< maxConcurrentPolls` (Default 4). Bei mehr konfigurierten Räumen → Räume round-robin-priorisieren; Räume ohne `unreadMessages` (Room-Liste) mit niedrigerer Priorität.
- **Kein Poll schneller als `minPollIntervalMs`** (Default 1000 ms) seit dem letzten Response — verhindert Request-Exzess bei schnellem `304`.
- **Backoff:** `backoff = min(backoff*2, maxBackoffMs)`, `maxBackoffMs` Default 60 s; Reset auf `minIntervalMs` bei Erfolg.
- **Circuit Breaker:** nach `circuitThreshold` (Default 5) aufeinanderfolgenden Fehlern eines Raums → Raum pausieren (`sleep(backoffInterval)`), nach längerer Pause neu versuchen; `401/403` → GUI-Status als `auth-failed`, Raum bleibt pausiert bis Config-Änderung.
- **`lastKnownMessageId` wird erst nach vollständiger, erfolgreicher Verarbeitung persistiert** — bei Crash wird die Nachricht erneut geliefert (at-least-once) statt übersprungen (at-most-once). At-least-once + idempotente Pipeline (Session-Dedup über `messageId`) ist der sichere Kompromiss.

### 5.2 Nachrichten-Zustand (Neu/Ungelesen) — Last-Seen-ID

**Wasserstand = `lastKnownMessageId` (Integer), eindeutig pro Raum.** Der Talk-Server behandelt diesen Wert bereits nativ:
- Er wird als `lastKnownMessageId`-Query-Parameter gesendet → Server liefert nur Nachrichten **danach**.
- Der nächste Offset steht im Response-Header `X-Chat-Last-Given` (zusätzlich `max(msg.id)` der Batch als Fallback).
- Optional `setReadMarker=1` → Server markiert automatisch als gelesen (wirkt wie "Ungelesen verbrauchen").

**Persistenz (`talk_state`, SQLite):**

```sql
CREATE TABLE IF NOT EXISTS talk_poll_state (
  room_token       TEXT PRIMARY KEY,
  last_known_msg_id INTEGER NOT NULL DEFAULT 0,
  last_polled_at   INTEGER,          -- epoch ms, für Status/Debug
  consecutive_errors INTEGER DEFAULT 0,
  updated_at       INTEGER           -- epoch ms
);
```

- Muster wie `sessions/store.ts` / `media/registry.ts`: `better-sqlite3`, Env-Override `GATEWAY_TALK_STATE_DIR` für Tests, WAL-Modus.
- **Warm-Start:** Beim Daemon-Start liest der Poller `last_known_msg_id` pro Raum → nach einem Restart wird genau ab dem letzten verarbeiteten Punkt weitergemacht (**keine Doppel-Verarbeitung von alten, bereits beantworteten Nachrichten, kein Überspringen**).
- **Room-Refresh** (optional autoDiscover): `talk_poll_state` wird bei Entfernung eines Raums geprunt; neue Räume werden mit `last_known_msg_id=0` aufgenommen (verarbeitet deren History ab Start — bewusst konservativ; bei Produktivsetzung besser manuell vorbefüllen).

> **Trade-off:** `last_known_msg_id=0` auf einem bestehenden Raum würde dessen gesamte History erneut verarbeiten. Daher MVP: Räume **explizit** konfigurieren; Auto-Discovery nur als opt-in mit dokumentiertem Verhalten.

### 5.3 Selbst-Filter (Anti-Endlos-Loop) — D4

Der Gateway antwortet als **derselbe OCS-User** (`userId`), der auch pollt. Ohne Filter würde jede Bot-Antwort als neue Eingabe verarbeitet → Endlos-Schleife. **Publishable-Prüfung (pro Nachricht):**

| Bedingung | Verhalten |
|---|---|
| `actorType === "bots"` | verwerfen |
| `actorId === <konfig. userId>` (unsere eigene Nachricht) | verwerfen (nur Offset fortschreiben) |
| `systemMessage !== ""` | verwerfen (System-Events, kein User-Input) |
| `messageType === "command"` und nicht als Command gewollt | MVP: verwerfen (kein Bot-Kommando-Handling) |
| sonst (echter User-Text / Datei-Sharing) | **publishable → emit** |

Dies wird **zentral** im Adapter geprüft (nicht im Poller), damit Filter-Logik testbar und UI-lastig bleibt.

### 5.4 Integration in den Daemon-Lifecycle (Background-Job)

**Zielbild:** Der Talk-Poller ist ein **daemon-geführter Background-Loop**, der im `initializeAdapters()`-Pfad (`registry.ts`) beim Start des Adapters hochfährt und im Daemon-`shutdown()` sauber abgebaut wird.

| Daemon-Phase | Aktion |
|---|---|
| **Start** (`detachAndRun` / Index-Load) | `initializeAdapters()` → `NextcloudTalkAdapter.start()` → `poller.start(rooms)`; `initTalkStateStore()` (SQLite). |
| **Laufzeit** | Poller-Loops laufen als un-ref'd async-Loops (Timers ggf. `unref()`), damit sie den Prozess nicht offen halten. |
| **Shutdown** (`shutdown()`) | **Neu (S5):** `stopAllAdapters()` ruft `adapter.stop()` → `poller.stop()` (Loops beenden, letzte Wasserstände persistieren). Danach `shutdownTalkStateStore()` (DB schließen). Reihenfolge vor `shutdownMediaManager()` um Race-Free-Media zu gewährleisten. |
| **SIGHUP / Config-Reload** | Auf `runtime.configReloadQueue`-Pfad: Poller stoppt & startet mit neuen `rooms`/Intervallen (kein Neustart des gesamten Daemons). |

**Design-Entscheidung (D5):** Es wird **kein** neuer Eintrag im `background/manager.ts` (der betreibt *User-Befehls*-Hintergrund-Jobs, `spawn("pi", …)`) angelegt — dieser Manager ist für etwas anderes zuständig. Stattdessen besitzt der Adapter seinen Poller selbst; der Daemon-Lifecycle orchestriert nur Start/Stop über das bereits vorhandene `PlatformAdapter`-Interface. Das hält die Trennung sauber und testbar.

---

## 6. Nextcloud/OCS-Integration

### 6.1 HTTP-Schicht (`OcsClient`, `src/adapters/nextcloud/ocs.ts`)

```ts
export interface OcsClientOptions {
  baseUrl: string;        // https://nextcloud.local  (ohne trailing slash)
  userId: string;         // Nextcloud-Login/Username (auch für WebDAV-Pfad)
  appToken: string;       // App-Passwort/App-Token (NICHT Hauptpasswort)
  allowInsecureHttp?: boolean;  // nur http:// im LAN, default false
  timeoutMs?: number;     // HTTP-Timeout (Request-Ebene), default 60_000
}

export class OcsClient {
  constructor(opts: OcsClientOptions);
  // Auth: Basic base64(user:appToken) + "OCS-APIRequest: true" + "Accept: application/json"
  private async request(method: string, path: string, opts?: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }): Promise<OcsResponse>;   // parsed OCS { ocs: { meta, data } } + statusCode + headers

  // Talk (spreed) API
  listRooms(opts?: { modifiedSince?: number }): Promise<TalkRoom[]>;          // GET /room
  receiveChat(room: string, q: { lookIntoFuture?: 0|1; limit?: number;
       lastKnownMessageId?: number; timeout?: number; setReadMarker?: 0|1 })
       : Promise<{ status: number; messages: TalkChatMessage[]; xChatLastGiven?: number }>;
  sendChatMessage(room: string, text: string): Promise<TalkChatMessage>;       // POST /chat/{token}
  editChatMessage(room: string, messageId: number, text: string): Promise<void>; // PUT
  deleteChatMessage(room: string, messageId: number): Promise<void>;            // DELETE
  markRoomRead(room: string, lastRead: number): Promise<void>;                  // POST /chat/{token}/read

  // WebDAV (Datei-Download für Media-Ingest, verifizierte Signatur) 
  openFileStream(userPath: string): Promise<Readable>;   // GET remote.php/dav/files/{userId}/{userPath}
}
```

**Regeln:**
- **`baseUrl` wird gegen `https://` (oder explizit erlaubtes `http://`) validiert** — kein unbekanntes Schema.
- Kein Request ohne Auth-Header; Token wird nie in URL/Query gesetzt.
- Generischer Fehler-Wrapper: `TalkError` mit stabilem Code (`AUTH_FAILED`, `ROOM_NOT_FOUND`, `NETWORK`, `TIMEOUT`, `HTTP_<code>`, `INVALID_RESPONSE`) — analog `MediaError`.
- OCS-Antwortformat prüfen: `ocs.meta.statuscode` (`100` = ok) vor `ocs.data` auswerten. `Accept: application/json` erzwingt JSON (sonst XML-Risiko).
- Der `setReadMarker=1` wird genutzt, damit das Polling nicht künstlich "Ungelesen"-Zähler hinterlässt.

### 6.2 JSON der Chat-Nachricht → Normalisierung (`TalkChatMessage`)

```ts
export interface TalkRichObject { type: string; id: string; name: string; /* … */ }
export interface TalkChatMessage {
  id: number;
  token: string;
  actorType: string;          // "users" | "bots" | "guests" | "federated_users" | "deleted_users"
  actorId: string;            // Nextcloud-UserID des Senders (bei users)
  actorDisplayName: string;
  timestamp: number;          // Sekunden (UTC)
  systemMessage: string;      // "" für normale Nachrichten
  messageType: "comment" | "comment_deleted" | "system" | "command";
  message: string;            // Rich-Object-String (hat {placeholders})
  messageParameters: Record<string, TalkRichObject>;   // enthält z.B. { file: {…} } bei Datei-Sharing
  referenceId?: string;
  markdown?: boolean;
  lastEditTimestamp?: number;
}
```

### 6.3 Credential-Verwaltung (Sicher, D8)

- **App-Token statt Hauptpasswort:** Der Admin erstellt in Nextcloud → Einstellungen → Sicherheit → "Apps / Geräte" ein **App-Passwort** für den Bot-User. Vorteil: widerrufbar, gilt für OCS, kein Hauptlogin.
- **Speicherort:** 
  1. `platforms.nextcloudTalk.appToken` in `~/.pi/gateway/config.json` — Datei wird vom Gateway bei Seed mit **0600** angelegt (bestehende Config-Security) und via Config-Editor gesetzt.
  2. Oder Umgebungsvariable `NEXTCLOUD_TALK_APP_TOKEN` (überschreibt die Config) — für Container/Secret-Manager.
- **Niemals loggen:** Der `OcsClient` konstruiert den Basic-Header inline; structured Logs enthalten nur `baseUrl` (Host), `userId` und Status — nie das Token. Analog Phase-3-Regel für Telegram-Download-URLs (§11).
- **TLS:** Standard `https://`. Für reines LAN kann `allowInsecureHttp: true` gesetzt werden (explizit, mit Warn-Log beim Start).

### 6.4 UserID-Identifikation im Gateway

- `config.userId` = der Nextcloud-Login des Bot-Accounts; dient: (a) Basic-Auth, (b) **Selbst-Filter** (`actorId !== userId`), (c) WebDAV-Pfad-Basis `remote.php/dav/files/{userId}/…`.
- **`PlatformMessage.userId`** wird aus dem **Sender** gesetzt: `msg.actorId` (bei `actorType==="users"`), sonst `actorDisplayName`/`guests`. Damit funktioniert die bestehende Allowlist (`security.allowedUids["nextcloudTalk"] = [userIds…]`) für den Kanal **ohne Änderung**.

---

## 7. Adapter-Design (`src/adapters/nextcloud-talk.ts`)

### 7.1 Klassen-Skizze

```ts
// src/adapters/nextcloud-talk.ts
import { BaseAdapter, type PlatformConfig, type AdapterCallbacks,
         type InteractivePrompt, type PlatformMessage } from "./base.js";
import { OcsClient } from "./nextcloud/ocs.js";
import { NextcloudTalkPoller, type TalkPollerEvent } from "./nextcloud/poller.js";
import { initTalkStateStore, shutdownTalkStateStore } from "./nextcloud/store.js";
import { logger } from "../logger.js";
import { runtime } from "../state.js";
import { MediaError, type MediaAttachment } from "../media/types.js";
import { initMediaManager } from "../media/manager.js";

export interface NextcloudTalkConfig extends PlatformConfig {
  platform: "nextcloudTalk";
  baseUrl: string;
  userId: string;                 // Nextcloud-Login des Bot-Accounts
  appToken: string;
  rooms: string[];                // Talk-Raum-Token (MVP: explizit)
  pollMode?: "long-poll" | "interval";
  longPollTimeoutSeconds?: number;
  intervalMs?: number;
  backoffMaxMs?: number;
  minPollIntervalMs?: number;
  maxConcurrentPolls?: number;
  allowInsecureHttp?: boolean;
}
```

**Kern (event-basiert → polling-basiert, D6):**

```ts
export class NextcloudTalkAdapter extends BaseAdapter {
  readonly platform = "nextcloudTalk" as const;
  config: NextcloudTalkConfig;
  private ocs!: OcsClient;
  private poller!: NextcloudTalkPoller;
  private connected = false;

  async initialize(): Promise<void> {
    validateConfig(this.config);                  // baseUrl-Schema, Token nicht leer, rooms nicht leer
    this.ocs = new OcsClient({
      baseUrl: this.config.baseUrl,
      userId: this.config.userId,
      appToken: this.config.appToken,
      allowInsecureHttp: this.config.allowInsecureHttp,
    });
    // Initial-Check: /room abrufen, um 401 früh zu erkennen (bestehendes Muster: Telegram /getMe)
    try { await this.ocs.listRooms(); }
    catch (e) { throw new Error(`Nextcloud Talk auth failed: ${msg}`); }
  }

  async start(callbacks: AdapterCallbacks): Promise<void> {
    await super.start(callbacks);
    initTalkStateStore();
    this.poller = new NextcloudTalkPoller(this.ocs, initTalkStateStore());
    this.connected = true;
    this.poller.start(this.config.rooms, {
      onMessage: (msg) => this.handleTalkMessage(msg).catch((e) =>
        logger.error("[NextcloudTalk] handle message failed:", e)),
      onState: (s) => { this.lastState = s; },
    });
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.poller?.stop();
    this.poller = null;
    shutdownTalkStateStore();
    await super.stop();
  }

  /** Polling → Event-Modell: transformiert eine Talk-Nachricht in PlatformMessage & emittiert. */
  private async handleTalkMessage(msg: TalkChatMessage): Promise<void> {
    if (!isPublishable(this.config, msg)) return;          // D4: Selbst-/System-Filter
    const content = resolveRichText(msg);                  // Platzhalter → Klartext
    const attachments = await this.ingestAttachments(msg); // Medien (7.3)

    const message: PlatformMessage = {
      id: this.generateMessageId(),                        // oder msg.id
      platform: "nextcloudTalk",
      channelId: msg.token,                                // Raum-Token
      userId: msg.actorType === "users" ? msg.actorId : msg.actorDisplayName || msg.actorId,
      content,
      timestamp: msg.timestamp * 1000,
      metadata: {
        talkMessageId: msg.id,
        actorType: msg.actorType,
        actorDisplayName: msg.actorDisplayName,
        roomToken: msg.token,
        isEdit: !!msg.lastEditTimestamp,
      },
      attachments: attachments.length ? attachments : undefined,
    };
    await this.emitMessage(message);
  }
  // … sendMessage/editMessage/deleteMessage/setTyping/getStatus/sendInteractive (§7.2)
}
```

### 7.2 Ausgangs-Operationen (Mapping auf OCS)

| `BaseAdapter`-Methode | Talk-OCS-Umsetzung | Hinweis |
|---|---|---|
| `sendMessage(token, content)` | `POST /chat/{token}` → gibt `msg.id` zurück | Returns messageId |
| `editMessage(token, messageId, content)` | `PUT /chat/{token}/{messageId}` | Streaming-Edit (Phase-3-/Bestehender Flow) |
| `deleteMessage(token, messageId)` | `DELETE /chat/{token}/{messageId}` | nur eigene, < 6 h |
| `setTyping(token, isTyping)` | **No-op** (kein REST-Endpoint ohne Signaling) | resolve; dokumentiert als N2 |
| `getStatus()` | `{ connected: this.connected, latency: lastPollLatencyMs }` | |
| `sendInteractive(token, prompt)` | Default `BaseAdapter.sendInteractive` (Text-Format) | N4: keine nativen Buttons im MVP |
| `cleanupInteractive(token, messageId)` | No-op | n/a |

`sendMessage` darf Nachrichten **> 32.000 Zeichen** (> `message-length`-Capability) clientseitig umbrechen (Teilnachrichten) — Talk-Limit laut API (`413`). Pipe-Limit + Error-Handling (§8).

### 7.3 Medien-Inbound (Attachments, D7)

Datei-Sharing in Talk erscheint als **Rich Object** in `msg.messageParameters` mit Typ `file` (bzw. `image`/`video` je nach mimetype; siehe `Shared item types`: `file`, `media`, `audio`, `voice`, `recording`). Das `file`-Objekt enthält u.a. `id` (fileId), `name`, `path` (user-relativer Pfad), `mimetype`, `size`, `link`.

```ts
private async ingestAttachments(msg: TalkChatMessage): Promise<MediaAttachment[]> {
  const files = Object.values(msg.messageParameters ?? {})
    .filter((o) => o && (o.type === "file" || o.type === "media" || o.type === "audio"
                       || o.type === "voice" || o.type === "video" || o.type === "recording"))
    .slice(0, maxAttachmentsPerMessage);
  const out: MediaAttachment[] = [];
  const mediaManager = runtime.media ?? initMediaManager();
  for (const f of files) {
    try {
      const att = await mediaManager.ingest({
        platform: "nextcloudTalk",
        messageId: String(msg.id),
        channelId: msg.token,
        userId: msg.actorId,
        fileRef: f.id,                         // stable file-ID → Dedup-Key
        fileName: f.name,
        declaredMime: (f as { mimetype?: string }).mimetype,
        declaredSizeBytes: (f as { size?: number }).size,
        kindHint: kindForMime((f as { mimetype?: string }).mimetype),
        // Lazy-Download-Closure: WebDAV-Stream als Bot-User (verifiziert via Phase-3-Magic-Bytes)
        fetch: () => this.ocs.openFileStream((f as { path?: string }).path),
      });
      out.push(att);
    } catch (err) {
      logger.warn(`[NextcloudTalk] media ingest failed: ${MediaError.is(err) ? err.code : err}`);
      // E-Fehler wie Phase-3: isoliert; Nachricht läuft weiter (§8)
    }
  }
  return out;
}
```

- **`openFileStream(path)`** streamt aus `remote.php/dav/files/{userId}/{path}` mit Basic-Auth; der `MediaManager` übernimmt Timeout (60 s), 1 Retry, Magic-Byte-Sniffing, Quota, TTL, atomare Speicherung — **komplett wiederverwendet (D7)**.
- **Dedup über `fileRef=file.id`** verhindert, dass dasselbe geteilte File bei wiederholten Polls erneut heruntergeladen wird.
- `kindHint` aus `mimetype` (`image/*`→image, `application/pdf`→document, etc.) — der Manager verifiziert ohnehin.
- **Outbound-Media** (Agent → Datei in den Chat) bleibt N1; Hook: `OcsClient.shareFileToChat(room, userPath, talkMetaData)` via `files_sharing`-Endpoint ist als Folge-Schritt vorbereitet (§10.2).

### 7.4 Text-Rich-Object-Auflösung

`msg.message` ist ein Rich-Object-String mit Platzhaltern wie `{file}`. Für die Pipeline reicht meist Klartext:

```
resolveRichText(msg):
  text = msg.message
  for (key, obj) in msg.messageParameters:
    text = text.replace(`{${key}}`, describe(obj))   // z.B. "[Datei: report.pdf]" oder @Mention-Name
  return text
```

Mentions (`@user`) werden in lesbaren Anzeigenamen aufgelöst; Datei-Platzhalter durch `[Anhang: <name>]` ersetzt (die eigentliche Verarbeitung läuft über `attachmats[]`, §7.3).

---

## 8. Integration in die bestehende Pipeline (PlatformMessage)

**Kein Eingriff in die Pipeline nötig.** Der Adapter erfüllt den `PlatformAdapter`-Vertrag; `emitMessage` → `adapterCallbacks.onMessage` (`message-pipeline.ts`):

```
onMessage(PlatformMessage)
  ├─ Session getOrCreate(channelKey = "<platform>:<channelId>")   // platform="nextcloudTalk"
  ├─ Rate-Limit (allowedUids["nextcloudTalk"]? nein — per-user Lauf)  ← bestehendes Auth greift
  ├─ Allowlist / Pairing (security.allowedUids["nextcloudTalk"] = [userIds]) ← unverändert
  ├─ Meta-Commands (/new, /status, /model…) ← matchen auf content, unverändert
  ├─ buildAttachmentManifest(attachments) + images[] (Base64 bei Bildern) ← Phase-3, unverändert
  └─ sendPromptRpc(promptText, session.id, images?, onStream)
        ▼ pi-Agent
  Antwortstreaming → onStream → collate → adapter.editMessage(channelId=token, messageId, text)
```

**Konsequenzen:**
- **Kanal-Key** = `nextcloudTalk:<room-token>` → jede Talk-Nachricht in einem Raum gehört zu einer Session.
- **User-Key** = Sender-`userId` (`actorId`) → Allowlist/Pairing pro Nextcloud-User funktioniert direkt.
- **Medien** fließen über das Phase-3-Manifest-/`images[]`-System: Bilder multimodal, Dokumente als lokaler Pfad für die Agent-Tools.
- **Dedup gegen at-least-once-Polling:** Die Pipeline ist idempotent genug; zusätzlich wird eine kürzlich verarbeitete `talkMessageId` je Session dedupliziert (siehe §12, Edge-case), um Neu-Emission nach Restart zu glätten (die `talk_state`-Persistenz verhindert das ohnehin in der Regel).

---

## 9. Sicherheit & Ressourcen

### 9.1 Schutz der Nextcloud vor DoS durch Polling (D9)

| Maßnahme | Mechanismus |
|---|---|
| **Efficient idle** | Long-Poll statt Kurzpolling; 1 offener Socket pro Raum (pro Room Loop), kein Timer-Exzess |
| **Max offene Polls** | `maxConcurrentPolls` (Default 4) deckelt parallele Room-Loops |
| **Min-Intervall** | kein Poll < `minPollIntervalMs` (Default 1000 ms) nach letztem Response |
| **Backoff + Circuit Breaker** | exponentieller Backoff (`backoffMaxMs` 60 s); nach `circuitThreshold` Fehlern pausiert der Raum |
| **Kein Discovery-Sturm** | (MVP) Räume fix konfiguriert; `autoDiscoverRooms` nur mit eigenem `roomRefreshIntervalMs` (Default 60 s) |
| **Auth als App-Token** | geringe Berechtigung; bei Missbrauch sofort widerrufbar |
| **Rate-Cap im Code** | `minPollIntervalMs` greift auch im Interval-Modus; Batch-`limit` ≤ 100 pro Poll |

### 9.2 Schutz der Credentials im runtime-Container (D8)

| Bedrohung | Gegenmaßnahme |
|---|---|
| Token-Leak in Logs | `OcsClient` baut Basic-Header inline; Logs enthalten nur Host + `userId`; kein Token/Authorization-Header in Ausgaben |
| Config-Datei lesbar durch Dritte | `config.json` bei Seed mit 0600 (bestehende Sicherheit); Env-Override `NEXTCLOUD_TALK_APP_TOKEN` für Container |
| Token im Arbeitsspeicher/Heap | Token liegt nur auf `runtime.config.platforms.nextcloudTalk.appToken` (Readonly-feld), kein Copy in Logs/Fehlerobjekte |
| Main-Passwort statt App-Token | Konfiguration dokumentiert strikt App-Token; Validierung weist auf App-Token hin |
| HTTP statt HTTPS (Sniffing im LAN) | Default `https://`; `allowInsecureHttp` nur explizit, mit Start-Warn-Log |

### 9.3 Weitere Sicherheit
- **Rich-Object-Pfad-Validierung:** `f.path` aus `messageParameters` ist server-geliefert; der Media-Download läuft ausschließlich über den **WebDAV-Endpoint des Bots** (kein beliebiger URL-Fetch), und `MediaManager` sniffed Magic-Bytes + generiert Speichernamen → **keine Path-Traversal-/MIME-Spoofing-Vektoren** außerhalb des bereits gehärteten Phase-3-Stacks.
- **Room-Access:** Nur konfigurierte, vom Bot-User verfügbare Räume; `ROOM_NOT_FOUND`/`403` → circuit-break + klarer Status.

---

## 10. Konfiguration

**Neuer Block in `GatewayConfig.platforms` (`src/types.ts`) + `DEFAULT_CONFIG` (`src/config.ts`) + `config/config.default.json`:**

```ts
platforms: {
  // …bestehende…
  nextcloudTalk?: {
    enabled: boolean;
    baseUrl: string;                // https://nextcloud.local oder https://nextcloud.example.com
    userId: string;                 // Nextcloud-Login des Bot-Accounts
    appToken: string;               // App-Passwort (App-Token); Env-Override NEXTCLOUD_TALK_APP_TOKEN
    rooms: string[];                // Talk-Raum-Token (stabiles Identifier)

    // Polling
    pollMode?: "long-poll" | "interval";     // default "long-poll"
    longPollTimeoutSeconds?: number;         // default 30 (0–60)
    intervalMs?: number;                     // default 5000 (nur pollMode="interval")
    minPollIntervalMs?: number;              // default 1000
    backoffMaxMs?: number;                   // default 60000
    maxConcurrentPolls?: number;             // default 4
    circuitThreshold?: number;               // default 5

    // Discovery (optional)
    autoDiscoverRooms?: boolean;             // default false (MVP: false)
    roomRefreshIntervalMs?: number;          // default 60000

    // Security
    allowInsecureHttp?: boolean;             // default false
    // Media (optional, vererbt von media.*)
    maxAttachmentsPerMessage?: number;       // default media.maxAttachmentsPerMessage
  };
}
```

**Config-Validierung** in `mergeGatewayConfig` (analog Media-Block, §5.2):
- `baseUrl` vorhanden & Schema `https://` (oder `http://` nur wenn `allowInsecureHttp`, sonst Fehler).
- `userId`, `appToken` nicht leer; `rooms` nicht leer & Array aus Strings (MVP).
- `longPollTimeoutSeconds` ∈ [0,60]; `pollMode` ∈ {long-poll, interval}; alle Intervalle/Zahlen > 0; `maxConcurrentPolls` Integer ≥ 1.
- `appToken` darf nicht `"…"`/Platzhalter-Wert sein (Guard gegen unkonfigurierte Seeds).

### 10.1 Umgebungsvariablen
| Env | Zweck |
|---|---|
| `NEXTCLOUD_TALK_APP_TOKEN` | überschreibt `platforms.nextcloudTalk.appToken` (Secret-Manager/Container) |
| `GATEWAY_TALK_STATE_DIR` | Test-Override für `talk_poll_state.db` (Muster wie `GATEWAY_DB_DIR`/`PI_MEDIA_DIR`) |

### 10.2 Ausbaustufen (nicht MVP)
- **Auto-Discovery (`autoDiscoverRooms`):** `GET /room` + `X-Nextcloud-Talk-Modified-Before` auf `roomRefreshIntervalMs`; Room-Set diffen gegen `talk_poll_state`; Verhalten bei neuem Raum mit leerem Wasserstand dokumentieren.
- **Outbound-Media:** `OcsClient.shareFileToChat()` (Datei in User-Root hochladen via WebDAV PUT, dann `files_sharing`/`shares` mit `shareType=10` + `talkMetaData.caption`). Basis für eine spätere "Agent sendet Datei zurück"-Phase.
- **Interactive-Buttons:** Talk bietet `object_shared` (Poll/Buttons) — nur als Rich-Object-Ansatz, großes Zusatzprotokoll → bewusst spät.

---

## 11. Fehlerbehandlung

Prinzip wie Phase-3: **Fehler isolieren, Nachrichtenpfad am Leben halten.**

| # | Szenario | Erkennung | Verhalten | User/Status |
|---|---|---|---|---|
| N1 | Auth fehlgeschlagen (401/403) | `listRooms`-Init oder Poll | Adapter-Init wirft → Adapter-Registry loggt, Kanal bleibt deaktiviert | `[gateway] Nextcloud Talk auth failed …` |
| N2 | Raum nicht (mehr) verfügbar / 404 | Poll | Raum-Circuit-break; übrige Räume laufen weiter | Status: Raum `ROOM_NOT_FOUND` |
| N3 | Netzwerk/Timeout bei Long-Poll | `TalkError("NETWORK"/"TIMEOUT")` | exponentieller Backoff; Socket neu aufbauen | intern |
| N4 | Ständig Fehler | Circuit Breaker (≥ threshold) | Raum pausiert, periodisch neu versucht | `getStatus()` zeigt degraded |
| N5 | Datei-Anhang fehlerhaft (Download/Type/Quota) | `MediaError` | pro Attachment: Warn-Log, Rest läuft; ggf. Hinweistext in den Chat | `⚠️ Datei … konnte nicht verarbeitet werden.` |
| N6 | Nachricht > Talk-Limit (32k) beim Senden | HTTP 413 | Nachricht in Teilnachrichten brechen | kein Fehler für User |
| N7 | Restart während Verarbeitung | `talk_state` erst nach Erfolg persistiert | at-least-once: Nachricht ggf. erneut | idempotente Pipeline |
| N8 | `setTyping`/`sendInteractive`-UI n/a | No-op / Text-Fallback | kein Fehler | dokumentiert (N2/N4) |

---

## 12. Teststrategie (Vitest, bestehendes Setup)

| Suite | Abdeckung | Methodik |
|---|---|---|
| `tests/adapters/nextcloud/ocs.test.ts` | Auth-Header (Basic, nie Token im Log), Request-Bau, OCS-Statuscode-Auswertung, JSON/Fehler-Parsing, `openFileStream` (WebDAV-Pfad-Bildung) | gemocktes `fetch`; keine echte Nextcloud |
| `tests/adapters/nextcloud/poller.test.ts` | Long-Poll-Modus (304/200), Intervall-Modus, Backoff-Verhalten, `minPollIntervalMs`, Circuit Breaker, Wasserstands-Persistenz (nach Erfolg), Fehler-Reset | Fake `OcsClient` + `talk_state` in tmp-Dir |
| `tests/adapters/nextcloud/store.test.ts` | `talk_poll_state` CRUD, Warm-Start-Load, Room-Prune | `GATEWAY_TALK_STATE_DIR` tmp |
| `tests/adapters/nextcloud-talk.test.ts` | `isPublishable` (Selbst/System/Command-Filter — **Anti-Loop-Core**), `resolveRichText`, `ingestAttachments` (file/missing/oversize → gedrosselt), `PlatformMessage`-Mappings (userId, channelId, metadata) | Mock-Klient + Mock-MediaManager |
| `tests/core/pipeline-nextcloud.test.ts` | `emitMessage` → Allowlist (per `nextcloudTalk`-Uid), Sessions, Media-`discard` bei Ablehnung | bestehende Pipeline-Mocks |
| **E2E (manuell, Phase-2.5-Stil)** | echte lokale Nextcloud: Nachricht empfangen, Antwort senden+stream-edit, Bild/PDF verarbeiten, eigenen Bot-Output NICHT re-pollt (Loop-Test), Restart ohne Duplikat | Checklist `docs/phase4-e2e.md` |

**Fokus auf den Anti-Loop-Test** (N1-Korrektheit): Ein Test, in dem der Bot eine eigene Nachricht sendet und verifiziert wird, dass sie nicht erneut als `onMessage` emittiert wird.

---

## 13. Implementierungsplan

| Schritt | Inhalt | Dateien | Aufwand |
|---|---|---|---|
| S1 | `OcsClient` + Typen + Tests | `src/adapters/nextcloud/ocs.ts`, `talk-types.ts`, Tests | 1 d |
| S2 | `talk_state`-Store + Tests | `src/adapters/nextcloud/store.ts`, Tests | 0.5 d |
| S3 | `NextcloudTalkPoller` (Long-Poll/Interval/Backoff/Circuit-Breaker) + Tests | `src/adapters/nextcloud/poller.ts`, Tests | 1 d |
| S4 | `NextcloudTalkAdapter` (start/send/edit/delete/status, `isPublishable`, `resolveRichText`, `ingestAttachments`) + Tests | `src/adapters/nextcloud-talk.ts`, Tests | 1 d |
| S5 | Config (`types.ts`, `config.ts`, `config.default.json`), Registry-Wiring (`registry.ts`), Daemon-Shutdown (`daemon.ts`: stopAdapters → shutdownTalkStateStore) | je 1 Datei | 0.5 d |
| S6 | Pipeline-Smoke, Anti-Loop-Edge-Test, Dokumentation (README), ROADMAP-Checkboxen | Doku + Tests | 0.5–1 d |
| S7 | E2E gegen echte LAN-Nextcloud (Empfangen, Antworten, Media, Loop-Freiheit, Restart) | Checklist `docs/phase4-e2e.md` | 0.5–1 d |

**Gesamt: ca. 4–6 Werktage**, strikt sequenziell (S3↔S2, S4 an S3, S5/S6 an S4).

---

## 14. Risiken, offene Fragen & Annahmen

### Risiken
| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| **Loop durch eigene Nachrichten** (wenn Filter-Logik lückenhaft) | niedrig | hoch | `talk_state`-Offset + zentraler `isPublishable` (D4) + expliziter E2E-Anti-Loop-Test (S6/S7) |
| Talk-API-Version / `lookIntoFuture` nicht unterstützt (alte Talk) | niedrig | mittel | Intervall-Fallback + Capability-Check beim Init |
| At-least-once nach Restart → Duplikat | mittel | niedrig | `talk_state` persistiert nach Erfolg; Pipeline-Idempotenz; kürzliche-ID-Dedup |
| Große Datei-Anhänge belasten LAN/Platte | mittel | mittel | Phase-3-Quota/TTL/Größen-Caps wiederverwendet; schlechter Download isoliert |
| Basic-Auth-Token bei insecure HTTP im LAN | niedrig (LAN) | mittel | Default `https://`; Warn-Log bei `allowInsecureHttp` |
| Room-Token stabil? (Nach Raum-Umbau ändert sich Token) | niedrig | niedrig | Konfiguration dokumentiert; `ROOM_NOT_FOUND`→klar sichtbar |

### Offene Fragen (Entscheidung vor S1)
1. **Räume:** ausschließlich explizit konfiguriert (MVP) oder früher als gedacht `autoDiscoverRooms`? Empfehlung: MVP explizit.
2. **Nachrichten > 32k:** automatisch in Teilnachrichten brechen (empfohlen) oder hard-fail mit 413-Hinweis?
3. **Own-Self-Filter im Restart-Szenario:** `talk_state.last_known_msg_id` enthält auch eigene Nachrichten-IDs → Offset überspringt sie korrekt. Muss im E2E bestätigt werden, dass wir nie selbst getriggerte Antworten erneut verarbeiten.
4. **`/gateway status`-Erweiterung:** Talk-Statuszeile (`Rooms: N, Polling: ok, letzte Poll-Latenz`)? Empfehlung: ja, einzeilig, < 1 h Aufwand.

### Annahmen (explizit)
- **A1:** Nextcloud-Instanz ≥ 13 mit **Talk-App aktiv** und **OCS-API erreichbar** unter `baseUrl/ocs/v2.php/…`. Der Bot-User ist Mitglied der konfigurierten Räume.
- **A2:** Node ≥ 20 (Projekt-Requirement) → `fetch`, `Readable.fromWeb`, `AbortSignal.timeout` verfügbar (keine neue HTTP-Dependency nötig).
- **A3:** Der `media/`-Stack aus Phase 3 ist wie dokumentiert vorhanden und kann ohne Änderung `platform:"nextcloudTalk"` verarbeiten (Registry ist platform-agnostisch, `sanitizeSegment(platform)` normalisiert auf `nextcloudTalk`-Verzeichnis).
- **A4:** Konfigurierte Räume sind **ungefährdete** Chats; Talk-Polling erzeugt keinen unerwünschten "Online"-Status beim Bot-User aus (ggf. `noStatusUpdate`-Param prüfen).
- **A5:** Kein gleichzeitiger multi-Instanz-Betrieb desselben Bot-Accounts (nur ein Gateway pollt aktive Räume), sonst konkurrieren zwei `last_known_msg_id`-Kurven.

---

## 15. Abnahme-Kriterien (Definition of Done, Phase 4)

- [ ] Nachricht aus konfiguriertem Talk-Raum erreicht den Pi-Agenten (Responsive-Antwort, streaming-edit im Raum).
- [ ] **Kein Endlos-Loop:** Bot-Antworten werden nicht erneut als Eingabe verarbeitet (E2E + Unit-Test grün).
- [ ] Restart des Daemons → keine alten Nachrichten erneut verarbeitet (Warm-Start via `talk_state`).
- [ ] Bild/Dokument aus Talk → Agent verarbeitet es (Bild multimodal / Pfad-Manifest), isolierte Fehler bei ungültiger Datei.
- [ ] DoS-Kontrolle: Idle-Polling nutzt Long-Poll mit ≤ `maxConcurrentPolls` offenen Sockets; Backoff/Circuit-Breaker auf Fehler.
- [ ] Credentials: `appToken` nie in Logs; `https://` default; Init-Fehler (401) → Kanal sauber deaktiviert mit klarer Meldung.
- [ ] Allowlist/Pairing/Rate-Limit über `security.allowedUids["nextcloudTalk"]` funktioniert ohne Pipeline-Änderung.
- [ ] `npm run lint && npm run test && npm run build` grün; Coverage für `src/adapters/nextcloud*` ≥ 80 %.
- [ ] ROADMAP-Phase-4-Checkboxen gesetzt; README (Features, Config, Sicherheit) synchronisiert.

*— Ende des Konzepts —*
