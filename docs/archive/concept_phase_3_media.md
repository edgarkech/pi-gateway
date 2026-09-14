# Phase 3: Input Expansion (File-Attachments) — Technisches Konzept

**Projekt:** `pi-gateway` (`~/.pi/projects/pi-gateway/`)
**Status:** Entwurf zur Freigabe (vor Implementierung)
**Datum:** 2026-08-21
**Autor:** PiWorker (Rolle: Architect)
**Basis-Analyse:** `src/types.ts`, `src/adapters/base.ts`, `src/adapters/telegram.ts`, `src/core/message-pipeline.ts`, `src/core/rpc.ts`, `src/state.ts`, `src/config.ts`, `src/paths.ts`, `src/sessions/store.ts`, `ROADMAP.md`, pi-coding-agent `docs/rpc.md` (v0.84.2)

---

## 1. Executive Summary

Phase 3 ermöglicht es dem Pi-Agenten, Dateien (Bilder, Dokumente, Audio), die über Kommunikationskanäle (MVP: Telegram) gesendet werden, zu verarbeiten.

**Kernentscheidungen:**

| # | Entscheidung | Begründung (Kurzform) |
|---|---|---|
| D1 | `PlatformMessage` um optionales `attachments?: MediaAttachment[]` erweitern | Backward-kompatibel; Adapter bleiben die einzigen Erzeuger von Attachments |
| D2 | Zentrales `src/media/`-Modul mit `MediaManager`-Singleton (Ingest, Registry, Validation, Cleanup) | Eine Stelle für Speicher/Security/TTL; Adapter bleiben dünn und platform-spezifisch |
| D3 | Download **eager im Adapter** (vor `emitMessage`), Lazy-Fetch-Closure wird an den MediaManager übergeben | Adapter kennt seine eigene API; `PlatformMessage` bleibt serialisierbares Plain-Data |
| D4 | Speicherung unter `~/.pi/runtime/media/<platform>/<yyyy-mm>/<mediaId><ext>` + SQLite-Registry | TTL-Cleanup, Quota-Eviction, Dedup via platform-spezifischem `fileRef` |
| D5 | Sicherheit: MIME-Allowlist **+ Magic-Byte-Sniffing** (Sniffed schlägt Declared), Größen-Caps, 0700/0600-Permissions, generierte Filenamen | Schutz vor MIME-Spoofing, Path Traversal, Speicher-Exhaustion |
| D6 | **Bilder** per nativem `images`-Feld des pi-RPC-Protokolls als Base64 in den Prompt; **Dokumente/Audio** nur als lokaler Pfad im Manifest | pi ≥ 0.84 unterstützt `prompt.images` nativ → **null Änderungen an pi-Agent/Extension**; Agent verarbeitet Dokumente selbst mit seinen Tools |
| D7 | Prompt-Materialisierung: strukturiertes Attachment-Manifest vorangestellt dem Prompt-Text | Entspricht Roadmap-Punkt „Prompt-Materialisierung"; Modell weiß, wo Dateien liegen |
| D8 | Fehlerbehandlung pro Attachment isoliert (1× Retry, dann Notify + Weitermachen); abgelehnte Nachrichten → `discard()` | Ein defektes Attachment blockiert nicht die Nachricht; kein Speicher-Leak für gesperrte User |

**Scope-MVP:** Telegram-Adapter (photo, document, audio, video). Discord/WhatsApp nutzen dasselbe Ingest-API in Folge-Phasen (§9.4). Outbound-Media ist **kein** Teil von Phase 3.

---

## 2. Ist-Zustand & relevante Befunde

### 2.1 Aktuelle Nachrichtenfluss

```
Telegram-Update ──► TelegramAdapter.handleUpdate()
                        │  content = msg.text || msg.caption || ""
                        │  if (!content) return;      ← ⚠️ reine Medien-Nachrichten werden verworfen
                        ▼
                   emitMessage(PlatformMessage)
                        ▼
        adapterCallbacks.onMessage (core/message-pipeline.ts)
                        │  Session → Rate-Limit → Allowlist → Meta-Commands
                        ▼
        sendPromptRpc(`${guard}\n\n${message.content}`, session.id, onStream)
                        ▼
        rpc.ts: sendRpc("prompt", { message, sessionId })  → pi stdin (JSONL)
                        ▼
                   pi-Agent (RPC-Modus)
```

### 2.2 Wichtige Befunde

1. **`PlatformMessage` lebt in `src/adapters/base.ts`, nicht in `src/types.ts`.**
   `src/types.ts` enthält heute nur `GatewayConfig` und `GatewayState`. Das Task-Briefing nennt `types.ts`; das Interface selbst ist in `base.ts` definiert und von allen Adattern importiert. → **Entscheidung: Interface bleibt in `base.ts`** (kein breaking Move); neue Media-Typen kommen nach `src/media/types.ts` mit optionalem Re-Export aus `src/types.ts` (§5.3).

2. **Reine Medien-Nachrichten fallen heute durch das Raster.**
   `telegram.ts`: `const content = msg.text || msg.caption || ""; if (!content) return;` — Fotos ohne Caption werden komplett ignoriert. Phase 3 muss diese Stelle neu aufschlüsseln (Text XOR Medien XOR beides, §9.2).

3. **Das pi-RPC-Protokoll unterstützt Bilder nativ.** (Quelle: `@earendil-works/pi-coding-agent@0.84.2`, `docs/rpc.md`, Abschnitt „prompt“):
   ```json
   {"type": "prompt", "message": "What's in this image?",
    "images": [{"type": "image", "data": "<base64>", "mimeType": "image/png"}]}
   ```
   Das bedeutet: **Keine pi-seitige Extension, kein Custom-Protokoll** für Bilder. `rpc.ts` reicht `images` lediglich in den `sendRpc("prompt", …)`-Payload durch (der wird ohnehin per Spread gebaut).

4. **pi kennt zudem einen strukturierten `Attachment`-Typ** (`id, type, fileName, mimeType, size, content, extractedText, preview`) — primär für TUI-Modi. Im RPC-Pfad nutzen wir `images` + Pfad-Manifest; der Typ bleibt Referenz für spätere Ausbaustufen (Outbound, Previews).

5. **Bestehende Patterns, die wiederverwendet werden:**
   - **SQLite-Singleton** (`better-sqlite3`, bereits Dependency) mit Env-Override für Tests: `sessions/store.ts` nutzt `GATEWAY_DB_DIR`. → Media-Registry folgt exakt diesem Pattern (`PI_MEDIA_DIR`).
   - **`runtime`-Container** (`src/state.ts`) als Single Source of Truth für mutable State.
   - **Config-Merge** in `src/config.ts` (`DEFAULT_CONFIG` + `mergeGatewayConfig` + Validierung) → neuer `media`-Block (§10).
   - **Adapter-Registry/Init-Punkte** (`registry.ts`, `index.ts`, Daemon-Bootstrap) → Initialisierung des MediaManagers hängt an die bestehenden Init-Punkte.

