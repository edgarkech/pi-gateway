#!/usr/bin/env bash
###############################################################################
# pi-gateway deploy tool
# ----------------------------------------------------------------------------
# Defined deployment process for fresh install (install), update (update),
# full reset + reinstall (reset), uninstall and verification (verify).
#
# Important pi knowledge (context: docs/deployment.md):
#  * `pi install <path>` LINKS the extension (copies no binaries/libs) — the
#    registered directory must stay in place.
#  * Installation therefore always runs OUT of ~/.pi/runtime/pi-gateway.
#  * Operating data (~/.pi/gateway/) is NEVER touched by this script.
#
# Usage:
#   scripts/deploy.sh install [--seed-config] [--with-service]
#   scripts/deploy.sh update
#   scripts/deploy.sh reset [--backup-only]     # destructive! simulates first, backs up, shows plan.
#   scripts/deploy.sh uninstall                 # destructive! backs up, stops, removes everything.
#   scripts/deploy.sh verify
#   scripts/deploy.sh help
#
# Run from anywhere inside a clone of this repository.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # repo root of the clone

# Node toolchain: use node from PATH; fall back to a pi-shipped node runtime if present.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME"/.local/share/pi-node/*/bin:"$PATH"
fi

RUNTIME_DIR="$HOME/.pi/runtime/pi-gateway"
GATEWAY_DATA_DIR="$HOME/.pi/gateway"
UNIT_FILE="$HOME/.config/systemd/user/pi-gateway.service"
UNIT_SOURCE="$PROJECT_DIR/docs/pi-gateway.service"
# SECURITY: config.json (contains bot/app tokens) must NEVER be backed up to any
# location that is published/synced to a repo. Backup target is therefore a
# non-published directory.
BACKUP_ROOT="$HOME/.pi-gateway-backup"              # -> config.json, unit (tokens, sensitive)
DIST_BACKUP_ROOT="$HOME/.pi-gateway-backup/dist-backups"  # -> dist (no secrets)
SERVICE="pi-gateway"

# Colors (TTY only)
if [[ -t 1 ]]; then
  C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m' C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
  C_GREEN= C_YELLOW= C_RED= C_BOLD= C_RESET=
fi

