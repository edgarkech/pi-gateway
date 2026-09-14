# pi-gateway — Refactor Progress Log (Phase 1.2 / W1)

**Branch:** `refactor/w1-modularization`
**Worker:** coder-20260819-125053 (PiWorker Coder)
**Plan:** `refactor_plan_phase_1.md` (Section 5, Steps 0–1)

---

## Step 0 — Baseline & Branch

- **Date:** 2026-08-19
- **Branch:** `refactor/w1-modularization` (created from `main` @ 04caf7f)
- **Command:** `git checkout -b refactor/w1-modularization` (see note)
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Baseline Regression:** `npx tsx tests/index.ts` → `status tests passed` ✅
- **Commit:** `cb1cb9d` "Step 0: baseline & branch (refactor/w1-modularization)"

> Note: The branch already existed and was checked out on arrival; verified clean
> against `main`. Full S1–S14 baseline catalog (live Telegram/Discord/WSS, Pi TUI
> inline + daemon) requires services not available in this sandbox; the feasible
> subset (S1 build, unit-test regression, module-load) was executed here.

---

## Step 1 — Foundation (`types.ts` + `config.ts` + `state.ts`)

- **Modules created:**
  - `src/types.ts` — `GatewayConfig`, `GatewayState` (verbatim from `index.ts`)
  - `src/config.ts` — `DEFAULT_CONFIG`, `mergeGatewayConfig`, `loadConfig`,
    `readDetachedHealthConfig`, `getDetachedGatewayHealth`
  - `src/state.ts` — `GatewayRuntime` container, `runtime` singleton,
    `initRuntime()`
- **`src/index.ts` changes:**
  - Removed moved blocks; added imports from `state.js`/`config.js`.
  - All global state accesses → `runtime.*`
    (`config/state/server/wss/rpcProcess/globalCtx/cronInterval/statusRefreshInterval
    /lastGatewayStatusText/statusUpdateGeneration/configReloadQueue/daemonShuttingDown`).
  - Replaced both duplicated init sites (default-export + `detachAndRun`)
    with `initRuntime()`.
  - Removed now-unused imports (`copyFileSync`, `mkdirSync`, `normalizeGatewayHealthConfig`,
    `fetchGatewayHealth`, `ExtensionContext`, `SessionConfig`, `BaseAdapter`).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ module graph loads with no import-cycle crash
    (`node -e "import './dist/index.js'"` → default export is a function).
  - S2 ✅ default-export init via mock Pi API: `initRuntime()` sets
    `runtime.config` (port 3847/host localhost), fresh `runtime.state` Maps,
    `runtime.lastDetachedHealthConfig`, registers /gateway command + 5 tools +
    session hooks.
  - Config↔state deferred cycle verified safe: `readDetachedHealthConfig`
    fallback + override behavior unchanged.
- **Verification (R1/R4):** `mergeGatewayConfig`, `loadConfig`,
  `readDetachedHealthConfig` byte-identical to originals (only state-access
  rewrites); git diff shows only `runtime.*` prefixes + import changes.
- **Commit:** `8762724` "Step 1: foundation — types.ts, config.ts, state.ts"

---

## Next

- Step 2 — `core/rpc.ts` (not part of this task).
## Step 2 — `core/rpc.ts`

- **Worker:** coder-20260819-135548 (PiWorker Coder)
- **Modules created:**
  - `src/core/rpc.ts` — `PendingRequest`/`pendingRequests` + `PendingCompletion`/
    `pendingCompletions` (private FIFO), `startRpc()` (= `createRpcProcess`, broadcast
    via `runtime.hooks.broadcast`), `sendRpc()`, `extractAgentEndText()` (private),
    `sendPromptRpc()`, new `stopRpc()`, `restartRpc()`, `isAgentRunning()`,
    `peekActiveCompletion()`, `resetActiveStream()`.