6. **Telegram-Limits (Bot API):** Bots können Dateien bis **20 MB** herunterladen. Medien-Felder im Update: `photo[]` (mehrere Auflösungen), `document`, `audio`, `video`, `animation`, `voice`. Download-Flow: `file_id` aus dem Update → `POST /getFile` → `file_path` → `GET https://api.telegram.org/file/bot<token>/<file_path>`.
   *Annahme (zu verifizieren, §14):* Telegram stellt Dateien über die Bot-API nur für begrenzte Zeit (~1 Tag) zum Download bereit. Konsequenz: **Download unmittelbar bei Nachrichteneingang** — kein „lazy download am Prompt-Zeitpunkt".

---

## 3. Ziele & Nicht-Ziele

### Ziele (Phase 3 MVP)
- **G1:** Telegram-Nutzer senden Bilder, Dokumente und Audio; der Agent erhält sie verarbeitetbar.
- **G2:** Zentrales, getestetes `media/`-Modul mit Speicher, Validierung, TTL-Cleanup und Quota.
- **G3:** Bilder erreichen das LLM **multimodal** (natives `images`-Feld); Dokumente/Audio als lokal verankerte Pfade.
- **G4:** Fehlende/defekte Anhänge degradieren kontrolliert (User-Feedback, kein Crash, kein Speicher-Leak).
- **G5:** Backward-Kompatibilität: Nachrichten ohne Attachments laufen unverändert durch die bestehende Pipeline.

### Nicht-Ziele (explizit)
- **N1:** Outbound-Media (Agent sendet Dateien zurück in den Chat) → spätere Phase.
- **N2:** PDF-/DOCX-Textextraktion *im Gateway* (OCR, Parser) → Agent nutzt seine eigenen Tools (`read`, `bash` inkl. `pdftotext` etc.).
- **N3:** Discord/WhatsApp-Media im MVP (Design vorbereitet, §9.4).
- **N4:** Video-Inlining ins LLM (Videos nur als Pfad; ob das Modell sie „sehen“ kann, hängt vom Provider ab — i. d. R. nicht; der Agent kann Frames via bash ziehen).
- **N5:** Multi-Datei-Zip-Uploads mit Extraktion im Gateway.

---

## 4. Architektur-Überblick (Zielzustand)

```
┌───────────────────────────── pi-gateway Prozess ─────────────────────────────┐
│                                                                             │
│  Telegram-Update (photo/document/…)                                         │
│        ▼                                                                    │
│  TelegramAdapter.handleUpdate()                                             │
│   ├─ extractTelegramMedia(msg) → MediaCandidate[]                           │
│   └─ for each: mediaManager.ingest(MediaIngestRequest) ────────┐            │
│        │  (fetch-Closure: /getFile + HTTP-Download)            │            │
│        ▼                                                       ▼            │
│  PlatformMessage { content, attachments[] }      ┌────────────────────────┐ │
│        ▼                                         │   src/media/           │ │
│  adapterCallbacks.onMessage                      │   (MediaManager)       │ │
│   ├─ Session / Rate-Limit / Allowlist            │                        │ │
│   │    └─ bei Ablehnung: mediaManager.discard() ◄┤  ingest(): Pre-Checks, │ │
│   ├─ buildAttachmentManifest(attachments)        │  Download (stream),    │ │
│   ├─ images[] = Base64 der inlinierten Bilder    │  Sniffing, Quota,      │ │
│   └─ sendPromptRpc(text, sessionId, images, …)   │  Registry-Insert       │ │
│        ▼                                         │  sweep(): TTL/Quota    │ │
│  rpc.ts → sendRpc("prompt",                      │  discard(ids)          │ │
│              { message, sessionId, images })      └───────────┬────────────┘ │
│        ▼                                                      │             │
└────────┼──────────────────────────────────────────────────────┼─────────────┘
         ▼                                                      ▼
   pi-Agent (RPC)                                  ~/.pi/runtime/media/
   • Bilder: nativ multimodal                      <platform>/<yyyy-mm>/…
   • Dokumente: Agent liest Pfad                   registry.db (SQLite)
     mit read/bash-Tools
```

**Modulstruktur (neu):**

```
src/media/
├── types.ts       # MediaKind, MediaAttachment, MediaIngestRequest, ImageContent, MediaError
├── validate.ts    # MIME-Allowlist, Magic-Byte-Sniffing, Filename-Sanitization
├── registry.ts    # SQLite media_files-Table (Pattern aus sessions/store.ts)
├── cleanup.ts     # TTL-Sweep, Quota-Eviction, Orphan-.part-Cleanup
├── manifest.ts    # buildAttachmentManifest() → Prompt-Text
├── manager.ts     # MediaManager: ingest / discard / sweep / stats + Singleton-Init
└── index.ts       # Public Exports
```

**Betroffene Bestandsdateien:** `src/adapters/base.ts`, `src/adapters/telegram.ts`, `src/core/message-pipeline.ts`, `src/core/rpc.ts`, `src/types.ts`, `src/config.ts`, `config/config.default.json`, `src/index.ts` (+ Daemon-Bootstrap), `README.md`.

---

## 5. Interface-Design

### 5.1 Neue Media-Typen (`src/media/types.ts`)

