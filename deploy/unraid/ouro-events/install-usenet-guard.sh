#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_ROOT="/boot/config/custom"
GO_FILE="/boot/config/go"
CRONTAB_FILE=""
ACTION="install"

while (($# > 0)); do
  case "$1" in
    --install-only) ACTION="install"; shift ;;
    --boot) ACTION="boot"; shift ;;
    --source-root) SOURCE_ROOT="${2:?missing --source-root value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?missing --install-root value}"; shift 2 ;;
    --go-file) GO_FILE="${2:?missing --go-file value}"; shift 2 ;;
    --crontab-file) CRONTAB_FILE="${2:?missing --crontab-file value}"; shift 2 ;;
    *) echo "usenet guard installer: invalid argument: $1" >&2; exit 2 ;;
  esac
done

EVENT_ROOT="$INSTALL_ROOT/ouro-events"
BOOT_HOOK="$EVENT_ROOT/install-usenet-guard.sh --boot${CRONTAB_FILE:+ --crontab-file $CRONTAB_FILE}"
CRON_LINE="*/15 * * * * $INSTALL_ROOT/usenet_health.sh # ouro:usenet-health"

register_cron() {
  local target temporary
  if [ -n "$CRONTAB_FILE" ]; then
    target="$CRONTAB_FILE"
    [ -f "$target" ] || : > "$target"
    temporary="${target}.ouro-usenet.$$"
    grep -vF '# ouro:usenet-health' "$target" > "$temporary" || true
    printf '%s\n' "$CRON_LINE" >> "$temporary"
    chmod 0600 "$temporary"
    mv "$temporary" "$target"
    return
  fi
  temporary="/tmp/ouro-usenet-crontab.$$"
  /usr/bin/crontab -l > "$temporary" 2>/dev/null || true
  grep -vF '# ouro:usenet-health' "$temporary" > "${temporary}.next" || true
  printf '%s\n' "$CRON_LINE" >> "${temporary}.next"
  /usr/bin/crontab "${temporary}.next"
  rm -f "$temporary" "${temporary}.next"
}

install_assets() {
  mkdir -p "$EVENT_ROOT"
  install -m 0700 "$SOURCE_ROOT/usenet-health.sh" "$INSTALL_ROOT/usenet_health.sh"
  for name in bootstrap-spool.sh emit-event.mjs emit-usenet-event.sh install-usenet-guard.sh; do
    install -m 0700 "$SOURCE_ROOT/$name" "$EVENT_ROOT/$name"
  done
  [ -f "$GO_FILE" ] || printf '#!/bin/bash\n' > "$GO_FILE"
  if ! grep -Fqx "$BOOT_HOOK" "$GO_FILE"; then
    local temporary="${GO_FILE}.ouro-usenet.$$"
    awk -v hook="$BOOT_HOOK" 'NR == 1 && /^#!/ { print; print hook; next } NR == 1 { print hook } { print }' "$GO_FILE" > "$temporary"
    chmod 0700 "$temporary"
    mv "$temporary" "$GO_FILE"
  fi
  register_cron
}

case "$ACTION" in
  install) install_assets ;;
  boot) "$EVENT_ROOT/bootstrap-spool.sh" --mount; register_cron ;;
esac
