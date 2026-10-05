# Spec — Slash Commands over Channels (NC-Talk-first)

**Status:** Specified 2026-10-05 · Implementation pending
**Decisions:** Edgar, 2026-10-05 (session pi-gateway)

---

## 1. Scope & Goals

- A small, curated command set usable **on the channels** (today `/gateway`
  is a TUI-only extension command; channels have no command processing).
- **NC Talk is the primary target platform**; the design must stay
  platform-agnostic in the pipeline (Telegram etc. can adopt later).
- **No native platform command registries.** Central text-level parsing in
  the gateway. (A native Talk registry would require a Nextcloud app
  extension on the NC server — explicitly rejected: upgrade burden, and the
  NC server stays untouched.)
- `/gateway` admin commands (pair/allow/admin/tool-policy/…) remain TUI-only.

## 2. Room Classification (R1)

Three room types: `dm` (implicit) · `groupHuman` · `groupBot`.

- **Configuration-driven only.** No auto-detection: some bots are
  deliberately configured as regular Nextcloud accounts, so bot detection is
  not reliable.
- Config schema (new field under the Talk platform config):

  ```json
  "platforms": {
    "nextcloudTalk": {
      "roomTypes": {
        "<roomId>": "groupHuman",
        "<otherRoomId>": "groupBot"
      }
    }
  }
  ```

- Unclassified group rooms default to `groupHuman` (conservative).
- DMs need no entry — implicit from existing room-type detection
  (`message-pipeline.ts` already resolves `dm`/`group`/`unknown`).
- **Synergy (out of scope here):** the same classification later serves the
  open item "No streaming in bot groups" (per-room streaming switch).

## 3. Command Set & Semantics (R2)

| Command | Semantics |
|---|---|
| `/stop` | Abort the current generation for this room; session is kept |
| `/new` | Reset the session for this room (fresh pi session) |
| `/status` | Compact health report: agent connection, adapters, **active model**, **context usage** |
| `/model` | No argument: show current model · with argument: switch model |

## 4. Permission Matrix (R4)

Commands are **admin-only** (`isAdmin(platform, userId)` from
`src/security/auth.ts`) **and** room-type-gated:

| Command | 1:1 (dm) | groupHuman | groupBot |
|---|---|---|---|
| `/stop` | ✅ | ✅ | ❌ |
| `/new` | ✅ | ❌ | ❌ |
| `/status` | ✅ | ✅ | ❌ |
| `/model` | ✅ | ❌ | ❌ |

Out-of-matrix behavior:

- **groupBot rooms:** no slash commands are processed at all. The text is
  **forwarded to the agent as a normal message** (silent drop would be more
  confusing). No command acknowledgement — any output in a bot group is an
  event for the other bots.
- **Non-admin in 1:1 / groupHuman:** the command is **not** forwarded to the
  agent; the user gets one short acknowledgement, e.g.
  `⚠️ This command requires admin privileges.` (Option A).

## 5. Parsing & Talk Filter (R3)

- Central parsing in the message pipeline, **before agent handoff**: first
  token of the message matches the known set (`/stop`, `/new`, `/status`,
  `/model`), case-insensitive. Non-matching text flows through unchanged.
- **Talk adapter filter:** `src/adapters/nextcloud-talk.ts` currently drops
  every `messageType === "command"` (anti-loop, ~line 164). Open this filter
  **selectively for the known command set**; all other Talk commands stay
  dropped (the anti-loop invariant must hold).
- The OCS poller (`src/adapters/nextcloud/poller.ts`) stays clean — it
  deliberately delegates message-type decisions to the adapter.

## 6. `/status` Details

- Must include: agent connection state, adapter status, **active model**,
  **context usage** of the room's session.
- Model + context must come from the pi RPC where available. If the RPC does
  not expose one of them, fall back to config-derived info and document the
  limitation in `result.md` (accepted by Edgar).

## 7. `/model` Details

- Model identifiers follow the pi provider config (`~/.pi/agent/models.json`):
  local provider AGENT (qwen38-27b models) and CLOUD (z-ai/glm-5.3-flash,
  deepseek/deepseek-v4-flash-0731).
- The implementer must verify what the pi RPC supports for **runtime model
  switching**. If not supported: `/model` shows the current model and answers
  that live switching is not supported (document in `result.md`).

## 8. File Map (complete — no guessing needed)

| Path | Role |
|---|---|
| `src/config.ts` | Config schema + loading (add `roomTypes`) |
| `src/core/message-pipeline.ts` | Inbound pipeline; room-type detection (`dm`/`group`/`unknown`); security-layer integration — command parsing hooks in here |
| `src/adapters/nextcloud-talk.ts` | Talk adapter; `isPublishable` filter drops `messageType=command` (~line 164) — open selectively |
| `src/adapters/nextcloud/poller.ts` | OCS poller (expected: no changes) |
| `src/core/commands.ts` | TUI `/gateway` extension command (no changes; reference for status reporting) |
| `src/status.ts` | Gateway status report builder |
| `src/security/auth.ts` | `isAdmin(platform, userId)` |
| `src/core/rpc.ts` | pi RPC client (sessionId-multiplexed) |
| `tests/` | Vitest unit tests |
| `ROADMAP.md` | Update after implementation (Next Up item → spec reference; note streaming-item synergy) |

## 9. Acceptance Criteria

1. Unit tests cover: command parsing, permission matrix (admin × room type),
   Talk filter opening + anti-loop invariant for unknown commands, groupBot
   forwarding behavior, non-admin acknowledgement.
2. `tsc` strict + ESLint pass.
3. Config: unclassified groups default to `groupHuman`; config reload picks
   up `roomTypes` changes.
4. `ROADMAP.md` updated (Next Up item marked specified/implemented; open
   item "No streaming in bot groups" notes the reusable classification).