```ts
import type { Readable } from "node:stream";

/** Kategorien, die der Agent verarbeiten soll. */
export type MediaKind = "image" | "document" | "audio" | "video";

/**
 * Validierter, lokal gespeicherter Anhang.
 * Plain-Data (serialisierbar) — bewusst OHNE Funktionen/Closures,
 * damit PlatformMessage loggbar/serialisierbar bleibt.
 */
export interface MediaAttachment {
  /** Stabile ID, z. B. "med_3fa85f6405e9c1d2" (16 hex chars) */
  id: string;
  kind: MediaKind;
  /** Verifizierter MIME-Typ (Magic-Byte-Sniffing schlägt deklarierten Typ) */
  mimeType: string;
  /** Originaldateiname, sanitized — nur Metadaten, NICHT für den Speicherpfad */
  fileName: string;
  sizeBytes: number;
  /** Absoluter lokaler Pfad im Media-Store */
  localPath: string;
  /** Provenienz — für Dedup und (theoretisches) Re-Download */
  source: {
    platform: string;   // "telegram" | "discord" | …
    messageId: string;  // Plattform-Meldungs-ID
    fileRef: string;    // opake Plattform-Referenz (z. B. Telegram file_id)
  };
}

/**
 * Ingest-Anfrage vom Adapter an den MediaManager.
 * `fetch` ist die einzige nicht-serialisierbare Komponente und bleibt
 * bewusst im Adapter-Kontext (plattform-spezifischer Download).
 */
export interface MediaIngestRequest {
  platform: string;
  messageId: string;
  /** Opake, stabile Plattform-Referenz (Dedup-Key) */
  fileRef: string;
  fileName?: string;
  /** Deklarierter MIME — UNVERTRAUENSWÜRDIG, wird verifiziert */
  declaredMime?: string;
  /** Deklarierte Größe — UNVERTRAUENSWÜRDIG, wird beim Streamen verifiziert */
  declaredSizeBytes?: number;
  kindHint?: MediaKind;
  /** Lazy-Download-Funktion des Adapters (Stream bevorzugt) */
  fetch: () => Promise<Readable | Buffer>;
}

/** Pi-RPC ImageContent (Format lt. pi docs/rpc.md, v0.84.2) */
export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

/** Strukturierte Fehler mit stabilem Code für Adapter-UX und Tests. */
export class MediaError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_TYPE"   // MIME/Signatur nicht erlaubt
      | "SIZE_EXCEEDED"      // > maxFileSizeBytes (deklariert oder gemessen)
      | "DOWNLOAD_FAILED"    // Netzwerk/HTTP-Fehler (nach Retry)
      | "VALIDATION_FAILED"  // Sniffing unklar / Inkonsistenz
      | "QUOTA_EXCEEDED"     // Speicher-Quota nicht erfüllbar
      | "TIMEOUT",           // Download-Timeout
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}
```

### 5.2 `PlatformMessage`-Erweiterung (`src/adapters/base.ts`)

```ts
import type { MediaAttachment } from "../media/types.js";

export interface PlatformMessage {
  id: string;
  platform: string;
  channelId: string;
  userId: string;
  /** Textinhalt — DARF LEER SEIN, wenn die Nachricht nur Anhänge hat */
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  /** Phase 3: lokal gespeicherte, validierte Anhänge (optional, backward-kompatibel) */
  attachments?: MediaAttachment[];
}
```

**Regeln:**
- `attachments` optional → alle bestehenden Adapter/Tests laufen unverändert weiter.
- Invariante: `content === "" && (!attachments || attachments.length === 0)` darf nie emittiert werden (Adapter-Pflicht, §9.2).
- Die Pipeline behandelt `content === ""` mit Attachments als gültige Nachricht (§7.3).

### 5.3 Anmerkung zu `src/types.ts`

`src/types.ts` erhält **keine** Verschiebung von `PlatformMessage` (bleibt in `base.ts`, wo es historisch und import-seitig verankert ist). Optionaler Komfort-Export für zentrale Typ-Imports:

```ts
// src/types.ts (optional, kein Breaking Change)
export type { MediaAttachment, MediaKind, MediaIngestRequest, ImageContent } from "./media/types.js";
```

---

## 6. Media-Modul-Architektur

### 6.1 `MediaManager` — öffentliche API

```ts
// src/media/manager.ts
export interface MediaManager {
  /**
   * Lädt die Datei herunter, validiert, speichert und registriert sie.
   * Dedup: identisches (platform, fileRef) innerhalb der Retention →
   * wird NICHT erneut heruntergeladen (Cache-Hit).
   * Wirft MediaError mit stabilem Code bei jedem Ablehnungsfall.
   */
  ingest(req: MediaIngestRequest): Promise<MediaAttachment>;

  /** Löscht Datei(en) + Registry-Eintrag(e). Idempotent. */
  discard(ids: string[]): Promise<void>;

  /** TTL-/Quota-Sweep. Rückgabe für Logging/Status. */
  sweep(now?: number): Promise<{ deletedFiles: number; freedBytes: number }>;

  /** Speichernutzung (für /gateway status, Tests). */
  stats(): Promise<{ fileCount: number; totalBytes: number; oldestAt: number | null }>;
}

/** Singleton-Init — wird in index.ts + Daemon-Bootstrap aufgerufen. */
export function initMediaManager(mediaConfig?: GatewayConfig["media"]): MediaManager;
```

**Interner Ingest-Flow (sequenziell, pro Attachment):**

```
ingest(req)
 ├─ 1. Pre-Check Größe:   req.declaredSizeBytes > maxFileSizeBytes → SIZE_EXCEEDED (kein Download)
 ├─ 2. Pre-Check MIME:    req.declaredMime gesetzt && nicht in Allowlist → UNSUPPORTED_TYPE (kein Download)
 ├─ 3. Dedup-Check:       Registry[(platform, fileRef)] aktiv? → frühes Return (bestehender Pfad)
 ├─ 4. Quota:             totalBytes + geschätzte Größe > maxTotalBytes?
 │                        → evictOldest() (FIFO über created_at), erneut prüfen
 │                        → nicht erfüllbar? → QUOTA_EXCEEDED
 ├─ 5. Download:          req.fetch() mit AbortSignal.timeout(60 s)
 │                        → Stream nach <tmp>.part, Byte-Counter
 │                        → Counter > maxFileSizeBytes → abort, .part löschen, SIZE_EXCEEDED
 │                        → HTTP/Netzfehler → 1 Retry (Backoff 2 s) → DOWNLOAD_FAILED
 ├─ 6. Validierung:       Magic-Byte-Sniff (erste 32 Bytes) → verifizierter MIME + Kind
 │                        → verifizierter MIME nicht erlaubt? → .part löschen, UNSUPPORTED_TYPE
 │                        → Sniff unklar && deklariert nicht erlaubt? → VALIDATION_FAILED
 ├─ 7. Persist:           rename <tmp>.part → finaler Pfad (atomar, Mode 0600)
 │                        → Registry-Insert (Dedup-Key UNIQUE)
 └─ 8. Return MediaAttachment
```

**In-Flight-Dedup:** `Map<fileRef, Promise<MediaAttachment>>` verhindert doppelte Downloads derselben Datei innerhalb kurzer Zeit (z. B. gleiche Datei in zwei Chats).

### 6.2 Speicherlayout

```
~/.pi/runtime/                        ← neu; wird vom Gateway mit 0700 angelegt
└── media/                            ← 0700; Env-Override: PI_MEDIA_DIR (Test-Pattern wie GATEWAY_DB_DIR)
    ├── registry.db                   ← SQLite (better-sqlite3), WAL-Modus
    ├── telegram/
    │   └── 2026-08/                  ← Monats-Buckets (manuelle Inspektion, bounded dirs)
    │       ├── med_3fa85f6405e9c1d2.jpg
    │       └── med_b21c9e07aa44d3e1.pdf
    ├── discord/
    │   └── 2026-08/
    └── whatsapp/
        └── 2026-08/
```