- **`src/index.ts` changes:**
  - Removed the entire RPC layer (`createRpcProcess`, `sendRpc`,
    `extractAgentEndText`, `sendPromptRpc`, pending* interfaces/arrays); added
    imports from `./core/rpc.js`.
  - `startGatewayServer` → `runtime.rpcProcess = startRpc()`; additionally registers
    `runtime.hooks.broadcast = broadcastClients` (transitional wire so broadcasts
    keep working until Step 5 moves `broadcastClients` into `core/server.ts`).
  - `/restart` (onMessage, inline) kill/reject/respawn block → `restartRpc()`.
  - `stopGatewayServer` → `stopRpc()`.
  - Status/health checks (`runtime.rpcProcess`) → `isAgentRunning()` (onMessage
    guards, HTTP `/api/status`, `/gateway status` ×2, daemon shutdown guard,
    stopGatewayServer early-return).
  - adapterCallbacks streaming: `pendingCompletions[0].streamedText` →
    `peekActiveCompletion()?.streamedText`; `pendingCompletions[0].streamedText = ""`
    → `resetActiveStream()`.
  - Removed now-unused imports (`getPackageRoot`, `handleExtensionUiRequest`,
    `setStdinWriter`, `getActiveChannel`, `flushHandler`, `cleanupPendingUiRequests`).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ module graph loads, no import-cycle crash
    (`import('./dist/index.js')` → default export is a function; `./dist/core/rpc.js`
    exports exactly 8 functions).
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed".
  - S3/S4 mock ✅ RPC API surface: `isAgentRunning`, `peekActiveCompletion`,
    `resetActiveStream` (null-safe), `stopRpc` (kill+null), `restartRpc`
    (kill+respawn) — 8/8 assertions passed. (Full live Telegram prompt round-trip
    requires external services unavailable in this sandbox.)
  - R1 ✅ byte-identical diff of moved RPC layer vs Step-1 original (modulo
    `broadcastClients`→`runtime.hooks.broadcast?.` + rename `createRpcProcess`→`startRpc`).
- **Commit:** pending ("Step 2: core/rpc.ts").

## Step 3 — `core/daemon.ts` (Part 1) + `core/status-footer.ts` (Part 1) + `core/message-pipeline.ts`

- **Worker:** coder (task: coder-20260819-144831)
- **Modules created:**
  - `src/core/daemon.ts` (Part 1) — `PID_FILE`, `isDaemonMode` (= `IS_DAEMON`),
    `readDaemonPid()` (verbatim).
  - `src/core/status-footer.ts` (Part 1) — `updateStatus()`,
    `STATUS_REFRESH_INTERVAL_MS` (verbatim; state accesses already `runtime.*`).
  - `src/core/message-pipeline.ts` — entire `adapterCallbacks` object verbatim.
    State/config accesses already `runtime.*`; `IS_DAEMON` → `isDaemonMode`
    (imported from `./daemon.js`); `updateStatus` imported from `./status-footer.js`;
    streaming accesses use (Step-2) `peekActiveCompletion()`/`resetActiveStream()`
    as already prepared in source.
- **`src/index.ts` changes:**
  - Removed `STATUS_REFRESH_INTERVAL_MS`, `PID_FILE`, `readDaemonPid`,
    `adapterCallbacks`, `updateStatus`, `const IS_DAEMON`.
  - Added imports from `./core/daemon.js` (`PID_FILE`, `isDaemonMode`,
    `readDaemonPid`), `./core/status-footer.js` (`updateStatus`,
    `STATUS_REFRESH_INTERVAL_MS`), `./core/message-pipeline.js` (`adapterCallbacks`
    — still used by local `initializeAdapters`, which moves in Step 4).
  - `mode: IS_DAEMON` → `mode: isDaemonMode`; top-level dispatch `if (isDaemonMode)`.
  - Removed now-unused imports (`getOrCreateSession`, `GATEWAY_CONFIG_DIR`,
    `parseGatewayPid`, `resolveGatewayStatus`, `buildPolicyGuard`,
    `handleInteractiveResponse`, `setActiveChannel`, `setStreamRedirectHandler`,
    `setFlushHandler`, `BaseAdapter`-type subset, `sendPromptRpc`, `restartRpc`,
    `peekActiveCompletion`, `resetActiveStream`).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ `node -e "require('./dist/index.js'/new core modules)"` → module graph
    loads, no import-cycle crash; daemon exports `[PID_FILE, isDaemonMode,
    readDaemonPid]`, status-footer `[STATUS_REFRESH_INTERVAL_MS, updateStatus]`,
    message-pipeline `[adapterCallbacks]`.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed".
  - S5-partial ✅ `npx tsx tests/step3-smoke.ts` → real `adapterCallbacks.onMessage`
    with mocked runtime+adapter: `/model list` guard ("Agent not running."),
    `/restart` non-admin (no platform action), `onDisconnect` (updateStatus, no
    crash). (Full live Telegram inline-buttons render blocked by external services
    unavailable in sandbox, same as Step 2. Allowlist-rejection case not runnable via
    mock because `isUserAllowed` reads allowAll from the config FILE, not runtime.)
  - R1 ✅ `readDaemonPid`/`updateStatus` byte-identical to Step-2 originals via
    `awk` diff; `adapterCallbacks` verbatim except `IS_DAEMON`→`isDaemonMode`.
