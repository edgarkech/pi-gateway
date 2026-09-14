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

## 🔵 Open Items

- [ ] **Nextcloud Talk file sharing with a real client** — the client-side file share format is covered by mock/E2E harness so far; verify against a production Nextcloud client.
- [ ] **TUI status flapping** — cosmetic flicker of the status footer in idle mode (RPC timing); generation counter exists, test invariant missing.
- [ ] **SIGHUP-based config reload** — config-file watching already triggers an adapter restart; explicit SIGHUP signal path not implemented.
- [ ] **Slash commands over channels** — currently out of scope: the anti-loop filter drops Talk slash-commands (`messageType=command`); gateway meta-commands run as plain text messages. Decision on real Talk slash-command support pending.
- [ ] **Slack inbound** — receiving messages from Slack (outbound only today), planned for a later phase.

---

*Last updated: 2026-09-14*