**Begründung:**
- `<platform>`-Ebene: Isolation, pro-Plattform-Aufräumstrategien, klare Attributbarkeit.
- `<yyyy-mm>`-Buckets: verhindert Flat-Directories mit >10k Dateien; unterstützt manuelles Cleanup; TTL ist ohnehin ≪ 1 Monat.
- **Generierte Filenamen** (`med_<16hex><ext>`): Originalnamen sind angreiferkontrollierte Metadaten (Path Traversal, Unicode-Tricks, Log-Injection). Der Originalname existiert nur als sanitized Metadaten-Spalte in der Registry.
- `registry.db` liegt **neben** den Dateien: ein einziger `rm -rf ~/.pi/runtime/media/` macht alles konsistent wieder sauber.

**Registry-Schema (SQLite):**

```sql
CREATE TABLE IF NOT EXISTS media_files (
  id            TEXT PRIMARY KEY,          -- "med_…"
  platform      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,             -- Plattform-Meldungs-ID
  file_ref      TEXT NOT NULL,             -- opake Plattform-Referenz (Dedup)
  file_name     TEXT NOT NULL,             -- sanitized Originalname
  mime_type     TEXT NOT NULL,             -- VERIFIZIERTER Typ
  kind          TEXT NOT NULL,             -- image|document|audio|video
  size_bytes    INTEGER NOT NULL,
  local_path    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,          -- epoch ms
  expires_at    INTEGER NOT NULL,          -- created_at + retentionHours
  UNIQUE (platform, file_ref)              -- Dedup-Key
);
CREATE INDEX IF NOT EXISTS idx_media_expires ON media_files (expires_at);
```

### 6.3 Dateityp-Validierung (Sicherheit)

**Schicht 1 — Konfigurierte Allowlist** (`media.allowedMimeTypes`, Default in §10). Der deklarierte MIME aus der Plattform gilt als *Hinweis*, nicht als Wahrheit.

**Schicht 2 — Magic-Byte-Sniffing** (`validate.ts`, liest die ersten 32 Bytes der geladenen Datei):

| Signatur (hex) | Ergebnis |
|---|---|
| `FF D8 FF` | `image/jpeg` |
| `89 50 4E 47 0D 0A 1A 0A` | `image/png` |
| `47 49 46 38` (`GIF8`) | `image/gif` |
| `52 49 46 46 … 57 45 42 50` (Offset 8) | `image/webp` |
| `25 50 44 46` (`%PDF`) | `application/pdf` |
| `50 4B 03 04` (`PK..`) | ZIP-Container → Sub-Erkennung über Einträge im Central Directory: `word/`→docx, `xl/`→xlsx, `ppt/`→pptx, `mimetype`→odt, sonst `application/zip` |
| `4F 67 67 53` (`OggS`) | `audio/ogg` |
| `49 44 33` (`ID3`) oder Frame-Sync `FF Ex/Fx` | `audio/mpeg` |
| Offset 4: `66 74 79 70` (`ftyp`) | `video/mp4` / `audio/mp4` (per Brand, z. B. `M4A `) |
| `52 49 46 46 … 57 41 56 45` (Offset 8) | `audio/wav` |
| `1A 45 DF A3` (EBML) | `video/webm` / `video/x-matroska` |
| kein NUL in ersten 8 KB + gültiges UTF-8 | Text-Heuristik → deklarierten `text/*`-Typ beibehalten, sonst `text/plain` |

**Auflösungsregeln:**
1. Sniff-Ergebnis existiert → **es gewinnt** über den deklarierten MIME (Anti-Spoofing).
2. Sniff unklar (kein Treffer) → deklarierte MIME verwenden, **wenn** sie in der Allowlist liegt; sonst `VALIDATION_FAILED`.
3. Deklarierte und gesniffte MIME stimmen beide zu, sind aber unterschiedlich (z. B. `image/jpeg` vs. `image/png`) → gesniffter Typ wird gespeichert, Warn-Log.
4. `kind` wird aus dem verifizierten MIME abgeleitet (`image/*`→image, `audio/*`→audio, `video/*`→video, sonst document); `kindHint` dient nur als Fallback bei unklarem Text-Sniff.

**Schicht 3 — Filename-Sanitization:** Control-Chars, `/`, `\`, `..` entfernen; Länge ≤ 128; NFC-Normalisierung. Betrifft nur die Metadaten-Spalte — der Speicherpfad ist davon unabhängig (§6.2).

### 6.4 Cleanup / Retention Policy

**Mechanismen (alle im `cleanup.ts` + `manager.ts`):**

| Trigger | Verhalten |
|---|---|
| **Periodischer Sweep** | `setInterval` (Default 30 min, `media.sweepIntervalMinutes`), gestartet in `initMediaManager()`; löscht alle Registry-Rows mit `expires_at < now` inkl. Datei; Ergebnis wird geloggt (`deletedFiles`, `freedBytes`) |
| **TTL pro Datei** | `expires_at = created_at + media.retentionHours` (Default 24 h). Nach TTL ist die Datei weg — der Agent hat sie dann auch nicht mehr nötig, da Sessions i. d. R. kürzlebiger sind; bei Bedarf kann der User die Datei neu senden |
| **Quota-Eviction** | Vor jedem Ingest: wenn `totalBytes + newSize > media.maxTotalBytes` (Default 512 MB) → älteste Dateien (FIFO über `created_at`) löschen, bis Platz ist; nicht erfüllbar (z. B. einzelne Datei > Quota) → `QUOTA_EXCEEDED` |
| **Startup-Cleanup** | Beim `initMediaManager()`: Orphan-`.part`-Dateien (> 1 h alt) löschen; Registry-Rows ohne existierende Datei prunen; konsolidiert Crash-Reste |
| **`discard()`** | Sofort-Löschung für Nachrichten, die die Security-Checks nicht bestehen (§7.3) oder deren Download fehlschlug (Temp-Dateien) |

**Bewusst NICHT enthalten (v1):** TTL-Aufhebung bei „wird gerade verarbeitet“ — Begründung: Der Prompt-Timeout (Default 5 min) ist ≪ 24 h Retention; ein Race ist praktisch ausgeschlossen und wird zusätzlich durch den Fallback in §7.4 abgefangen. Session-Reset (`/new`) löst **keine** sofortige Medien-Löschung aus (Dateien können zu mehreren Nachrichten gehören); Notiz als Ausbaustufe.

**Shutdown:** Der Sweep-Interval wird beim Daemon-Shutdown (bestehender `daemonShuttingDown`-Pfad) geklärt; SQLite schließt mit den anderen Stores.

---

## 7. Workflow-Integration

### 7.1 Datenfluss (Zielzustand, vollständig)

```
[1] Telegram liefert Update mit photo[]/document/audio/video (+ caption?)
[2] TelegramAdapter.handleUpdate()
      • Security-Pre-Checks der Adapter-Ebene (allowedChats, requireUsername) — unverändert
      • extractTelegramMedia(msg): photo → größtes PhotoSize; document/audio/video/animation → je 1 Kandidat
      • für jeden Kandidaten (max. media.maxAttachmentsPerMessage):
          mediaManager.ingest({ platform, messageId, fileRef, fileName, declaredMime,
                                declaredSizeBytes, kindHint, fetch: () => this.downloadFile(fileRef) })
          → MediaAttachment | MediaError
      • Fehler: pro Attachment Notify an den Chat (⚠️ …), Rest wird weiterverarbeitet
      • Invariante-Check: (content !== "") || attachments.length > 0, sonst return
      • emitMessage(PlatformMessage { content, attachments?, metadata })
