# pi-gateway — Architecture

This document is the self-contained architecture reference. It explains how pi-gateway is built, why it is built that way, and how data flows through the system. For installation and operations, see the [README](../README.md) and [`deployment.md`](deployment.md); for design-decision history, see [`adr-rpc-session-management.md`](adr-rpc-session-management.md).

---

## 1. What it is

pi-gateway connects chat platforms (Discord, Telegram, Slack, WhatsApp, Nextcloud Talk, WebSocket/web clients) to a single **pi coding agent**. It runs as a **pi extension**: registered tools + `/gateway` slash commands inside pi sessions, plus an HTTP/WebSocket server for external clients. Every inbound chat message is bridged to the agent as an RPC prompt; every agent response is delivered back to the originating chat — streamed token-by-token via live message editing.

```
                        ┌────────────────────────────────────────────┐
 Discord ─┐             │                pi-gateway                  │
 Telegram ─┤             │                                            │
 Slack ────┼── inbound ─►│  adapters → media → security → sessions    │── prompts ─►  pi agent
 WhatsApp ─┤             │                                            │◄─ (RPC, one
 NC Talk ──┘             │  ◄── outbound: stream/edit/chunk/reply ──  │    process per
 Web/WS ────────────────►│  HTTP + WebSocket API, daemon mode         │    session)
                        └────────────────────────────────────────────┘
```

## 2. Process model

Two cooperating layers:

- **In-process (extension):** when pi loads the extension, the gateway server (HTTP + WS) runs inside the pi process. Messages from chats arrive here when the gateway runs attached.
- **Detached (daemon):** `/gateway start -d` (or `pi-gateway start -d` from the CLI) spawns a detached daemon process so the gateway keeps serving chats after pi closes. pi's footer synchronizes with daemon state via `status-footer.ts`.

**One RPC process per session.** Each chat session maps to its own pi RPC child process (`Map<sessionId, SessionRuntime>` in `src/core/rpc.ts`). This gives true parallelism between chats, process-isolated correlation of completions (no FIFO ambiguity), and fault isolation — a hung channel process does not block others. Idle teardown and abort kill the per-session process; the sessions store treats the next message as a fresh session.

> Design rationale and migration history: [`adr-rpc-session-management.md`](adr-rpc-session-management.md).

## 3. Core modules (`src/core/`)

| Module | Responsibility |
|---|---|
| `server.ts` | HTTP + WebSocket server, API auth (Bearer tokens), cron-ish housekeeping |
| `rpc.ts` | Spawns/one pi RPC process per session; multiplexes prompts, streaming deltas (`message_update`) and completions (`agent_end`) by `sessionId`; per-session abort/restart |
| `message-pipeline.ts` | The inbound path (see §5): media ingest → rate limit → allowlist/pairing → tool-policy directive → session resolution → RPC prompt |
| `commands.ts` | The `/gateway` slash-command handler (status, allow, pair, admin, tool-policy, sessions, tasks, config) |
| `tools.ts` | The 5 registered tools: `gateway_status`, `gateway_sessions`, `gateway_background_tasks`, `gateway_pairing`, `gateway_tool_policy` |
| `daemon.ts` | Detached daemon lifecycle; config watcher (file change → adapter restart); deterministic shutdown sequence: `stopAdapters → shutdownTalkStateStore → shutdownMediaManager` |
| `status-footer.ts` | pi footer sync (🟢 Gateway (daemon) indicator, generation counter against flapping) |

## 4. Adapters (`src/adapters/`)

All adapters implement one contract (`base.ts`): lifecycle (`start`/`stop`), outbound (`send`/`edit`/`delete` with chunking for long messages), and the central **`isPublishable`** gate that decides which message types may be sent — the backbone of loop prevention. The `registry.ts` wires configured platforms with fail-fast validation.

| Adapter | Inbound mechanism | Notes |
|---|---|---|
| Telegram | long polling (persistent `getUpdates`) or webhook (auto-detected) | attachments via Bot API file download |
| Discord | gateway WebSocket | guild-scoped |
| Slack | outgoing webhooks + optional Bot token | inbound (receiving) planned |
| WhatsApp | Baileys session | QR pairing, session persistence |
| WebSocket/web | the gateway's own WS API | external clients, JSON messages |
| Nextcloud Talk | **OCS user-polling** — no inbound endpoint needed | see below |

### Nextcloud Talk adapter (OCS polling)

Operates **without a public URL**: the gateway authenticates as a regular Nextcloud user (Basic-Auth with a revocable **app password**) and polls the Talk OCS API — outbound-only connections.

