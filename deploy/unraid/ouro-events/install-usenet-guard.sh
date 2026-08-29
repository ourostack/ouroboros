#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_ROOT="/boot/config/custom"
GO_FILE="/boot/config/go"
CRONTAB_FILE=""
ACTION="install"
STAGE_PATH=""
SYSTEM_CRON_PRESENT=false

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
LEGACY_BOOT_HOOK="/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
CRON_LINE="*/15 * * * * $INSTALL_ROOT/usenet_health.sh # ouro:usenet-health"
ASSET_NAMES=(usenet-health.sh bootstrap-spool.sh emit-event.mjs emit-usenet-event.sh install-usenet-guard.sh)
TARGET_PATHS=("$INSTALL_ROOT/usenet_health.sh" "$EVENT_ROOT/bootstrap-spool.sh" "$EVENT_ROOT/emit-event.mjs" "$EVENT_ROOT/emit-usenet-event.sh" "$EVENT_ROOT/install-usenet-guard.sh")

atomic_install() {
  local source="$1" target="$2" mode="$3" temporary="${2}.ouro-next.$$" status
  /bin/mkdir -p "$(dirname "$target")"
  install -m "$mode" "$source" "$temporary" || { status=$?; /bin/rm -f "$temporary"; return "$status"; }
  mv "$temporary" "$target" || { status=$?; /bin/rm -f "$temporary"; return "$status"; }
}

render_cron() {
  local source="$1" target="$2"
  grep -vF '# ouro:usenet-health' "$source" > "$target" || true
  printf '%s\n' "$CRON_LINE" >> "$target"
  /bin/chmod 0600 "$target"
}

read_system_cron() {
  if crontab -l > "$1" 2>/dev/null; then
    SYSTEM_CRON_PRESENT=true
  else
    SYSTEM_CRON_PRESENT=false
    : > "$1"
  fi
}

activate_cron_file() {
  if [ -n "$CRONTAB_FILE" ]; then
    atomic_install "$1" "$CRONTAB_FILE" 0600
  else
    crontab "$1"
  fi
}

preflight_sources() {
  local name
  for name in "${ASSET_NAMES[@]}"; do
    [ -f "$SOURCE_ROOT/$name" ] && [ ! -L "$SOURCE_ROOT/$name" ] && [ -s "$SOURCE_ROOT/$name" ] || { echo "usenet guard installer: source asset is missing or unsafe: $name" >&2; return 1; }
  done
  /bin/bash -n "$SOURCE_ROOT/usenet-health.sh" "$SOURCE_ROOT/bootstrap-spool.sh" "$SOURCE_ROOT/emit-usenet-event.sh" "$SOURCE_ROOT/install-usenet-guard.sh"
  "$(command -v node)" --check "$SOURCE_ROOT/emit-event.mjs"
}

restore_target() {
  local target="$1" backup="$2" temporary="${1}.ouro-restore.$$"
  if [ -f "$backup" ]; then
    /usr/bin/install -m "$(/bin/stat -c '%a' "$backup" 2>/dev/null || /usr/bin/stat -f '%Lp' "$backup")" "$backup" "$temporary"
    /bin/mv "$temporary" "$target"
  else
    /bin/rm -f "$target" "$temporary"
  fi
}

