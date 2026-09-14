# Deployment — pi-gateway

> Definierter, reproduzierbarer Deployment-Prozess für Neuinstallation, Update, Reset und Deinstallation. Alle Szenarien sind auch als Ein-Kommando-Varianten in [`scripts/deploy.sh`](../scripts/deploy.sh) automatisiert.

---

## 1. Environment model (three locations)

| Location | Role | Contents | Touched by deploy? |
|---|---|---|---|
| project directory (git clone) | **Source** (development, build root) | `src/`, `tests/`, `package.json`, `config/config.default.json`, docs | build → produces `dist/` |
| `~/.pi/runtime/pi-gateway/` | **Runtime** (pi extension + systemd) | `dist/`, `src/`, `config/`, `node_modules/`, `package.json` | **yes** (sync/install) |
| `~/.pi/gateway/` | **Data/config** (strictly separate) | `config.json`, `*.db`, `gateway.log`, `gateway.pid` | **no** (never overwritten) |

**Guiding principle:** configuration and runtime data (`~/.pi/gateway/`) are strictly separated from binary deploys. A binary update must never overwrite config or databases.

## 2. pi tooling knowledge (as of pi 0.84.4)

- **`pi install <path>` links the extension, it does not copy it.** pi registers the source path in `~/.pi/agent/settings.json` (`packages`) and resolves it on load. The registered directory must therefore stay in place (never move/rename/delete it) — updating in place is fine.
- Consequently, deployment always installs **out of `~/.pi/runtime/pi-gateway`** (the directory is refilled in place — the invariant holds).
- `pi list` shows registered extensions; `pi remove <source>` removes the entry from `settings.json`.
- Node toolchain: any **Node.js ≥ 20** works; pi ships its own node runtime (see `~/.local/share/pi-node/...` on pi installs) — make sure the node binary used by the service matches your toolchain.

## 3. Scenario A — Fresh install

**Shortcut (automated):**

```bash
git clone https://github.com/edgarkech/pi-gateway.git
cd pi-gateway
npm install
./scripts/deploy.sh install --seed-config --with-service
```

Manual, step by step:

```bash
# 1. Node toolchain available
export PATH="<your-node-dir>:$PATH"    # e.g. ~/.local/share/pi-node/node-<ver>-linux-x64/bin

# 2. Fill the runtime directory (source = project)
mkdir -p ~/.pi/runtime/pi-gateway
cd pi-gateway                           # the cloned project directory
npm install                             # incl. native dep (better-sqlite3)
npm run build                           # -> dist/
rsync -a dist/ src/ config/ package.json package-lock.json ~/.pi/runtime/pi-gateway/
cd ~/.pi/runtime/pi-gateway
npm ci                                  # node_modules in the runtime (native binaries!)

# 3. Seed config (from the project checkout — never fetch it from the runtime)
mkdir -p ~/.pi/gateway
cp config/config.default.json ~/.pi/gateway/config.json
#   -> fill in port/host, allowedUids/adminUids, platform tokens, Nextcloud-Talk block

# 4. Register as a pi extension (linked; do NOT move the directory afterwards)
cd ~/.pi/agent
pi install ~/.pi/runtime/pi-gateway
pi list                                 # must show ~/.pi/runtime/pi-gateway

# 5. systemd user service (optional but recommended)
cp docs/pi-gateway.service ~/.config/systemd/user/
#   -> adjust the node path / PATH inside the unit to your toolchain
systemctl --user daemon-reload
systemctl --user enable --now pi-gateway

# 6. Verify (see §7)
```

## 4. Scenario B — Update (standard case)

**Shortcut (automated):** `./scripts/deploy.sh update`

Manual:

```bash
export PATH="<your-node-dir>:$PATH"

# 1. Pre-flight: quality gates green
npm run build && npm run lint && npx tsc --noEmit   # + npm test

# 2. Rollback point: secure the old build
BACKUP=~/.pi-gateway-backup/dist-backups/dist-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP"
rsync -a ~/.pi/runtime/pi-gateway/dist/ "$BACKUP"/

# 3. Sync to the runtime (do NOT blindly replace node_modules)
rsync -a --delete dist/ ~/.pi/runtime/pi-gateway/dist/
rsync -a src/ config/ package.json package-lock.json ~/.pi/runtime/pi-gateway/

# 4. If dependencies changed -> npm ci in the runtime (native rebuild!)
cd ~/.pi/runtime/pi-gateway && npm ci

# 5. Restart + verify
systemctl --user restart pi-gateway
systemctl --user is-active pi-gateway     # active
tail -20 ~/.pi/gateway/gateway.log        # clean start

# 6. Rollback (if needed): restore backup into dist, restart
rsync -a --delete "$BACKUP"/ ~/.pi/runtime/pi-gateway/dist/
systemctl --user restart pi-gateway
```

## 5. Full reset + reinstall (destructive)

**When:** the runtime is on an old/unfixable state and you want a clean, validated end state from hour zero. Destructive — make sure you have a config backup first (§6).

### Uninstall (secure, stop, remove)

1. **Secure:** copy `~/.config/systemd/user/pi-gateway.service` and `~/.pi/gateway/config.json` to a safe location (config contains secrets — keep it out of any repo).
2. **Stop:** `systemctl --user stop pi-gateway` (then `is-active` → `inactive`).
3. **Remove unit:** `rm ~/.config/systemd/user/pi-gateway.service` + `systemctl --user daemon-reload`.
4. **pi registration:** `pi remove ~/.pi/runtime/pi-gateway` (from `~/.pi/agent`).
5. **Data/config:** `rm -rf ~/.pi/gateway`.
6. **Runtime:** `rm -rf ~/.pi/runtime/pi-gateway`.
7. **Verify uninstall:** `pi list` shows no gateway; `systemctl --user status pi-gateway` → "could not be found".

### Clean install

Exact sequence as in §3, including a **fresh** `config.json` seeded from `config/config.default.json` (tokens, `allowedUids`/`adminUids`, Nextcloud-Talk block filled manually). Restore the systemd unit from your secured reference (keep the PATH fix), then `systemctl --user enable --now pi-gateway` + verification matrix (§7).

## 6. Secrets handling

- Platform tokens (Telegram bot token, Nextcloud app password, …) live in plaintext in `~/.pi/gateway/config.json` — **never** in the repository, never in backups that leave the machine.
- **File permissions:** `chmod 600 ~/.pi/gateway/config.json`.
- **Env override:** the Nextcloud Talk app password can be supplied via `NEXTCLOUD_TALK_APP_TOKEN` (e.g. from a systemd `EnvironmentFile` with 0600) instead of plaintext-in-config.
- The config validator rejects placeholder tokens, so an unconfigured seed fails loudly instead of silently.

## 7. Verification matrix

| Check | Command | Expectation |
|---|---|---|
| Extension registered | `cd ~/.pi/agent && pi list` | `…runtime/pi-gateway` listed |
| Service active | `systemctl --user is-active pi-gateway` | `active` |
| Daemon boot | `tail -20 ~/.pi/gateway/gateway.log` | `Daemon ready`, adapters start without errors |
| HTTP health | `curl -s http://localhost:3847/api/status` | 200 |
| Talk adapter (if enabled) | log | `NextcloudTalk adapter started` without errors |
| pi integrity | `pi list` + no errors in the TUI | gateway extension loads without console errors |

## 8. Open items

- [ ] Secrets via systemd `EnvironmentFile` (0600) instead of plaintext-in-config — dedicated step.