log()   { printf '%s[%s]%s %s\n' "${C_BOLD}${C_GREEN}" "$(date +%H:%M:%S)" "${C_RESET}" "$*"; }
warn()  { printf '%s[WARN]%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
err()   { printf '%s[ERROR]%s %s\n' "${C_RED}" "$*" "${C_RESET}" >&2; }
die()   { err "$*"; exit 1; }

require_project() {
  [[ -d "$PROJECT_DIR/src" ]] || die "Project source missing: $PROJECT_DIR (run inside a clone)."
}

build_project() {
  log "Building in project ($PROJECT_DIR)"
  ( cd "$PROJECT_DIR" && npm run build )
  log "Build done (dist/)."
}

sync_to_runtime() {
  mkdir -p "$RUNTIME_DIR"
  log "Sync dist/src/config/package.json -> $RUNTIME_DIR"
  rsync -a "$PROJECT_DIR/dist/" "$RUNTIME_DIR/dist/"
  rsync -a "$PROJECT_DIR/src/"  "$RUNTIME_DIR/src/"
  rsync -a "$PROJECT_DIR/config/" "$RUNTIME_DIR/config/"
  cp    "$PROJECT_DIR/package.json"        "$RUNTIME_DIR/package.json"
  cp    "$PROJECT_DIR/package-lock.json"   "$RUNTIME_DIR/package-lock.json" 2>/dev/null || true
}

runtime_npm_ci() {
  # Only when node_modules is missing OR package.json changed.
  if [[ ! -d "$RUNTIME_DIR/node_modules" ]]; then
    ( cd "$RUNTIME_DIR" && npm ci )
    return
  fi
  if ! cmp -s "$PROJECT_DIR/package.json" "$RUNTIME_DIR/package.json"; then
    log "package.json changed -> npm ci in runtime (native rebuild)."
    ( cd "$RUNTIME_DIR" && npm ci )
  else
    log "node_modules up-to-date (no npm ci needed)."
  fi
}

pi_register() {
  log "Registering pi extension: $RUNTIME_DIR"
  ( cd "$HOME/.pi/agent" && pi install "$RUNTIME_DIR" )
  ( cd "$HOME/.pi/agent" && pi list )
}

install_service() {
  log "Installing + enabling systemd unit"
  cp "$UNIT_SOURCE" "$UNIT_FILE"
  warn "Adjust the node path / PATH inside $UNIT_FILE to your toolchain if needed."
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
}

seed_config_if_missing() {
  if [[ -f "$GATEWAY_DATA_DIR/config.json" ]]; then
    warn "config.json already exists -> NOT overwritten. ($GATEWAY_DATA_DIR/config.json)"
    return 0
  fi
  mkdir -p "$GATEWAY_DATA_DIR"
  cp "$PROJECT_DIR/config/config.default.json" "$GATEWAY_DATA_DIR/config.json"
  log "config.json seeded from config.default.json."
  warn "Please adjust port/tokens/UIDs manually!"
}

cmd_verify() {
  log "=== verify: pi registration ==="
  ( cd "$HOME/.pi/agent" && pi list ) || true

  log "=== verify: systemd ==="
  local act
  act="$(systemctl --user is-active "$SERVICE" 2>/dev/null || echo inactive)"
  log "pi-gateway: $act"
  [[ "$act" == "active" ]] || err "Service is not active."

  log "=== verify: daemon health ==="
  if [[ -f "$RUNTIME_DIR/dist/cli.js" ]]; then
    node "$RUNTIME_DIR/dist/cli.js" status || err "cli status failed"
  else
    err "No dist/cli.js in runtime ($RUNTIME_DIR)."
  fi

  log "=== verify: last log lines ==="
  tail -15 "$GATEWAY_DATA_DIR/gateway.log" 2>/dev/null || warn "no log present."
}

cmd_uninstall() {
  log "=== uninstall (with backup) ==="
  mkdir -p "$BACKUP_ROOT/uninstall-$(date +%Y%m%d-%H%M%S)"
  local bk="$BACKUP_ROOT/uninstall-$(date +%Y%m%d-%H%M%S)"

  if [[ -f "$UNIT_FILE" ]]; then
    cp "$UNIT_FILE" "$bk/pi-gateway.service"
    log "Unit backed up to $bk/pi-gateway.service"
  fi
  if [[ -f "$GATEWAY_DATA_DIR/config.json" ]]; then
    cp "$GATEWAY_DATA_DIR/config.json" "$bk/config.json"
    log "config.json backed up to $bk/config.json (contains tokens — keep out of repos)"
  fi

  if systemctl --user is-active "$SERVICE" >/dev/null 2>&1; then
    log "Stopping service"
    systemctl --user stop "$SERVICE"
  fi
  if [[ -f "$UNIT_FILE" ]]; then
    log "Deleting unit file"
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
  fi
  if ( cd "$HOME/.pi/agent" && pi list ) | grep -q "runtime/pi-gateway"; then
    log "Removing pi registration"
    # The registration is stored RELATIVE (../runtime/pi-gateway) -> remove exactly that,
    # fallback: absolute path
    ( cd "$HOME/.pi/agent" && pi remove "../runtime/pi-gateway" ) \
      || ( cd "$HOME/.pi/agent" && pi remove "$RUNTIME_DIR" ) \
      || warn "pi remove failed — please check manually (settings.json/packages)."
  fi
  if [[ -d "$GATEWAY_DATA_DIR" ]]; then
    log "Deleting operating data ($GATEWAY_DATA_DIR)"
    rm -rf "$GATEWAY_DATA_DIR"
  fi
  if [[ -d "$RUNTIME_DIR" ]]; then
    log "Deleting runtime ($RUNTIME_DIR)"
    rm -rf "$RUNTIME_DIR"
  fi
  log "Uninstall verification:"
  ( cd "$HOME/.pi/agent" && pi list ) || true
  systemctl --user status "$SERVICE" 2>&1 | head -3 || true
  log "uninstall complete. Reference: $bk"
}

cmd_install() {
  require_project
  build_project
  sync_to_runtime
  runtime_npm_ci
  pi_register
  if [[ " ${*:-} " == *"--with-service"* ]]; then
    install_service
  fi
  if [[ " ${*:-} " == *"--seed-config"* ]]; then
    seed_config_if_missing
  fi
  cmd_verify
}

cmd_update() {
  require_project
  build_project
  local bk="$DIST_BACKUP_ROOT/dist-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$bk"
  rsync -a "$RUNTIME_DIR/dist/" "$bk/" 2>/dev/null || true
  log "Rollback point (dist): $bk"
  sync_to_runtime
  runtime_npm_ci
  log "Restarting service"
  systemctl --user restart "$SERVICE"
  cmd_verify
}

cmd_reset() {
  # Destructive: shows plan, backs up, uninstalls, reinstalls.
  warn "reset = full reinstall (clean slate)."
  warn "Uninstalls: systemd unit, pi registration, ~/.pi/gateway, ~/.pi/runtime/pi-gateway."
  if [[ " ${*:-} " == *"--backup-only"* ]]; then
    log "Simulation finished (--backup-only)."
    return 0
  fi
  cmd_uninstall
  cmd_install --seed-config --with-service
}

help() {
  sed -n '1,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | grep -vE '^$' | grep -vE '^\s*#!'
  echo
  echo "Subcommands:"
  echo "  install [--seed-config] [--with-service]  build -> sync -> npm ci -> pi install"
  echo "  update                                    build -> backup -> sync -> restart -> verify"
  echo "  reset [--backup-only]                     uninstall + install (destructive!)"
  echo "  uninstall                                 backs up, stops, removes everything (destructive!)"
  echo "  verify                                    status/integrity checks"
}

[[ $# -lt 1 ]] && { help; exit 1; }
CMD="$1"; shift || true
case "$CMD" in
  install)   cmd_install "$@" ;;
  update)    cmd_update "$@" ;;
  reset)     cmd_reset "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  verify)    cmd_verify ;;
  help|-h|--help) help ;;
  *) die "Unknown subcommand: $CMD (see help)" ;;
esac