- **Commit:** `65948f0` "Step 3: core/daemon.ts (part 1), core/status-footer.ts (part 1), core/message-pipeline.ts"

## Step 4 — `adapters/registry.ts` + `sessions/store.ts` (+)

- **Worker:** coder (task: coder-20260819-155806)
- **Modules created / updated:**
  - `src/adapters/registry.ts` (NEW) — `initializeAdapters()` moved verbatim from
    `index.ts`; imports `adapterCallbacks` from `./../core/message-pipeline.js`;
    adapter classes from `./discord|twitch|telegram|slack|whatsapp.js`; `logger`;
    `runtime`.
  - `src/sessions/store.ts` (+) — new `listActiveChannels()` returning
    `Array<{ platform; channelId }>`; SQL verbatim from `stopGatewayServer()`
    (`SELECT DISTINCT platform, channel_id FROM sessions WHERE is_background = 0`),
    camelCase-mapped per plan §3.5. (`stopGatewayServer` NOT yet rewired to it —
    that is Step 5, per plan; no scope creep.)
- **`src/index.ts` changes:**
  - Removed the local `initializeAdapters()` function (108 lines) and the now-unused
    adapter-class + `adapterCallbacks` imports; added `import { initializeAdapters }
    from "./adapters/registry.js"`.
  - The `await initializeAdapters();` call in `startGatewayServer` now resolves to
    the registry import — adapters still populate `runtime.state.adapters` for
    `/api/status`.
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean; `dist/adapters/registry.js` emitted.
  - S2 ✅ module graph loads, no import-cycle crash; `registry` exports
    `[initializeAdapters]`; `store` exports `listActiveChannels`.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed".
  - S4-partial ✅ `npx tsx tests/step4-smoke.ts` → `initializeAdapters()` with default
    (all-disabled) config runs clean via `runtime` and registers 0 adapters;
    enabled-but-unreachable platform is handled gracefully by the original try/catch;
    `/api/status`'s adapter source (`runtime.state.adapters`) is the same Map the
    registry writes; `listActiveChannels()` reads the session DB and returns the
    planned camelCase shape with DISTINCT pairs. (Full live Discord/Telegram/...
    client start with tokens blocked by external services unavailable in sandbox —
    same as Steps 1–3.)
  - R1 ✅ `initializeAdapters` body byte-identical to Step-3 original via `awk` diff,
    modulo `export` + import rewrite.
- **Commit:** `pending` ("Step 4: adapters/registry.ts + sessions/store.ts (part 2)")

## Step 5 — `core/server.ts`