[3] core/message-pipeline.ts — onMessage()
      • Session getOrCreate — unverändert
      • Rate-Limit / Allowlist / Pairing — UNVERÄNDERT; bei Ablehnung zusätzlich:
          mediaManager.discard(message.attachments.map(a => a.id))   ← NEU
      • Meta-Commands (/model, /restart, /new, /status) — unverändert (matchen auf content)
[4] Prompt-Bau (NEU, §7.3)
      • manifest = buildAttachmentManifest(attachments)
      • images[]  = attachments.filter(a => a.kind === "image" && a.sizeBytes <= media.maxImageBytes)
                      → { type: "image", data: base64(readFileSync(a.localPath)), mimeType: a.mimeType }
      • promptText = guard + manifest + content (bzw. Platzhalter bei leerem content)
[5] sendPromptRpc(promptText, session.id, images, onStream)   ← rpc.ts erweitert (§7.2)
[6] pi-Agent:
      • Bilder: nativ multimodal im Kontext
      • Dokumente/Audio: Agent liest den Pfad aus dem Manifest mit read/bash
[7] Antwort-Streaming/agent_end — unverändert (bestehender Edit/Throttle-Flow)
```

### 7.2 RPC-Payload-Erweiterung (`src/core/rpc.ts`)

Das pi-RPC-Protokoll kennt `prompt.images` nativ (§2.2/3) — es wird also **nur der bestehende Aufruf durchgereicht**:

```ts
// rpc.ts — signaturkompatible Erweiterung (images optional → alte Caller laufen unverändert)
export async function sendPromptRpc(
  message: string,
  sessionId: string,
  images?: ImageContent[],                    // NEU
  onStream?: (text: string) => void,
): Promise<string> {
  const ack = await sendRpc("prompt", {
    message,
    sessionId,
    ...(images && images.length > 0 ? { images } : {}),   // Feld nur bei Bedarf setzen
  });
  // … Rest (PendingCompletion-Map, Timeout) unverändert
}
```

**Trade-off-Notiz:** Alternative wäre gewesen, Bilder als Datei-Pfad zu übergeben und eine pi-Extension schreiben zu lassen, die sie einliest. Abgelehnt, weil: (a) natives `images`-Feld existiert — weniger Code, kein zweites Protokoll; (b) Base64 bleibt innerhalb des bestehenden JSONL-Frames; (c) keine Versionssprungs-Kopplung an eine eigene Extension. Kosten: größerer stdin-Payload (→ Cap `maxImageBytes`, §10).

### 7.3 Prompt-Materialisierung (`src/media/manifest.ts`)

```ts
export function buildAttachmentManifest(attachments: MediaAttachment[]): string {
  // leer bei [] → "" (Pipeline hängt Manifest nur an, wenn nicht leer)
}
```

**Format** (Agent-facing; mehrsprachig-neutral, Beispiel Deutsch gemäß Roadmap-Vorgabe):

```
Der Nutzer hat 2 Anhang(en) zu dieser Nachricht hinzugefügt:

[Anhang 1] screenshot.png (image, image/png, 1.2 MB)
Lokaler Pfad: ~/.pi/runtime/media/telegram/2026-08/med_3fa85f6405e9c1d2.png
Hinweis: Das Bild ist dieser Nachricht zusätzlich als Bild beigelegt.

[Anhang 2] report.pdf (document, application/pdf, 245 KB)
Lokaler Pfad: ~/.pi/runtime/media/telegram/2026-08/med_b21c9e07aa44d3e1.pdf
Hinweis: Die Datei liegt lokal; untersuche sie mit deinen Tools (read, bash).
```

**Pipeline-Kombination** (ersetzt heute: `` sendPromptRpc(`${guard}\n\n${message.content}`, …) ``):

```ts
const attachments = message.attachments ?? [];
const manifest = buildAttachmentManifest(attachments);
const images = /* §7.1 Schritt 4 */;
const userPart =
  message.content.length > 0
    ? message.content
    : "(Der Nutzer hat keine Textnachricht gesendet, nur Anhänge.)";
