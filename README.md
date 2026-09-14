# pi-gateway

Multi-platform chat bridge for pi — connect your AI agent to Discord, Telegram, Slack, WhatsApp, Nextcloud Talk, WebSocket, and the web. Real-time streaming, per-chat sessions, role-based access control, and a hardened security layer.

> Fork of [0xKobold/pi-gateway](https://github.com/0xKobold/pi-gateway), carried forward through [gamalan/pi-gateway](https://github.com/gamalan/pi-gateway) and refactored into a modular architecture with config-based UID allowlisting, a pairing flow, and per-user/per-platform rate limiting. See [LICENSE](LICENSE) for the copyright chain.

## Architecture

pi-gateway is a **modular system**, not a monolith. The former single `index.ts` was split into cohesive modules organized under well-defined concerns. `src/index.ts` is now a thin entry point (~50 lines) that wires the modules together at startup. For a deeper dive see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
src/
├── core/                      # core runtime logic
│   ├── server.ts              # HTTP + WebSocket server, auth, cron
│   ├── rpc.ts                 # RPC process, prompt/completion multiplexing (sessionId-based)
│   ├── message-pipeline.ts    # inbound message handling (rate limit → allowlist → pi)
│   ├── commands.ts            # the /gateway slash-command handler
│   ├── tools.ts               # the 5 registered gateway tools
│   ├── daemon.ts              # detached daemon mode + config watcher
│   └── status-footer.ts       # pi footer synchronization
├── adapters/                  # platform adapters
│   ├── base.ts                # BaseAdapter + PlatformMessage types
│   ├── registry.ts            # adapter initialization/discovery
│   ├── discord.ts telegram.ts slack.ts whatsapp.ts websocket.ts
│   ├── nextcloud-talk.ts      # Nextcloud Talk adapter (OCS polling)
│   └── nextcloud/             # OcsClient, TalkPoller, talk_state store, types
├── media/                     # file-attachment stack: ingest, magic-byte
│                              # validation, registry, TTL cleanup, prompt manifests
├── security/                  # security layer
│   ├── auth.ts                # allowlists, pairing codes, rate limiting, admins
│   └── tool-policy.ts         # per-user/per-platform tool access policies
├── sessions/                  # SQLite-backed session store + reset policies
├── background/                # background task manager
├── config.ts                  # config loading/merging, defaults
├── state.ts                   # runtime container (single source of mutable state)
└── types.ts                   # shared type definitions
```

Key design principles:

- **`runtime` container (`src/state.ts`)** — all mutable shared state lives on a single `runtime` singleton, eliminating scattered module-level globals.
- **`src/core/rpc.ts`** multiplexes prompts by `sessionId` (a `Map<sessionId, PendingRequest>`), so streaming responses and completion events are correctly correlated to the originating chat.
- **Coupled-by-import cycles** are deferred ESM cycles only — safe because cross-module bindings are read inside function bodies, never at module-evaluation time.

## Features

- **Multi-platform adapters** — Discord, Telegram, Slack, WhatsApp, Nextcloud Talk, WebSocket (web/HTTP clients ride the same WebSocket+HTTP API)
- **Nextcloud Talk without a public URL** — OCS user-polling (long-poll first, interval fallback) with persistent per-room watermarks, backoff/circuit-breaker, and a two-layer anti-loop filter so the bot never answers itself
- **File attachments** — inbound media (images, documents) from Telegram/Nextcloud Talk via magic-byte validation, local storage with TTL cleanup, and prompt manifests (+ base64 image inlining)
- **Real-time streaming** — responses appear token-by-token via live message editing
- **Per-chat sessions** — isolated conversations with configurable reset policies (daily / idle)
- **Background tasks** — spawn async work from chats, results delivered when ready
- **Security layer** — allowlists, admin roles, pairing flow, per-user/platform rate limiting, configurable tool policies
- **Detached daemon mode** — `/gateway start -d` or `pi-gateway start -d` keeps the gateway alive after pi closes
- **HTTP + WebSocket API** — connect external clients, send prompts, receive streaming responses
- **pi-native** — runs as a pi extension with `/gateway` slash commands and registered tools

## Installation

Requires pi coding agent (`@earendil-works/pi-coding-agent >= 0.80.3`) and `@sinclair/typebox >= 0.32.0`.

**Recommended (script):** the deployment script automates build, runtime sync, config seeding, service setup, and verification — see [`docs/deployment.md`](docs/deployment.md):

```bash
git clone https://github.com/edgarkech/pi-gateway.git
cd pi-gateway
npm install
./scripts/deploy.sh install --seed-config --with-service
```

**Manual (equivalent to the script):**

```bash
# 1. Build the project
git clone https://github.com/edgarkech/pi-gateway.git
cd pi-gateway
npm install && npm run build

# 2. Fill the runtime directory + install dependencies there
mkdir -p ~/.pi/runtime/pi-gateway
rsync -a dist/ src/ config/ package.json package-lock.json ~/.pi/runtime/pi-gateway/
cd ~/.pi/runtime/pi-gateway && npm ci

# 3. Register as a pi extension (absolute path source -> robust)
cd ~/.pi/agent
pi install ~/.pi/runtime/pi-gateway

# 4. Seed configuration (never auto-overwritten)
mkdir -p ~/.pi/gateway && cp config/config.default.json ~/.pi/gateway/config.json
#    -> fill in tokens/UIDs/Nextcloud-Talk block manually

# 5. Service (optional)
cp docs/pi-gateway.service ~/.config/systemd/user/
#    -> adjust the Node.js path inside the unit file to your toolchain
systemctl --user daemon-reload && systemctl --user enable --now pi-gateway
```

> **Note:** `pi install <path>` links (does not copy) — the runtime directory must stay in place afterwards (do not move/rename/delete it). An update in place is fine; see `scripts/deploy.sh update`.

## Quick Start

```bash
# Start the gateway
/gateway start

# Check status
/gateway status

# Stop
/gateway stop
```

The gateway starts on `http://localhost:3847` by default. See `/gateway config` for current settings. When detached mode is active, pi's footer shows `🟢 Gateway (daemon)` and automatically follows daemon start/stop changes.

## Configuration

Configuration lives at `~/.pi/gateway/config.json`. On first run the gateway auto-seeds it from the packaged template at `node_modules/pi-gateway/config/config.default.json`.

```jsonc
{
  "port": 3847,
  "host": "localhost",
  "tokens": [],                    // Bearer tokens for API auth (empty = allow all)
  "corsOrigins": ["*"],
  "enableWebSocket": true,         // serve ws://localhost:3847 for web/WS clients
  "enableHttp": true,              // serve HTTP API + Telegram webhook
  "security": {
    "allowAll": true,              // false = enforce allowlist
    "requirePairing": false,       // true = unlisted users must complete a pairing flow
    "allowedUids": {},             // pre-approved users (see Security); key: platform or "*"
    "adminUids": {},               // users with full access (see Admin Users); key: platform or "*"
    "rateLimit": {
      "maxRequests": 60,           // max messages per user within the window
      "windowMs": 60000            // sliding window (ms)
    }
  },
  "sessions": {
    "resetPolicy": "idle",         // "daily" | "idle" | "both"
    "dailyHour": 4,                // hour (0-23) for daily reset
    "idleMinutes": 1440            // minutes before idle reset
  },
  "platforms": {
    "discord": {
      "enabled": true,
      "botToken": "your-token",
      "guildId": "optional-guild-id"
    },
    "telegram": {
      "enabled": true,
      "token": "your-bot-token",
      "webhookUrl": "https://..."  // omit for long polling
    },
    "slack": {
      "enabled": true,
      "webhookUrl": "https://...",
      "botToken": "optional-bot-token"
    },
    "whatsapp": {
      "enabled": true,
      "sessionPath": "~/.pi/whatsapp-session",
      "printQr": true
    },
    "nextcloudTalk": {
      "enabled": false,
      "baseUrl": "https://nextcloud.example.com",  // no trailing slash
      "userId": "bot-account",               // Nextcloud login of the bot account
      "appToken": "…",             // app password (NOT the main account password)
      "rooms": ["room-token-1234"],           // Talk room tokens (explicit, MVP)
      "pollMode": "long-poll",                // "long-poll" | "interval"
      "longPollTimeoutSeconds": 30,
      "minPollIntervalMs": 1000,
      "maxConcurrentPolls": 4,
      "allowInsecureHttp": false,             // true = http:// allowed (LAN)
      "maxAttachmentsPerMessage": 4
    }
  }
}
```

### Telegram: webhook vs long polling

The gateway auto-detects the mode based on whether `webhookUrl` is set:

| `webhookUrl` | Mode | How it works |
|---|---|---|
| Set | **Webhook** | Telegram POSTs updates to `/webhook/telegram` on the gateway's HTTP server. Lowest latency, requires a public URL. |
| Omitted | **Long polling** | The gateway opens a persistent connection to Telegram's `getUpdates` endpoint (30s timeout). Telegram holds it open and returns immediately when a message arrives — near-real-time, no public URL needed. |

Both modes are real-time. Long polling is NOT interval-based — it keeps one connection alive at all times.

### Nextcloud Talk: OCS user-polling (no public URL)

The Nextcloud Talk adapter makes the agent reachable from Talk chats **without any inbound endpoint**: the gateway logs in as a regular Nextcloud user (Basic-Auth with an **app password**) and actively polls the Talk OCS API. Only *outgoing* HTTPS connections to your Nextcloud (LAN/VPN) are needed.

- **Long polling first** (`lookIntoFuture=1&timeout=30`): one open request per room, near-zero CPU when idle; `pollMode: "interval"` is the fallback. Exponential backoff + circuit breaker protect the server (and the rooms) from error storms.
- **Persistent watermarks** (`lastKnownMessageId` per room in a SQLite `talk_state` store): restarts resume exactly where they stopped — no re-processing, no gaps.
- **Anti-loop by design**: the gateway answers as the same OCS user it polls. A two-layer filter (poller pre-filter + central `isPublishable` in the adapter) drops own messages, bot actors, and system events; the watermark advances past them, so the bot can never trigger itself. Covered by dedicated edge tests (`tests/core/anti-loop-edge.test.ts`).
- **Attachments**: shared files/images are downloaded via WebDAV as the bot user and run through the media pipeline (magic-byte validation, quota, TTL).
- **Security**: use an app password (`appToken`), never the main password — app passwords are revocable and scope-limited. `https://` is enforced unless you explicitly set `allowInsecureHttp: true` (LAN-only setups). The token is never written to logs.

## Security

The security layer (`src/security/`) enforces, in order, rate limiting, the allowlist, and tool policies on every inbound message (see the `message-pipeline`).

### Rate Limiting

Per-user **and** per-platform. When a user exceeds `security.rateLimit.maxRequests` within `security.rateLimit.windowMs`, further messages are blocked with a "too quickly" notice. Configured via the `security.rateLimit` block in `config.json` (defaults: 60 requests / 60000 ms).

### Allowlist (DB)

Manage users at runtime via `/gateway` commands:

```bash
# List allowlisted users
/gateway allow

# Add a user
/gateway allow discord 123456789

# Revoke a user
/gateway revoke discord 123456789
```

### Config-file pre-approved UIDs

Skip pairing entirely by listing UIDs in the `security` block of `config.json`:

```jsonc
{
  "security": {
    "allowAll": false,
    "allowedUids": {
      "discord": ["123456789", "987654321"],
      "telegram": ["1234567890"],
      "*": ["cross-platform-admin"]
    },
    "adminUids": {
      "discord": ["123456789"],
      "*": ["cross-platform-admin-uid"]
    },
    "rateLimit": {
      "maxRequests": 60,
      "windowMs": 60000
    }
  }
}
```

- Platform-specific keys match that platform only
- The `"*"` wildcard matches any platform
- Users in `allowedUids` are auto-allowed on first contact — no pairing code needed
- Setting `security.allowAll: true` (the default) bypasses the allowlist entirely
- All security settings live in the main `config.json` — no separate security file

### Pairing Flow

When `security.requirePairing` is `true` and a user is not in the allowlist:

1. User sends a message → blocked, receives an 8-character pairing code (valid 1 hour)
2. Admin approves with `/gateway pair <code>`
3. User is added to the DB allowlist

```bash
# List pending pairing codes
/gateway pair

# Approve a specific code
/gateway pair ABC12345
```

### Admin Users

Admin users have **full unrestricted access** — they bypass all tool policies and can use every tool pi offers. Admins can be set at runtime or via `security.adminUids`:

```jsonc
{
  "security": {
    "adminUids": {
      "discord": ["123456789"],
      "*": ["cross-platform-admin-uid"]
    }
  }
}
```

```bash
/gateway admin list                # list admins (DB + config)
/gateway admin add discord 1234    # grant admin on a platform
/gateway admin add * 1234          # grant admin on ALL platforms
/gateway admin remove discord 1234 # revoke
```

### Tool Policy

By default, external users are **restricted to read-only tools** when their messages reach pi. The policy is enforced via a system directive prepended to every forwarded message and is tunable per platform, per user, or globally.

```bash
/gateway tool-policy list
/gateway tool-policy defaults
/gateway tool-policy set discord U123456 bash allow
/gateway tool-policy set discord * write deny
/gateway tool-policy remove 3
/gateway tool-policy reset
```

**Resolution order** (highest wins): user-specific > platform-specific > global. Ties break deny-first (secure by default). The `*` glob matches any tool name. Admin users always bypass all restrictions.

## Development

### Requirements

- **Node.js** ≥ 20
- **TypeScript** (`typescript` ≥ 6, listed as a dev dependency)

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | TypeScript watch build |
| `npm run format` | Auto-format the whole project with Prettier |
| `npm run format:check` | Verify formatting (no write) |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run test` | Run the Vitest unit test suite |
| `npm run test:coverage` | Run tests with coverage |

### Tooling

- **Prettier** enforces a consistent format (tabs, single-quote-off, semicolons). `.prettierrc.json` + `.prettierignore`.
- **ESLint** (`eslint.config.js`) with TypeScript + Prettier configs.
- **Vitest** for unit tests covering the core modules — `tests/security/`, `tests/sessions/`, `tests/adapters/`.

## Commands

| Command | Description |
|---------|-------------|
| `/gateway start [port]` | Start the gateway |
| `/gateway stop` | Stop the gateway |
| `/gateway restart` | Restart the gateway |
| `/gateway status` | Show running status, platforms, sessions |
| `/gateway pair [code]` | List pending codes or approve one |
| `/gateway allow [platform] [userId]` | List allowlist or add a user |
| `/gateway revoke <platform> <userId>` | Remove a user from the DB allowlist |
| `/gateway sessions` | List active chat sessions |
| `/gateway tasks` | List background tasks |
| `/gateway config` | Show current configuration |
| `/gateway admin list` | List admin users (DB + config) |
| `/gateway admin add <p\|*> <uid>` | Grant admin privileges |
| `/gateway admin remove <p\|*> <uid>` | Revoke admin |
| `/gateway tool-policy list` | List explicit tool policies |
| `/gateway tool-policy defaults` | Show default policy baseline |
| `/gateway tool-policy set <p> <u> <t> allow\|deny` | Add/update a tool policy |
| `/gateway tool-policy remove <id>` | Delete a policy |
| `/gateway tool-policy reset` | Clear all, back to defaults |

## HTTP API

Available when the gateway is running:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Gateway status (running, adapters, clients, sessions) |
| `/api/sessions` | GET | Active sessions |
| `/api/background` | GET | Background tasks |
| `/api/allowlist` | GET | Allowlisted users |
| `/api/pairing` | GET | Pending pairing codes |

Authenticate with `Authorization: Bearer <token>` if tokens are configured.

## WebSocket API

Connect to `ws://localhost:3847` (web clients and other WebSocket-based platforms). Messages are JSON:

```jsonc
// Send a prompt
{ "type": "prompt", "data": { "message": "Hello" } }

// Start a background task
{ "type": "background", "data": { "sessionId": "...", "command": "..." } }

// Ping
{ "type": "ping" }
```

Receive responses, background task updates, and agent events as server-pushed messages.

## Registered Tools

The extension registers these tools for use in pi sessions:

- **`gateway_status`** — Check if gateway is running and which adapters are active
- **`gateway_sessions`** — List active chat sessions
- **`gateway_background_tasks`** — List and manage background tasks
- **`gateway_pairing`** — Generate or approve pairing codes
- **`gateway_tool_policy`** — Manage tool access policies for external users

## Sessions

Each chat gets an isolated session with configurable reset policies:

- **daily** — Session resets at a specific hour each day (default: 4 AM)
- **idle** — Session resets after N minutes of inactivity
- **both** — Whichever triggers first

Sessions persist across gateway restarts in `~/.pi/gateway/gateway-sessions.db`.

## Background Tasks

Long-running work is spawned in isolated background sessions. Results are delivered back to the parent chat when complete. Managed via `/gateway tasks`.

## Known Limitations & Roadmap

Status (details in [`ROADMAP.md`](ROADMAP.md)):

- ✅ **Phase 1 (Foundation)** — modular architecture, sessionId-based RPC multiplexing, per-chat sessions.
- ✅ **Phase 2 (Cleanup)** — security hardening, TypeScript strict mode, Vitest suite, linting/formatting.
- ✅ **Phase 3 (Input Expansion)** — media/file-attachment support (`media/` module: ingest, magic-byte validation, TTL cleanup; integrated into Telegram and Nextcloud Talk).
- ✅ **Phase 4 (Nextcloud Talk)** — OCS user-polling adapter complete: long-poll with interval fallback, persistent watermarks, anti-loop filter, read markers, room discovery, WebDAV media inbound; validated against a real Nextcloud 33 instance end-to-end.
- 🔵 **Nextcloud Talk file sharing** — the real client-side file share format has not yet been verified against a production Nextcloud client (covered by mock/E2E harness so far).
- 🔵 **Slack Inbound** (receiving messages from Slack, as opposed to only outbound) — planned for a later phase.

There is currently **no Twitch adapter**; it was removed during the Phase 2 cleanup and is not a supported platform.

## Architecture Diagram

```
┌─────────────┐     ┌─────────────────────────────┐
│  pi agent   │◄───►│        pi-gateway           │
│  (RPC)      │     │                             │
└─────────────┘     │  ┌─────────────────────┐    │
                    │  │ Platform Adapters    │    │
┌─────────────┐     │  │ Discord · Telegram   │    │
│ HTTP / WS   │────►│  │ Slack · WhatsApp     │    │
│ Clients     │     │  │ WebSocket / Web      │    │
└─────────────┘     │  └─────────────────────┘    │
                    │                             │
                    │  ┌─────────────────────┐    │
                    │  │ Sessions Store      │    │
                    │  │ Background Manager  │    │
                    │  │ Security Layer      │    │
                    │  └─────────────────────┘    │
                    └─────────────────────────────┘
```

- **Platform adapters** translate incoming platform messages into a unified `PlatformMessage` format
- **Sessions store** (`SQLite`) persists per-chat state with reset policies
- **Background manager** spawns async child processes, delivers results via chat
- **Security layer** enforces rate limits, allowlists, pairing codes, admin roles, and tool policies

## License

[MIT](LICENSE) — see the copyright chain in [LICENSE](LICENSE) for the upstream projects.