- **Worker:** coder (task: coder-20260819-162646)
- **Modules created / updated:**
  - `src/core/server.ts` (NEW) — the major server module:
    - `verifyToken()`, `authenticate()` (moved verbatim).
    - `sendWs()`, `broadcastClients()` (moved verbatim; `broadcastClients` is now
      exported).
    - `startCron()` / `stopCron()` (moved verbatim).
    - `handleHttpRequest()` (CORS + Telegram-webhook + auth + `/api/*`) — verbatim.
    - `handleWebSocket()` (WS-auth, client-registry, prompt/background/ping) — verbatim.
    - `startGatewayServer()` — verbatim, AND registers `runtime.hooks.broadcast =
      broadcastClients` (completes the "transitional wire" prepared in Step 2).
    - `stopGatewayServer()` — **direct SQL query replaced with
      `listActiveChannels()`** from `./sessions/store.js` (per plan §3.5 / S14);
      `row.channel_id` → `row.channelId`; RPC kill → `stopRpc()` import is no longer
      needed here (stopRpc is already the one true entry, imported into server.ts
      from `./rpc.js`).
  - `src/index.ts` changes:
    - Removed the HTTP/WS/Cron/Server-Lifecycle block (`verifyToken`, `authenticate`,
      `sendWs`, `broadcastClients`, `startCron`, `stopCron`, `handleHttpRequest`,
      `handleWebSocket`) and the `startGatewayServer`/`stopGatewayServer` definitions.
    - Added `import { startGatewayServer, stopGatewayServer } from "./core/server.js"`.
    - Removed now-unused imports (`createServer`, `IncomingMessage`, `ServerResponse`,
      `WebSocketServer`, `WebSocket`, `randomBytes`, `startRpc`, `stopRpc`, `sendRpc`,
      `initializeAdapters`, `touchSession`, `startBackgroundTask`,
      `getPendingResultsForSession`, `markTaskDelivered`).
    - All `/gateway` call sites now use the imported `startGatewayServer`/`stopGatewayServer`.
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ module graph loads, no import-cycle crash; `core/server.ts` exports
    `[broadcastClients, handleHttpRequest, handleWebSocket, startGatewayServer,
    stopGatewayServer]`.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed"; `step3-smoke`
    and `step4-smoke` still pass.
  - S8 ✅ **real server lifecycle** `tests/step5-smoke.ts`: `startGatewayServer`
    (port 0) → HTTP `/api/status` correct (`running:true, mode:inline, pid`), unknown
    `/api/*` → 404, real WS client connect + ping round-trip, and the Step-2
    transitional wire verified (`runtime.hooks.broadcast === broadcastClients`),
    plus `broadcastClients` delivering a custom event to an open WS client.
  - S9 ✅ cron interval installed on start, cleared on stop.
  - S14 ✅ `stopGatewayServer` sends the shutdown message to an active channel via
    `listActiveChannels()` (fake adapter observes `"shutting down"` message; no direct
    DB query / `channel_id` remains in server code).
- **R1 ✅** all moved functions byte-identical to Step-4 originals (via programmatic
  brace-matched diff) except the planned `stopGatewayServer` change
  (SQL → `listActiveChannels()` + `channel_id`→`channelId`).
- **Commit:** `d82f964` ("Step 5: core/server.ts")

## Step 6 — `core/daemon.ts` (Part 2) & Bootstrap

- **Worker:** coder (task: coder-20260819-165809)
- **Modules created / updated:**
  - `src/core/daemon.ts` (COMPLETED) — added Part 2 functions:
    - `reloadDaemonConfig()` — moved verbatim; config/state accesses already use
      `runtime.config`; calls `stopGatewayServer()`/`startGatewayServer()` imported
      from `./server.js`. Listener-rollback path (occupied port → restore previous
      config + rewrite config file) preserved 1:1.
    - `startConfigWatcher()` — moved verbatim; uses `runtime.daemonShuttingDown` and
      `runtime.configReloadQueue`.
    - `detachAndRun()` — moved verbatim; init-duplicate now calls `initRuntime()`
      (plus `initSessionStore`/`initSecurityStore`/`initBackgroundTasks`); shutdown
      handler (SIGTERM/SIGINT/uncaughtException/unhandledRejection), SIGHUP reload and
      PID-file acquire/remove preserved; guarded stop via `isAgentRunning()`.
    - `bootstrapIfDaemon()` — **NEW** top-level dispatch: `if (isDaemonMode) void
      detachAndRun();` (replaces the inline `if (isDaemonMode) …` block).
    - `spawnDetachedDaemon()` — **NEW** (per plan §3.5): encapsulates the `/gateway
      start -d` spawn + health-verify flow, returning a discriminated outcome
      (`already-running | refusing | failed-pid | failed-verify | started`) so the
      caller reproduces the original notifications 1:1 (including the `failed-verify`
      PID). Re-exports `PID_FILE` and `readDaemonPid` for later commands/tools steps.
  - `src/index.ts` changes:
    - Removed `reloadDaemonConfig`, `startConfigWatcher`, `detachAndRun`, and the
      top-level `if (isDaemonMode) { detachAndRun(); }` dispatch.
    - Replaced the top-level dispatch with a single `bootstrapIfDaemon();` call
      (kept after the default-export declaration — same evaluation order as before).
    - Replaced the inline `start -d` spawn/verify block with a `spawnDetachedDaemon()`
      invocation that reproduces the exact notifications.
    - Removed now-unused imports (`existsSync`, `readFileSync`, `writeFileSync`,
      `watchFile`, `unwatchFile`, `spawn`, `GATEWAY_CONFIG_FILE`, `removeGatewayPidFile`,
      `writeGatewayPidFile`, `mergeGatewayConfig`, `PID_FILE`, `isDaemonMode`).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S6/S10 ✅ SIGHUP config reload: daemon stays up and healthy after `kill -HUP`.
  - S10 ✅ **real daemon lifecycle** `node dist/index.js --daemon`:
    - Start → PID file written (`gateway.pid`), `/api/status` = `{running:true,
      mode:"daemon", pid, agent:true}` (S2 path via the shared `startGatewayServer`).
    - Config-edit (`idleMinutes` 1440→100) → watcher reload: daemon stays alive &
      healthy.
    - Listener rollback: set `port` to an occupied port (5355) + SIGHUP → rebind
      fails → rollback → server healthy again on 3847, config file restored to 3847,
      daemon alive.
    - Stop (SIGTERM) → PID file removed, process terminated, port released.
  - S11 ✅ `node dist/cli.js` start/status/stop regression: start → 🟢 Verified
    (PID + health), stop → PID file cleaned, `🔴 Not running`.