- **Long-poll first** (`lookIntoFuture=1`), interval fallback; exponential backoff + circuit breaker protect the Nextcloud instance.
- **Persistent watermarks:** `lastKnownMessageId` per room in a SQLite `talk_state` store → restarts resume exactly, no re-processing, no gaps.
- **Two-layer anti-loop:** poller pre-filter + central `isPublishable` drop own messages, bot actors, and system events; the watermark advances past them. The invariant *"one agent call per user message, never triggered by the bot itself"* is pinned by `tests/core/anti-loop-edge.test.ts`.
- **Room handling:** explicit room tokens in config; `autoDiscoverRooms` + `roomRefreshIntervalMs` merge discovered rooms at runtime (fail-open). Read markers are set after processing (`POST /chat/{token}/read`).
- **Media:** shared files/images are downloaded via WebDAV as the bot user and pushed through the media pipeline (§6).
- **API compatibility:** OCS statuscode quirks (NC 33 returns HTTP-200 with `statuscode 200`) are handled; API versions are negotiated per endpoint (`/room` v4, `/chat` v1).

## 5. Inbound pipeline (message path)

Every inbound message flows through the same ordered path (`message-pipeline.ts`):

```
adapter.onMessage
  → media ingest (attachments → download → magic-byte validation → local path)
  → rate limiting (per user + per platform, sliding window)
  → allowlist / pairing (DB allowlist, config pre-approved UIDs, pairing codes)
  → tool-policy directive (read-only baseline, prepended to the prompt)
  → session resolution (getOrCreateSession → 1 session = 1 RPC process)
  → RPC prompt (sessionId-tagged)
```

The pipeline resolves the platform identity (`platform + userId`) against the security layer, so allowlist semantics are per-platform (no cross-platform forcing).

## 6. Media pipeline (`src/media/`)

- **Ingest:** attachments are downloaded to a local media root (`~/.pi/runtime/media` by default), organized per platform/month.
- **Validation:** **magic-byte verification** decides the real file kind — declared MIME types from platforms (e.g. Telegram's generic `application/octet-stream` for scripts) are only a pre-check; binaries are caught after download. Allowed kinds: image, document, audio, video; per-message and total-size quotas.
- **TTL cleanup:** a lazy, config-aware sweep interval removes expired media.
- **Prompt materialization:** a manifest ("user attached file X at /path…") is prepended to the prompt; images are additionally inlined base64 for multimodal models.

## 7. Security (`src/security/`)

Enforcement order on every inbound message: **rate limiting → allowlist → tool policies**.

- **Allowlist:** DB-backed, managed at runtime via `/gateway allow|revoke`; config-file `allowedUids` (per platform or `"*"` wildcard) pre-approve users without pairing.
- **Pairing flow:** `requirePairing` issues 8-character codes (1 h validity) that an admin approves with `/gateway pair <code>`.
- **Admin users:** `adminUids` (config) or runtime-granted; bypass all tool policies.
- **Tool policies:** external users default to **read-only tools**; policies are tunable per platform/user/global, resolution order user > platform > global, ties break deny-first.
- **Secrets handling:** tokens live only in `~/.pi/gateway/config.json` (never in the repo, never logged); Nextcloud Talk supports an env override (`NEXTCLOUD_TALK_APP_TOKEN`) for secret-manager setups; the config validator rejects placeholder tokens.

## 8. Sessions & background tasks

- **Sessions store** (`src/sessions/`, SQLite): one row per chat (`platform + channelId + userId` → `sessionId`), reset policies `daily` / `idle` / `both`; sessions survive gateway restarts.
- **Background tasks** (`src/background/`): long-running work is spawned in isolated child sessions; results are delivered back to the parent chat when done (`/gateway tasks`).

## 9. Runtime state (`src/state.ts`)

All mutable shared state lives on a single **`runtime` container** (singleton) — config, adapters, RPC process registry, media manager, server handles. No scattered module-level globals; modules read cross-module bindings inside function bodies (deferred ESM cycles only).

## 10. Storage layout

| Location | Contents | Touched by deploys? |
|---|---|---|
| project directory (git repo) | `src/`, `tests/`, `config/config.default.json`, docs | build source |
| `~/.pi/runtime/pi-gateway/` | deployed `dist/`, `src/`, `config/`, `node_modules/` — the registered extension path | yes (install/update) |
| `~/.pi/gateway/` | `config.json` (secrets!), SQLite stores, `gateway.log`, `gateway.pid` | **never** (config/data separate from binary deploys) |
| `~/.pi/runtime/media/` | downloaded attachments (TTL-cleaned) | no |

## 11. Testing

- **Vitest** suite (`tests/`) with strict TypeScript; stores are isolated per test via injected temporary `GATEWAY_DB_DIR`.
- **Mock platform harnesses** exercise full pipelines (inbound → media → adapter → agent response) without network access.
- **Anti-loop edge tests** pin the loop-freedom invariant across edit storms, chunked long answers, mixed batches, non-publishable types, rejection loops, and restarts.

## 12. Technology & constraints

- **Node.js ≥ 20**, TypeScript (strict), ESM; `better-sqlite3` for stores; `@sinclair/typebox` for schema validation.
- Runs inside the pi extension host; RPC to the pi agent per session process (see §2).
- The gateway never logs secrets; platform credentials are scope-limited app passwords/bot tokens where the platform supports it.
