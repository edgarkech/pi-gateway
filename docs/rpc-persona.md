# RPC Agent Persona — Modell, Systemprompt & Session-CWD für Gateway-Sessions

**Status:** Konzept (festgezurrt 2026-09-16; erweitert um Session-CWD, Option A, 2026-09-16) — Umsetzung ausstehend, noch kein Bau
**Scope:** `src/core/rpc.ts` (`startRpc`) · `src/config.ts` + `src/types.ts` (Config-Felder)
**Verwandt:** `docs/ARCHITECTURE.md` (Architektur) · `docs/deployment.md` (Deploy)

## 1. Ziel & Nicht-Ziele

**Ziel:** Gateway-Sessions bekommen (1) ein anderes Modell, (2) einen vollständigen, eigenen Systemprompt und (3) den gemeinsamen Session-CWD. Alles andere verhält sich wie bei einer TUI-Session.

- **Modell:** konfigurierbar (vermutlich ein Cloud-Modell, gemäß Konfiguration).
- **Systemprompt:** **Replace**, nicht Append — der Gateway-Agent erhält einen vollständigen Prompt. Die user-level `SYSTEM.md` (`~/.pi/agent/SYSTEM.md`) wird bei `--system-prompt`-Aufruf **nicht** geladen, sondern die übergebene Prompt-Quelle (beobachtet 2026-09-16; Mikro-Test beim Bau bestätigt).
- **Session-CWD:** Alle Sessions (TUI + Gateway) laufen im selben Arbeitsverzeichnis und teilen die Session-Ablage — der gleiche Agent, nur mit anderem Modell und angepasstem Systemprompt (festgezurrt 2026-09-16, Option A). pi leitet den Session-Slot aus dem CWD ab: aktuell (Unit `WorkingDirectory=%h/.pi/runtime/pi-gateway`, Spawn ohne cwd-Option) → eigener Session-Slot unter `~/.pi/agent/sessions/` (Slug aus dem Daemon-CWD); mit `rpc.cwd` → Standard-Slot wie bei TUI-Sessions.

**Nicht-Ziele:** Keine Änderung an Trust, Tool-Set, Settings-Kaskade oder Multiplexing-Architektur (ein RPC-Prozess für alle Kanäle bleibt; Modell, Prompt und CWD gelten Gateway-weit, nicht pro Raum).

## 2. Mechanik

pi-Flags (nativ, per `pi --help`):

- `--model <pattern>` — Startup-Modell; ohne Flag gilt die Settings-Kaskade (heutiges Verhalten).
- `--system-prompt <text|promptfile>` — ersetzt den Coding-Assistant-Default vollständig; SYSTEM.md wird nicht geladen.

Kein pi-Flag für den Session-CWD — das ist eine **Spawn-Option** (`cwd` im Spawn-Call, keine CLI-Flag). Der Session-Slot folgt dem CWD des RPC-Prozesses.

## 3. Konfiguration

Root-Ebene (global, alle Kanäle — der Hebel betrifft den RPC-Prozess, nicht eine Platform):

```json
{
  "rpc": {
    "model": "",
    "systemPrompt": "",
    "cwd": ""
  }
}
```

- `rpc.model`: Modell-Pattern (z. B. `anthropic/claude-sonnet-4-20250514`); leer → heutiges Verhalten.
- `rpc.systemPrompt`: Prompt-Text oder Pfad zur Prompt-Datei; leer → heutiges Verhalten.
- `rpc.cwd`: Arbeitsverzeichnis des RPC-Child-Prozesses — der Session-Slot folgt dem CWD; leer → heutiges Verhalten (CWD des Daemons erben). Produktiv: `$HOME` in `~/.pi/gateway/config.json` (Config nicht im Repo — Repo-Beispiele bleiben E6/E7-neutral).
- `DEFAULT_CONFIG` + Deep-Merge erweitern (Deep-Merge-Pattern der bestehenden Config-Struktur), Typ-Validierung (`string`).
- Cloud-Modell → Voraussetzung: Provider-API-Key im Daemon-Kontext (systemd-User-Service erbt die User-Umgebung; `pi auth` prüft Readiness).

## 4. Implementierung (Skizze)

`src/core/rpc.ts` — `startRpc()`:

```typescript
const args = ["--mode", "rpc", "--extension", extensionPath];
if (cfg.model)        args.push("--model", cfg.model);
if (cfg.systemPrompt) args.push("--system-prompt", cfg.systemPrompt);
const spawnOpts: SpawnOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434" },
};
if (cfg.cwd) spawnOpts.cwd = cfg.cwd;
const proc = spawn("pi", args, spawnOpts) as RpcProcess;
```

Graceful: leere Felder → byte-identisches heutiges Verhalten (rückwärtskompatibel).

## 5. Verifikation

1. **Unit-Test:** Args-Zusammensetzung und Spawn-Optionen (mit/ohne Felder inkl. `rpc.cwd`, Graceful-Pfade).
2. **Qualitäts-Gates:** `tsc --noEmit` (strict), eslint, prettier, komplette Test-Suite.
3. **Mikro-Test bestanden (2026-09-16):** `--system-prompt <pfad>` — pi erkennt den Pfad als Prompt-Datei und lädt den Inhalt (Live-Test mit modifizierter SYSTEM.md-Kopie: Agent antwortete mit dem Test-Namen, user-level SYSTEM.md nicht aktiv = Replace bestätigt). Der Fallback im Gateway (Datei selbst lesen) entfällt — der Pfad wird direkt übergeben.
4. **Live-Verifikation:** Talk-Nachricht → Gateway-Agent antwortet mit konfiguriertem Modell/Prompt (Session-Log: `model`-Feld der Assistant-Message); Session-Datei landet im Standard-Slot `~/.pi/agent/sessions/` (gemeinsame Ablage mit TUI-Sessions).

## 6. Deploy

`deploy.sh update` (Build, dist-Backup, Sync, Restart, Verify) — Projekt = SSoT, diff-verifiziert, Backup vorher. Hinweis: Die rpc-Felder wirken beim Spawn — und der Spawn liest `runtime.config` frisch: der config-watcher (daemon.ts, file change → `reloadDaemonConfig` → `runtime.config = nextConfig`) lädt Änderungen live, d.h. die Felder werden beim **nächsten Spawn** wirksam, nicht erst beim Daemon-Restart (belegt 2026-09-16, daemon.ts L200–216). Der Daemon-Restart ist für den dist-Sync des Deploy selbst nötig; bis dahin läuft die produktive Runtime auf dem alten dist-Stand, der die rpc-Felder ignoriert — eine vorab gesetzte Config ist dadurch harmlos.

## 7. Offene Punkte

- **Welches Modell konkret + Prompt-Inhalt:** Betreiber-Entscheidung — der finale Systemprompt wird im Nachgang erarbeitet (Basis: modifizierte Kopie der user-level SYSTEM.md mit angepasstem Namen; Mikro-Test-Muster s. 5.3).
- **Session-CWD (Option A, festgezurrt 2026-09-16):** Umsetzung im Spawn-Call; produktiver Wert `$HOME` in `~/.pi/gateway/config.json`; Daemon-Restart nach Config-Änderung (s. 6).