- **R1 ✅** all moved functions byte-identical to Step-5 `index.ts` originals except
  the state-access/signature updates required by the plan (`runtime.*`, server.js
  imports, and the new `spawnDetachedDaemon`/`bootstrapIfDaemon` entry points). No
  logic or type changes.
- **Commit:** `b890158` ("Step 6: core/daemon.ts (part 2) & bootstrap")

---

## Step 7 — `core/status-footer.ts` (Part 2)

- **Worker:** coder (task: coder-20260819-172336)
- **Modules updated:**
  - `src/core/status-footer.ts` — added `registerStatusFooter(pi: ExtensionAPI)`:
    registers the `pi.on("session_start", …)` and `pi.on("session_shutdown", …)`
    hooks moved verbatim from `index.ts` (the `STATUS_REFRESH_INTERVAL_MS` refresh
    interval + `runtime.*` state reset logic kept 1:1). Exported alongside
    `updateStatus`/`STATUS_REFRESH_INTERVAL_MS`.
  - `src/index.ts` changes:
    - Removed the two `pi.on("session_start"…"/session_shutdown"…)` listener blocks.
    - Import swapped from `{ updateStatus, STATUS_REFRESH_INTERVAL_MS }` →
      `{ registerStatusFooter }` (the other two symbols no longer referenced here).
    - Added `registerStatusFooter(pi);` call inside the default export (in place of
      the removed hook blocks, keeping the "Keep the footer synchronized…" comment).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean; `dist/core/status-footer.js` emits exactly
    `[STATUS_REFRESH_INTERVAL_MS, registerStatusFooter, updateStatus]`.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed"; `step3-smoke`,
    `step4-smoke`, `step5-smoke` still pass.
  - S2 ✅ module graph loads, no import-cycle crash; default export is a function.
  - S12 ✅ `tests/step7-smoke.ts` — `registerStatusFooter` registered by default
    export (both `session_start`/`session_shutdown` hooks captured via mock Pi);
    simulated `session_start` stores `globalCtx`, installs the refresh interval, and
    `updateStatus` → `ctx.ui.setStatus` is reachable; `session_shutdown` clears the
    interval and resets `globalCtx`/`lastGatewayStatusText` + bumps
    `statusUpdateGeneration`. 13/13 assertions.
  - (Full live Pi-TUI footer render at session boundaries requires the Pi app /
    external services unavailable in sandbox — covered by mocks per task spec.)
- **R1 ✅** session hook blocks moved verbatim (diffs confirm byte-identical body; all
  state accesses already `runtime.*` from Step 1); no logic or type changes.
- **Commit:** `a3af364` ("Step 7: core/status-footer.ts (part 2)")

## Step 8 — `core/commands.ts`

