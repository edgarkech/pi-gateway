# pi-gateway Roadmap

## 🎯 Goal

A robust, modular channel adapter for the pi coding agent — reliable communication with your agent from outside (e.g. via Telegram and Nextcloud Talk), with full file-attachment support so the agent can process documents and images.

---

## 🗺️ Roadmap

### Phase 1: Foundation (Architecture & Core) — ✅ COMPLETED

- [x] **Modularization of `index.ts`** — monolith split into logical modules (`src/core/`, `src/adapters/`, `src/sessions/`, `src/security/`); `src/index.ts` is a thin entry point; logic distributed behavior-neutral via the `runtime` container.
- [x] **Session isolation** — RPC protocol extended: `sessionId` is passed per message to the pi agent.
- [x] **Race condition fix** — completion handling moved from a FIFO queue to a mapping (`Map<sessionId, PendingRequest>`), so responses are correctly assigned to their chats.

### Phase 2: Cleanup (Stabilization & Quality) — ✅ COMPLETED

- [x] **Rate limiting** correctly active in the message path.
- [x] **Pairing flow** (code generation) integrated into the message path.
- [x] **Platform union cleanup** — unused/removed platforms pruned (`twitch` removed).
- [x] **WhatsApp robustness** (dependencies, imports).
- [x] **TypeScript `strict` mode** enabled, `any` types eliminated.
- [x] **Consistent formatting** via Prettier + linting via ESLint.
- [x] **Unit tests** for core modules established (Vitest).
- [x] **Documentation** synchronized with the actual code.

### Phase 2.5: Operational Validation & Deployment — ✅ COMPLETED

- [x] **Deployment & installation audit** — clean install, service integration (systemd user service), environment check.
- [x] **End-to-end connectivity test** — full message-path loop verified for the primary adapter.
- [x] **Formalized deployment process** — install/update/reset/uninstall/verify scenarios via `scripts/deploy.sh` (see `docs/deployment.md`), including rollback points and secrets-safe backups.

### Phase 3: Input Expansion (File Attachments) — ✅ COMPLETED

- [x] **`PlatformMessage` extension** for attachments (metadata, local path).
- [x] **Central `media/` module** — download logic, local storage, magic-byte validation, TTL cleanup.
- [x] **Integration** into the Telegram adapter (and Nextcloud Talk).
- [x] **Prompt materialization** — "user attached file X…" handed to the pi agent.

### Phase 4: Channel Expansion (Nextcloud Talk) — ✅ COMPLETED

- [x] **`OcsClient` + Talk types** — Talk OCS API methods, WebDAV file streams, error codes.
- [x] **`talk_state` watermark store** — SQLite, warm start, room pruning.
- [x] **`NextcloudTalkPoller`** — long-poll primary / interval fallback, backoff + circuit breaker, anti-loop self-filter.
- [x] **`NextcloudTalkAdapter`** — inbound pipeline (`isPublishable` anti-loop core, rich-text resolution, WebDAV media ingest), outbound (send/edit/delete, chunking for long messages).
- [x] **Config integration** — env overrides, registry wiring, daemon shutdown sequence.
- [x] **Pipeline E2E + anti-loop edge tests** — full inbound → WebDAV → media → adapter → agent-answer flow over a mock Nextcloud; invariant: exactly one agent call per user message.
- [x] **E2E validation against a real Nextcloud 33 instance** — receive, answer, media inbound, loop-freedom, restart (incl. OCS statuscode-compat and per-endpoint API version negotiation).
- [x] **Read markers** — mark room read after processing (Nextcloud unread counter clears).
- [x] **Room discovery** — `autoDiscoverRooms` + refresh interval merged with configured rooms.

---

## 🎬 Next Up

- [x] **Slash commands over channels** — specified (`docs/slash-commands.md`) and implemented (2026-10-05): curated set `/stop`, `/new`, `/status`, `/model` with config-driven room classification (`roomTypes`: `groupHuman`/`groupBot`), admin-only + room-type gating, central text-level parsing (no native platform registries), Talk anti-loop filter opened selectively for the known set. Live verification against a production NC-Talk room pending (deployment on igor).
- [ ] **Live verification of slash commands** — configure `roomTypes` in the production config and exercise all four commands per room type on NC Talk (1:1, groupHuman, groupBot incl. forwarding behavior).

---

## 🔵 Open Items (prioritized)

- [ ] **Nextcloud Talk file sharing with a real client** — the client-side file share format is covered by mock/E2E harness so far; verify against a production Nextcloud client.
- [ ] **Session-per-Room live verification** — implemented and tested (mock level); verify with a live message series à la QED-Test (3 rooms, overlapping → 3 pi session files, no rejections), then enable `sessions.perRoom` in production config.
- [ ] **No streaming in bot groups** — in group chats where other (allowed) bots are present, streaming edits (`editMessage` on the "⏳ Thinking…" placeholder) should be disabled: every edit is a new room event and can trigger the other bots. The per-room switch is now trivial: the `roomTypes` classification from the slash-commands feature (`docs/slash-commands.md`, §2) already marks `groupBot` rooms — wire the streaming disable to it and send the final message in one piece.
- [ ] **Telegram offset not persisted** — the long-poll offset lives in memory only. Two effects: (1) within a run, a failed `handleUpdate` loses the message (at-most-once); (2) after a gateway restart, Telegram re-delivers unacknowledged updates (~24 h window) and the pipeline has no dedup by `message_id` → the same message can be processed twice. Mitigation: persist the offset (e.g. in the sessions DB) and/or dedup recent `message_id`s.
- [ ] **HTML/markdown formatting mismatch** (issue #1) — channel meta-messages use markdown-style markup (`*bold*`, backticks) but the Telegram adapter sends with `parse_mode: HTML`, so the markers render literally. Align formatting conventions across pipeline messages and adapters.
- [ ] **TUI status flapping** — cosmetic flicker of the status footer in idle mode (RPC timing); generation counter exists, test invariant missing.
- [ ] **SIGHUP-based config reload** — config-file watching already triggers an adapter restart; explicit SIGHUP signal path not implemented.
- [ ] **Telegram webhook secret verification** — `webhookSecret` is passed to Telegram (`secret_token`) but the incoming `X-Telegram-Bot-Api-Secret-Token` header is never verified ("Verify secret here"). Deferred: webhook mode is not in use (long polling is primary); implement when webhook mode is actually needed.

---

## ⏸️ Deferred (no current priority)

- [ ] **Slack inbound** — receiving messages from Slack (outbound only today). Explicitly deprioritized (2026-10-04): parked at the very back until the items above are done.

---

*Last updated: 2026-10-05*