const promptText = [guard, manifest, userPart].filter(Boolean).join("\n\n");
await sendPromptRpc(promptText, session.id, images.length ? images : undefined, onStream);
```

**Platzhalter-/Streaming-Flow** (⏳ Thinking…, Edit-Throttling) bleibt vollständig unverändert — er agiert auf der Antwortseite.

### 7.4 Race: Datei zwischen Ingest und Prompt weg (Cleanup)

`readFileSync(localPath)` im Schritt [4] kann theoretisch fehlschlagen (Sweep lief dazwischen). Verhalten: **kein Fehler** — das Attachment wird aus `images[]` gestrichen, im Manifest wird die Zeile um `⚠️ Datei nicht mehr verfügbar (gelöscht)` angereichert. Begründung: Retention 24 h ≫ Prompt-Dauer; Robustheit schlägt Strenge.

---

## 8. Fehlerbehandlung

**Prinzip:** Ein Attachment ist eine *unitäre Fehlergrenze*. Fehler isolieren sich pro Datei; die Nachricht selbst (Text + übrige Anhänge) läuft weiter, wenn möglich.

| # | Szenario | Erkennung | Verhalten im System | User-Feedback (Chat) |
|---|---|---|---|---|
| E1 | Deklarierte Größe > `maxFileSizeBytes` | Pre-Check vor Download | Kein Download, kein Speicher | `⚠️ Datei „X“ ist zu groß (max. 20 MB).` |
| E2 | Deklarierter MIME nicht erlaubt | Pre-Check vor Download | Kein Download | `⚠️ Dateityp X wird nicht unterstützt.` |
| E3 | Download-HTTP-Fehler / Netzwerk | `fetch`-Closure | 1 Retry (Backoff 2 s) → `DOWNLOAD_FAILED`, Temp gelöscht | `⚠️ Download von „X“ fehlgeschlagen. Bitte erneut senden.` |
| E4 | Download-Timeout (> 60 s) | `AbortSignal.timeout` | wie E3, Code `TIMEOUT` | wie E3 |
| E5 | Gemessene Größe überschreitet Cap während des Streams | Byte-Counter | Stream abbrechen, `.part` löschen, `SIZE_EXCEEDED` | wie E1 |
| E6 | Gesniffte Signatur ≠ erlaubt / unklar | Post-Download-Sniffing | `.part` löschen, `UNSUPPORTED_TYPE`/`VALIDATION_FAILED` | `⚠️ Dateityp konnte nicht verifiziert werden.` |
| E7 | Quota nicht erfüllbar (nach Eviction) | Quota-Check | `QUOTA_EXCEEDED`, Error-Log mit Stats | `⚠️ Speicher voll — Datei konnte nicht gespeichert werden.` |
| E8 | Disk-Full / FS-Schreibfehler | fs-Exception | Temp löschen, Error-Log | generisch: `⚠️ Datei konnte nicht gespeichert werden.` |
| E9 | **Alle** Anhänge fehlerhaft + kein Text | Adapter nach Loop | Nachricht wird **nicht** emittiert (nichts zu verarbeiten) | pro Attachment bereits per E1–E8 gemeddelt |
| E10 | Mix: 1 von 3 fehlerhaft | Adapter nach Loop | Nachricht mit 2 Attachments wird emittiert; Pipeline unverändert | 1× Warnung + normale Agent-Antwort |
| E11 | Datei zwischen Ingest und Prompt gelöscht (Cleanup-Race) | `readFileSync` im Pipeline-Schritt [4] | Fallback: Pfad-Zeile mit „nicht mehr verfügbar“-Hinweis, kein Base64 | keine (Agent-Antwort läuft normal) |
| E12 | pi-Agent nicht running (`isAgentRunning() === false`) | bestehender Check in Pipeline | wie heute: Log-Warnung; **zusätzlich NEU:** `discard()` der Anhänge (sonst 24 h tote Dateien) | keine (bestehendes Verhalten) |

**Logging-Standard:** Jeder Ingest (Erfolg/Fehler) wird auf `info`/`warn` mit `platform`, `messageId`, `fileRef` (gekürzt), MIME, Größe und Dauer geloggt — ohne Dateinamen-Injection in strukturierte Felder (sanitized Metadaten verwenden).

---

## 9. Adapter-Integration

### 9.1 Telegram — Typ-Erweiterungen (`src/adapters/telegram.ts`)

```ts
interface TelegramFileRef {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

// TelegramMessage wird um die Medien-Felder erweitert:
interface TelegramMessage {
  // …bestehende Felder (message_id, from, chat, text, caption, date, …)
  photo?: Array<TelegramFileRef & { width: number; height: number }>;
  document?: TelegramFileRef;
  audio?: TelegramFileRef;
  video?: TelegramFileRef;
  animation?: TelegramFileRef;   // GIFs → als document/animation behandeln
  voice?: TelegramFileRef;
}
```

### 9.2 `handleUpdate` — neue Logik (Skizze)

```ts
// ersetzt: const content = msg.text || msg.caption || ""; if (!content) return;
const content = msg.text || msg.caption || "";
const candidates = extractTelegramMedia(msg);   // §9.3

if (!content && candidates.length === 0) return;   // Invariante: nichts zu tun

const attachments: MediaAttachment[] = [];
const failures: string[] = [];
const maxPerMsg = runtime.config.media?.maxAttachmentsPerMessage ?? 4;

for (const cand of candidates.slice(0, maxPerMsg)) {
  try {
    attachments.push(
      await mediaManager.ingest({
        platform: "telegram",
        messageId: String(msg.message_id),
        fileRef: cand.fileId,
        fileName: cand.fileName,
        declaredMime: cand.mime,
        declaredSizeBytes: cand.size,
        kindHint: cand.kind,
        fetch: () => this.downloadFile(cand.fileId),  // getFile + HTTP, §9.3
      }),
    );
  } catch (err) {
    failures.push(mediaErrorToUserMessage(err, cand));  // E1–E8 → Text
  }
}

if (failures.length > 0) {
  await this.sendMessage(String(msg.chat.id), failures.join("\n"));
}
if (!content && attachments.length === 0) return;   // E9: alles fehlgeschlagen

await this.emitMessage({
  id: this.generateMessageId(),
  platform: "telegram",
  channelId: String(msg.chat.id),
  userId: String(msg.from?.id || 0),
  content,                                          // darf "" sein
  timestamp: msg.date * 1000,
  attachments: attachments.length > 0 ? attachments : undefined,
  metadata: { /* unverändert: username, chatType, … */ },
});
```

**Wichtige Nebenwirkungen auf Bestehendes:**
- Der Long-Polling-Loop bleibt fire-and-forget (`handleUpdate` wird nicht awaited) — Ingests verlangsamen das Polling nicht, da sie asynchron laufen; der 35-s-`AbortSignal` des `apiRequest` deckt auch den Download ein.
- ForceReply-/Callback-Branches bleiben vor dieser Logik (unverändert).
- `edited_message` mit Medien: wird wie neue Nachricht behandelt (Ingest + Dedup via `fileRef` verhindert Doppel-Downloads bei identischer Datei).

### 9.3 Telegram-Download-Hilfe (`downloadFile`)

```ts
private async downloadFile(fileId: string): Promise<Readable> {
  // 1) file_path ermitteln (Telegram liefert keine URL direkt im Update)
  const res = await this.apiRequest("/getFile", {
    method: "POST",
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!data.ok || !data.result?.file_path) {
    throw new MediaError("DOWNLOAD_FAILED", `getFile failed for ${fileId}`);
  }
  // 2) Stream von api.telegram.org (TLS, Bot-Token in URL — nur intern)
  const dl = await fetch(`https://api.telegram.org/file/bot${this.config.token}/${data.result.file_path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!dl.ok || !dl.body) throw new MediaError("DOWNLOAD_FAILED", `HTTP ${dl.status}`);
  return Readable.fromWeb(dl.body as import("node:stream/web").ReadableStream);
}
```

### 9.4 Andere Adapter (Design-Vorbereitung, nicht im MVP)

| Adapter | Medien-Quelle | Ingest-Anpassung |
|---|---|---|
| **Discord** | `message.attachments[]` im Gateway-Event (`url`, `filename`, `size`, `content_type`) | `fetch` = direkter HTTP-Download der CDN-URL; `fileRef` = `attachment.id`. Geringer Aufwand — als Phase 3.1 empfohlen |
| **WhatsApp (Baileys)** | Media-Messages (`imageMessage`, `documentMessage`, `audioMessage`) via `downloadMediaMessage()` | Baileys liefert Buffer/Stream direkt; `fileRef` = `messageID`. Phase 3.2 |
| **Slack/WS** | Slack: `files[]` im Event; WS-Clients: kein Inbound-Media in MVP | später |

Das Ingest-API ist platform-agnostisch (nur `fetch`-Closure + Metadaten) — neue Adapter benötigen **keine** Änderung am `media/`-Modul.

---

## 10. Konfiguration

**Neuer Block in `GatewayConfig` (`src/types.ts`)** — optional, alle Felder mit Defaults (§2.2/5: Config-Merge-Pattern):

```ts
// src/types.ts — Erweiterung von GatewayConfig
export interface GatewayConfig {
  // …bestehende Felder…
  /** Phase 3: File-Attachments / Media-Handling */
  media?: {
    /** Master-Switch. false = Medien-Nachrichten werden wie heute verworfen (Default: true) */
    enabled?: boolean;
    /** Speicherwurzel (Default: ~/.pi/runtime/media; Env-Override PI_MEDIA_DIR für Tests) */
    rootDir?: string;
    /** Max. Größe pro Datei in Bytes (Default: 20_480_000 = Telegram-Bot-Limit) */
    maxFileSizeBytes?: number;
    /** Max. Größe, die als Base64 in den RPC-Prompt inline geht (Default: 5_242_880 = 5 MB) */
    maxImageBytes?: number;
    /** Gesamt-Quota des Media-Stores in Bytes (Default: 536_870_912 = 512 MB) */
    maxTotalBytes?: number;
    /** Retention pro Datei in Stunden (Default: 24) */
    retentionHours?: number;
    /** Intervall des TTL-Sweeps in Minuten (Default: 30) */
    sweepIntervalMinutes?: number;
    /** Max. Anhänge pro Nachricht (Default: 4) */
    maxAttachmentsPerMessage?: number;
    /** Erlaubte Kategorien (Default: alle vier) */
    allowedKinds?: MediaKind[];
    /** MIME-Allowlist; leer/fehlend = eingebaute Defaults (§6.3/§10.1) */
    allowedMimeTypes?: string[];
  };
}
```

**`config/config.default.json`** erhält den Block mit allen Defaults (sichtbar für Admins, wie `security.rateLimit`). `mergeGatewayConfig` validiert: Zahlen > 0, `allowedKinds` ⊆ {image, document, audio, video}, MIME-Strings im Format `type/subtype`.

### 10.1 Eingebaute MIME-Defaults (bei leerer `allowedMimeTypes`)

| Kind | Erlaubte MIME |
|---|---|
| image | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| document | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `…spreadsheetml.sheet`, `…presentationml.presentation`, `application/zip`, `application/x-7z-compressed`, `text/plain`, `text/markdown`, `text/csv`, `text/html`, `application/json`, `application/xml` |
| audio | `audio/mpeg`, `audio/ogg`, `audio/opus`, `audio/mp4`, `audio/wav`, `audio/aac`, `audio/x-m4a` |
| video | `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` |

---

## 11. Sicherheit (Zusammenfassung & Bedrohungsmodell)

| Bedrohung | Gegenmaßnahme |
|---|---|
| **MIME-Spoofing** (`.jpg`, die ein Skript ist) | Magic-Byte-Sniffing schlägt deklarierten Typ; Allowlist auf verifizierten Typ; Gateway *führt* Dateien nie aus — Verarbeitung erfolgt ausschließlich über die Agent-Tools, die der bestehenden Tool-Policy unterliegen |
| **Path Traversal / Dateinamen-Injection** | Generierte Speicherfilenamen (`med_<hex>`); Originalname nur als sanitized Metadaten-Spalte; Pfade werden nie aus Nutzereingaben komponiert |
| **Speicher-Exhaustion** (Flooding) | Deklarierte + gemessene Größen-Caps, Quota mit FIFO-Eviction, `maxAttachmentsPerMessage`, bestehendes Rate-Limit greift weiterhin auf Nachrichten-Ebene |
| **Symlink/TOCTOU im Store** | Schreibzugriff nur via `.part`-Temp + atomarem `rename` im Zielverzeichnis; Store-Verzeichnisse 0700, Dateien 0600; kein `followSymlinks` bei Reads des Managers |
| **Zip-Bombs (docx/xlsx)** | Gateway extrahiert nichts; Größen-Cap begrenzt das Worst-Case; Restrisiko beim Agent liegt in der Tool-Policy — als akzeptiertes Restrisiko dokumentiert |
| **Base64-Bloat am RPC-stdin** | `maxImageBytes`-Cap (Default 5 MB → ≈ 7 MB JSON); pi resizt Bilder intern (photon-node) — Annahme, E2E zu prüfen |
| **Token-Leak via Logs** | Telegram-Download-URL (enthält Bot-Token) wird nie geloggt; nur `fileRef` (gekürzt) und Status |

---

## 12. Teststrategie (Vitest, bestehendes Setup)

| Test-Suite | Abdeckung | Methodik |
|---|---|---|
| `tests/media/validate.test.ts` | Magic-Byte-Sniffing (alle Signaturen + Negativfälle), Filename-Sanitization, MIME-Auflösungsregeln | Puffer-Fixtures, keine Netzwerk |
| `tests/media/manager.test.ts` | Ingest-Happy-Path, alle MediaError-Codes, Dedup (Cache-Hit + In-Flight), Quota-Eviction, `discard()` | `PI_MEDIA_DIR` → tmp-Dir; `fetch`-Closure liefert lokale Puffer/Streams |
| `tests/media/cleanup.test.ts` | TTL-Sweep (injected `now`), Orphan-`.part`-Cleanup, Registry-Pruning | tmp-Dir + Zeit-Injection (kein Fake-Timer nötig) |
| `tests/media/manifest.test.ts` | Manifest-Format, leere Anhänge, „nicht mehr verfügbar“-Fallback | Snapshot/Zeilen-Checks |
| `tests/adapters/telegram-media.test.ts` | `extractTelegramMedia` (photo-largest, document, audio, animation), E9-Logik (alles fehlerhaft → kein Emit), Invariante (leer+leer → kein Emit) | Mockte `apiRequest` (bestehendes Test-Pattern in `tests/adapters/`) |
| `tests/core/pipeline-media.test.ts` | discard bei Rate-Limit/Allowlist-Ablehnung, images-Extraktion, leerer content mit Anhang | bestehende Pipeline-Mocks + MediaManager-Mock |
| **E2E (manuell, Phase 2.5-Stil)** | Echtes Telegram: Foto, PDF, zu große Datei, unzulässiger Typ, Mix aus Text+Anhang; Verifikation dass das LLM das Bild „sieht“ und die PDF-Pfad-Bearbeitung funktioniert | Checklist in `docs/phase3-e2e.md` |

---

## 13. Implementierungsplan

| Schritt | Inhalt | Dateien | Aufwand |
|---|---|---|---|
| S1 | Media-Typen + `validate.ts` + Tests | `src/media/types.ts`, `validate.ts`, `tests/media/validate.test.ts` | 0.5–1 d |
| S2 | `registry.ts` (SQLite) + `cleanup.ts` + Tests | `src/media/registry.ts`, `cleanup.ts`, Tests | 0.5–1 d |
| S3 | `manager.ts` (Ingest, Dedup, Quota, Singleton) + Tests | `src/media/manager.ts`, `index.ts`, Tests | 1 d |
| S4 | `PlatformMessage.attachments` + Pipeline-Integration (Manifest, discard, images) + `rpc.ts`-Durchreichung | `base.ts`, `message-pipeline.ts`, `rpc.ts`, `manifest.ts`, Tests | 0.5–1 d |
| S5 | Telegram-Adapter (Typen, `extractTelegramMedia`, `downloadFile`, neue `handleUpdate`-Logik) + Tests | `telegram.ts`, Tests | 1 d |
| S6 | Config (`types.ts`, `config.ts`, `config.default.json`) + Init-Wiring (`index.ts`, Daemon-Bootstrap, Shutdown) | je 1 Datei | 0.5 d |
| S7 | E2E-Validierung (echtes Telegram), README-Update (Features, Config, Speicherlayout), ROADMAP-Checkboxen | Doku | 0.5–1 d |

**Gesamt: ca. 4–6 Werktage.** Reihenfolge ist strikt sequenziell (S3 hängt an S2, S4/S5 an S3); S1 ist der kritische Startpunkt.

---

## 14. Risiken, offene Fragen & Annahmen

### Risiken
| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|---|---|---|---|
| pi-RPC `images`-Feld verhält sich in RPC-Modus anders als dokumentiert (z. B. Resizing-Verhalten) | niedrig | mittel | E2E-Schritt S7 prüft explizit; Fallback: Bilder nur als Pfad (Manifest-Zeile), keine Base64 |
| Telegram-File-Verfügbarkeitfenster (< 1 Tag) → Re-Dedup nach TTL schlägt fehl | mittel | niedrig | Dedup ist nur Optimierung; Fehlerfall E3 meldet sauber; Download erfolgt ohnehin sofort (§2.2/6) |
| Große Bilder treiben Token-Kosten hoch (Base64 → Bild-Token) | mittel | mittel | `maxImageBytes`-Cap; pi resizt intern; Kosten im E2E beobachten |
| Monats-Buckets + viele Plattformen → Verzeichnisstruktur wächst | niedrig | niedrig | TTL 24 h begrenzt Bestand auf wenige hundert Dateien; Sweep räumt auf |
| Bessere-sqlite3-Native-Abhängigkeit in neuen Modulen | sehr niedrig | niedrig | bereits im Projekt produktiv im Einsatz (sessions) |

### Offene Fragen (Entscheidung vor S1 empfohlen)
1. **Video im MVP?** Empfehlung: ja, aber nur Pfad-basiert (kein Inlining) — Kosten nahe null, Utility für Frame-Extraktion via bash. Alternativ streichen auf `allowedKinds` via Config (Design erlaubt beides).
2. **Sprache des Manifests:** Deutsch (Roadmap-Vorgabe) oder Englisch? Empfehlung: Deutsch behalten, da User-Basis deutsch; Agent versteht beides.
3. **`/gateway status`-Erweiterung** um Media-Stats (`stats()`)? Empfehlung: ja, einzeilig (`Media: 42 Dateien, 128 MB / 512 MB`) — Aufwand < 1 h, hoher Betriebsnutzen.

### Annahmen (explizit)
- **A1:** pi ≥ 0.84 im RPC-Modus akzeptiert `prompt.images` wie in `docs/rpc.md` dokumentiert (im Projekt 0.84.2 installiert — Doku passt zur Version).
- **A2:** Telegram stellt Bot-Datei-Downloads nur für begrenzte Zeit (~1 Tag) bereit → sofortiger Download ist Pflicht. *(Offizielle Bot-API-Doku vor S5 gegenlesen.)*
- **A3:** `~/.pi/runtime/` wird ausschließlich vom pi-Ökosystem genutzt und kollidiert nicht mit anderen Tools (heute existiert das Verzeichnis im Projekt-Kontext nicht; wird neu angelegt).
- **A4:** Der Agent läuft mit Schreib-/Leserechten auf `~/.pi/runtime/media/` (gleicher User wie Gateway/Daemon — ist der Fall, da Daemon vom pi-User gestartet wird).
- **A5:** Node ≥ 20 (Projekt-Requirement) → `Readable.fromWeb`, `AbortSignal.timeout`, `fs.promises` verfügbar.

---

## 15. Abnahme-Kriterien (Definition of Done, Phase 3)

- [ ] Foto via Telegram → Agent beschreibt Bildinhalt korrekt (multimodal, kein Tool-Read nötig).
- [ ] PDF/Textdokument via Telegram → Agent referenziert den korrekten Pfad und extrahiert Inhalt mit seinen Tools.
- [ ] Zu große Datei (> 20 MB) → saubere Fehlermeldung, kein Crash, kein Speicher-Rest.
- [ ] Unzulässiger Typ (z. B. `.exe`) → abgelehnt vor/nach Download, Datei bleibt nicht auf Platte.
- [ ] Rate-limiter User sendet Bild → Datei wird via `discard()` gelöscht.
- [ ] Nach 24 h (bzw. verkürztem Testwert) ist der Store wieder leer (Sweep loggt `deletedFiles`).
- [ ] Nachrichten ohne Anhänge: Verhalten bit-identisch zu vor Phase 3 (bestehende Tests grün).
- [ ] `npm run lint && npm run test && npm run build` grün; Coverage für `src/media/` ≥ 80 %.

*— Ende des Konzepts —*