- **Worker:** coder (task: coder-20260819-174053)
- **Modules created / updated:**
  - `src/core/commands.ts` (NEW) — `registerGatewayCommand(pi: ExtensionAPI)` wrapping
    the entire `/gateway` command handler (`pi.registerCommand("gateway", …)` with all
    subcommands: start/stop/restart/status/pair/allow/revoke/admin/sessions/tasks/
    config/tool-policy + help + `getArgumentCompletions`), moved verbatim from `index.ts`.
    - `start -d` spawn → `spawnDetachedDaemon()` (from `./daemon.js`).
    - `/gateway status` agent check → `isAgentRunning()` (from `./rpc.js`).
    - `/gateway sessions` → `listSessions()` (from `../sessions/store.js`).
    - `/gateway config` block → display-only (unchanged — no reload exists in the
      handler; `reloadDaemonConfig` is daemon-only via watcher/SIGHUP and is not part
      of the `/gateway config` command path, so none was added — per R1/R4).
    - Server start/stop → `startGatewayServer`/`stopGatewayServer` (from `./server.js`).
    - All state/config accesses use `runtime.*`.
  - `src/index.ts` changes:
    - Removed the entire `pi.registerCommand("gateway", …)` block.
    - Added `import { registerGatewayCommand } from "./core/commands.js"` and the
      `registerGatewayCommand(pi)` call (kept the original "Register commands"
      position, before the tools — same call ordering as before; `registerStatusFooter`
      remains last as it was).
    - Removed now-unused imports that only served the command block:
      `waitForGatewayHealth` (status), `loadConfig` (config), `addToAllowlist`,
      `listAllowlistedUsers`, `revokeUserAccess`, `addAdmin`, `removeAdmin`,
      `listAdmins` (auth), `spawnDetachedDaemon` (daemon), `startGatewayServer`,
      `stopGatewayServer` (server).
    - Kept imports still used by the tools (the 5 `registerTool` blocks remain in
      index.ts until Step 9): `createGatewayStatusReport`, `readDetachedHealthConfig`,
      `getDetachedGatewayHealth`, `isAgentRunning`, `readDaemonPid`, `listSessions`,
      `listTasks`, `generatePairingCode`, `approvePairingCode`, `listPendingPairingCodes`,
      `setToolPolicy`, `removeToolPolicy`, `listToolPolicies`, `resetToolPolicies`,
      `getEffectivePolicySummary`, `Platform`, `Type`.
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ module graph loads, no import-cycle crash; `dist/core/commands.js` exports
    exactly `[registerGatewayCommand]`; default export is a function.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed"; `step3-smoke`,
    `step4-smoke`, `step5-smoke`, `step7-smoke` still pass.
  - S13 ✅ `tests/step8-smoke.ts` — default export registers the `/gateway` command;
    every subcommand completion present; exercised help, status (widget + agent via
    `isAgentRunning`), pair (pending list), allow (list), revoke (usage), admin
    list/add/remove, sessions, tasks, config, tool-policy defaults/set/list/reset;
    `start -d` delegates to `spawnDetachedDaemon()` (no-pid-file sandbox case resolves
    cleanly, no orphan daemon). 23/23 assertions.
- **R1 ✅** command handler body byte-identical to HEAD original (normalized whitespace
  diff) except the `registerGatewayCommand` function-wrapper closing brace; only the
  planned import/state-access cosmetics applied. No logic or type changes.
- **Commit:** `211c556` ("Step 8: core/commands.ts")

## Step 9 — `core/tools.ts`

- **Worker:** coder (task: coder-20260819-181357)
- **Modules created / updated:**
  - `src/core/tools.ts` (NEW) — `registerGatewayTools(pi: ExtensionAPI): void` wrapping
    the 5 `pi.registerTool(...)` calls moved verbatim from `index.ts`:
    `gateway_status`, `gateway_sessions`, `gateway_background_tasks`, `gateway_pairing`,
    `gateway_tool_policy`.
    - Imports: `Type` (typebox), `runtime` (../state.js), `readDetachedHealthConfig` /
      `getDetachedGatewayHealth` (../config.js), `createGatewayStatusReport`
      (../status.js), `listSessions` (../sessions/store.js), `listTasks`
      (../background/manager.js), `generatePairingCode` / `approvePairingCode` /
      `listPendingPairingCodes` / `type Platform` (../security/auth.js),
      `setToolPolicy` / `removeToolPolicy` / `listToolPolicies` / `resetToolPolicies` /
      `getEffectivePolicySummary` (../security/tool-policy.js), `isAgentRunning`
      (./rpc.js), `readDaemonPid` (./daemon.js).
    - All state/config accesses use `runtime.*` (verbatim — already were from Step 1).
    - Exports exactly `[registerGatewayTools]`.
  - `src/index.ts` changes:
    - Removed all 5 `pi.registerTool(...)` blocks (added `registerGatewayTools(pi)`
      call in the original "Register tools" position, right after
      `registerGatewayCommand(pi)` and before `registerStatusFooter(pi)` — identical
      call ordering to the original inline default-export body).
    - Added `import { registerGatewayTools } from "./core/tools.js"`.
    - Removed now-unused imports that only served the 5 tool blocks: `join` (node:path),
      `Type` (typebox), `listSessions` (store), `createGatewayStatusReport` (status),
      `isUserAllowed` / `isAdmin` / `approvePairingCode` / `generatePairingCode` /
      `listPendingPairingCodes` / `Platform` (auth), `setToolPolicy` / `removeToolPolicy` /
      `listToolPolicies` / `resetToolPolicies` / `getEffectivePolicySummary`
      (tool-policy), `listTasks` (background), `BaseAdapter` (adapters/base),
      `readDetachedHealthConfig` / `getDetachedGatewayHealth` (config), `isAgentRunning`
      (rpc), `readDaemonPid` (daemon).
    - Kept imports still used by the entry point: `initSessionStore` (store), `logger`,
      `initSecurityStore` (auth), `initBackgroundTasks` (background), `runtime` /
      `initRuntime` (state), `registerStatusFooter` (status-footer), `bootstrapIfDaemon`
      (daemon), `registerGatewayCommand` (commands), `registerGatewayTools` (tools),
      `ExtensionAPI` (type).
    - `index.ts` is now **52 lines** (goal `< ~100` realistic — remaining auth/admin/
      command/daemon-server helpers now live in their own modules).