install_transaction() {
  preflight_sources
  /bin/mkdir -p "$INSTALL_ROOT"
  local stage backup cron_original cron_inactive cron_candidate go_candidate status index name target
  stage="$(/usr/bin/mktemp -d "$INSTALL_ROOT/.ouro-usenet-stage.XXXXXX")"
  STAGE_PATH="$stage"
  backup="$stage/backup"
  /bin/mkdir "$backup"
  cleanup() { [ -z "$STAGE_PATH" ] || /bin/rm -rf "$STAGE_PATH"; }
  trap cleanup EXIT

  for index in "${!ASSET_NAMES[@]}"; do
    name="${ASSET_NAMES[$index]}"
    /usr/bin/install -m 0700 "$SOURCE_ROOT/$name" "$stage/$name"
  done
  "$stage/bootstrap-spool.sh" --mount
  "$stage/bootstrap-spool.sh" --self-test
  "$stage/emit-usenet-event.sh" --self-test "$stage/emit-event.mjs"

  if [ -f "$GO_FILE" ]; then
    /bin/cp -p "$GO_FILE" "$backup/go"
    /bin/cp -p "$GO_FILE" "$stage/go.base"
  else
    printf '#!/bin/bash\n' > "$stage/go.base"
  fi
  go_candidate="$stage/go.candidate"
  grep -Fvx -e "$LEGACY_BOOT_HOOK" -e "$BOOT_HOOK" "$stage/go.base" > "$stage/go.filtered" || true
  if [ -s "$stage/go.filtered" ]; then
    awk -v hook="$BOOT_HOOK" 'NR == 1 && /^#!/ { print; print hook; next } NR == 1 { print hook } { print }' "$stage/go.filtered" > "$go_candidate"
  else
    printf '#!/bin/bash\n%s\n' "$BOOT_HOOK" > "$go_candidate"
  fi
  /bin/chmod 0700 "$go_candidate"

  cron_original="$stage/cron.original"
  if [ -n "$CRONTAB_FILE" ]; then
    if [ -f "$CRONTAB_FILE" ]; then /bin/cp -p "$CRONTAB_FILE" "$backup/cron"; /bin/cp "$CRONTAB_FILE" "$cron_original"; else : > "$cron_original"; fi
  else
    read_system_cron "$cron_original"
    /bin/cp "$cron_original" "$backup/cron"
  fi
  cron_candidate="$stage/cron.candidate"
  render_cron "$cron_original" "$cron_candidate"
  cron_inactive="$stage/cron.inactive"
  grep -vF '# ouro:usenet-health' "$cron_original" > "$cron_inactive" || true
  /bin/chmod 0600 "$cron_inactive"

  for index in "${!TARGET_PATHS[@]}"; do
    target="${TARGET_PATHS[$index]}"
    if [ -e "$target" ]; then
      [ -f "$target" ] && [ ! -L "$target" ] || { echo "usenet guard installer: live asset is unsafe" >&2; return 1; }
      /bin/cp -p "$target" "$backup/asset-$index"
    fi
  done

  set +e
  status=0
  if grep -Fq '# ouro:usenet-health' "$cron_original"; then activate_cron_file "$cron_inactive" || status=$?; fi
  if [ "$status" -eq 0 ]; then
    for index in "${!TARGET_PATHS[@]}"; do
      atomic_install "$stage/${ASSET_NAMES[$index]}" "${TARGET_PATHS[$index]}" 0700 || { status=$?; break; }
    done
  fi
  if [ "$status" -eq 0 ]; then atomic_install "$go_candidate" "$GO_FILE" 0700 || status=$?; fi
  if [ "$status" -eq 0 ]; then activate_cron_file "$cron_candidate" || status=$?; fi
  set -e
  if [ "$status" -ne 0 ]; then
    for index in "${!TARGET_PATHS[@]}"; do restore_target "${TARGET_PATHS[$index]}" "$backup/asset-$index"; done
    restore_target "$GO_FILE" "$backup/go"
    if [ -n "$CRONTAB_FILE" ]; then
      restore_target "$CRONTAB_FILE" "$backup/cron"
    elif [ "$SYSTEM_CRON_PRESENT" = true ]; then
      crontab "$backup/cron"
    else
      crontab -r >/dev/null 2>&1 || true
    fi
    return "$status"
  fi
  cleanup
  STAGE_PATH=""
  trap - EXIT
}

boot_activate() {
  "$EVENT_ROOT/bootstrap-spool.sh" --mount
  "$EVENT_ROOT/bootstrap-spool.sh" --self-test
  "$EVENT_ROOT/emit-usenet-event.sh" --self-test "$EVENT_ROOT/emit-event.mjs"
  local current candidate
  current="$(/usr/bin/mktemp /tmp/ouro-usenet-cron.XXXXXX)"
  candidate="${current}.next"
  if [ -n "$CRONTAB_FILE" ]; then
    if [ -f "$CRONTAB_FILE" ]; then /bin/cp "$CRONTAB_FILE" "$current"; else : > "$current"; fi
  else
    read_system_cron "$current"
  fi
  render_cron "$current" "$candidate"
  activate_cron_file "$candidate"
  /bin/rm -f "$current" "$candidate"
}

case "$ACTION" in
  install) install_transaction ;;
  boot) boot_activate ;;
esac