- **Build-Gate (R2):** `npm run build` → `tsc` → **0 errors** ✅ (S1)
- **Smoke (R3):**
  - S1 ✅ build clean.
  - S2 ✅ module graph loads, no import-cycle crash; `dist/core/tools.js` exports
    exactly `[registerGatewayTools]`; default export is a function. Live daemon boot:
    `node dist/cli.js start` → daemon verified, HTTP server on localhost:3847,
    `/api/status` → `{"running":true,"mode":"daemon","pid":…,"agent":true}`; stopped
    cleanly after check.
  - S13 ✅ `tests/step9-smoke.ts` — default export registers all 5 gateway tools
    (exactly 5, no extras); exercised gateway_status (text + details), gateway_sessions
    (count), gateway_background_tasks (count), gateway_pairing (generate / missing-args
    error / list), gateway_tool_policy (defaults / set / list / remove / reset); and
    asserted tool dependency wiring on runtime/config/rpc/daemon. 27/27 assertions.
  - Regression ✅ `npx tsx tests/index.ts` ("status tests passed"); `step3`, `step4`,
    `step5`, `step7`, `step8` smoke suites still pass.
- **R1 ✅** the 5 tool bodies byte-identical to the pre-Step-9 `index.ts` (normalized
  diff confirms); only the `registerGatewayTools` function-wrapper + import cosmetics
  applied. The `params.status as any` cast on `listTasks` (Phase-2 B3/B8 target) and
  FIFO/`as any` casts were left untouched per R4. No logic or type changes.
- **Commit:** `d0d2b4c` ("Step 9: core/tools.ts")

## Step 10 — Abschluss, Cleanup & Audit (Phase 1.2 COMPLETE)

- **Worker:** coder (task: coder-20260819-183208)
- **Final cleanup of `src/index.ts`:**
  - Verified at **50 lines** — well under the `< ~100` target (plan §3.1 / Step 10.1).
  - Contains only: module/type Imports, `initRuntime()` (+ `runtime.lastDetachedHealthConfig
    = runtime.config` fallback), the 3× Store-Init calls (`initSessionStore` /
    `initSecurityStore` / `initBackgroundTasks`), `registerGatewayCommand(pi)`,
    `registerGatewayTools(pi)`, `registerStatusFooter(pi)`, the loaded-extension log line,
    and the top-level `bootstrapIfDaemon()` dispatch. Store-Init + `bootstrapIfDaemon` are
    explicitly part of the plan's target shape (§3.1: "Default-Export + Daemon-Dispatch
    + Store-Init").
  - **No unused imports** (verified: `ExtensionAPI`, `initSessionStore`, `logger`,
    `initSecurityStore`, `initBackgroundTasks`, `runtime`/`initRuntime`,
    `registerStatusFooter`, `bootstrapIfDaemon`, `registerGatewayCommand`,
    `registerGatewayTools` — all referenced). No redundant comments or lingering legacy
    code blocks remain. Per R4 (No Scope Creep) no logic lines were removed beyond what
    earlier steps already moved out.
- **Audit — module placement & exports (plan §3.1/§3.2):**
  - `types.ts` → `GatewayConfig`, `GatewayState` ✅
  - `config.ts` → `DEFAULT_CONFIG`, `merge/loadConfig`, `readDetachedHealthConfig`,
    `getDetachedGatewayHealth`, re-export `GatewayConfig` ✅
  - `state.ts` → `GatewayRuntime`, `runtime` singleton, `initRuntime()`, `GatewayHooks` ✅
  - `core/rpc.ts` → `startRpc/sendRpc/sendPromptRpc/stopRpc/restartRpc/isAgentRunning`
    /`peekActiveCompletion/resetActiveStream`; `pendingRequests`/`pendingCompletions`
    correctly private (FIFO encapsulated — B4/B7 preparation) ✅
  - `core/message-pipeline.ts` → `adapterCallbacks` ✅
  - `core/server.ts` → `broadcastClients/handleHttpRequest/handleWebSocket/startGatewayServer
    /stopGatewayServer` ✅
  - `core/commands.ts` → `registerGatewayCommand` ✅
  - `core/tools.ts` → `registerGatewayTools` ✅
  - `core/status-footer.ts` → `updateStatus/STATUS_REFRESH_INTERVAL_MS/registerStatusFooter` ✅
  - `core/daemon.ts` → `isDaemonMode/bootstrapIfDaemon/spawnDetachedDaemon` + re-export
    `PID_FILE/readDaemonPid`; `bootstrapIfDaemon` dispatch stays top-level in index.ts
    (same evaluation order as original) ✅
  - `adapters/registry.ts` → `initializeAdapters` ✅
  - `sessions/store.ts` → `listActiveChannels()` added ✅
  - **No new module-level mutable globals** anywhere in core/ (review-rule from §3.3): only
    `const` literals (`PID_FILE`, `STATUS_REFRESH_INTERVAL_MS`) and the private FIFO arrays
    inside rpc.ts. All mutable shared state lives on `runtime`.
- **Audit — runtime usage in core modules:**
  - `runtime.*` used consistently across all core modules (`core/rpc` 17, `core/server` 41,
    `core/daemon` 15, `core/commands` 26, `core/tools` 7, `core/status-footer` 21,
    `core/message-pipeline` 9, `adapters/registry` 24).
  - No lingering direct (non-`runtime`) accesses to the legacy module globals
    (`config/state/server/wss/rpcProcess/globalCtx/…`); remaining bare `config` references
    are string literals/comments/local vars only.
  - **Import-graph cycle safety:** the only cycles present are deferred ESM cycles
    (`state↔config`, `daemon↔server`, `status-footer→daemon`), all safe because the
    cross-module bindings are only read inside function bodies (never at module-eval time);
    confirmed empirically — `import('./dist/index.js')` loads with no cycle crash.
    `status-footer→daemon→server→…→status-footer` does NOT close (server does not import
    status-footer), respecting the plan's cycle-avoidance design (§3.4) in substance.
- **Final Smoke-Test (Full Audit, plan §6):** all feasible S1–S14 run green.
  - S1 ✅ `npm run build` → `tsc` → 0 errors.
  - S2 ✅ module graph loads, no import-cycle crash; default export is a function.
  - S1 regression ✅ `npx tsx tests/index.ts` → "status tests passed".
  - Accumulated suites ✅ `step3`/`step4`/`step5`/`step7`/`step8`/`step9` smoke all PASS
    (cover S5/S6/S7/S8/S9/S12/S13/S14 partials — 63+ assertions across suites).
  - S10/S11 ✅ live daemon + CLI lifecycle (`node dist/cli.js start|stop|status`):
    start→PID+health (`{running:true,mode:daemon,pid,agent:true}`), config-edit reload,
    SIGHUP reload (stays healthy), **listener rollback** on occupied port
    (EADDRINUSE → config restored to 3847, daemon alive), stop→PID file removed,
    process terminated, port freed, CLI reports 🔴 Not running.
- **ROADMAP.md:** W1 checkbox set to `- [x]` with short reference to this plan.
- **R1/R4 ✅** verified throughout the sequence: additive migration only; no logic/type/bugfix
  changes in Phase 1.2 (`as any` casts, FIFO semantics, Telegram webhook cast untouched).
  Phase 1.2 (W1) is fully complete.
- **Commit:** pending ("chore: finalize phase 1.2 modularization")
