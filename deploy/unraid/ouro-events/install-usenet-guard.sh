#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
INSTALL_ROOT="/boot/config/custom"
GO_FILE="/boot/config/go"
CRONTAB_FILE=""
ACTION="install"
RESTORE_ROOT=""
STAGE_PATH=""
SYSTEM_CRON_PRESENT=false

while (($# > 0)); do
  case "$1" in
    --install-only) ACTION="install"; shift ;;
    --boot) ACTION="boot"; shift ;;
    --restore-root) ACTION="restore"; RESTORE_ROOT="${2:?missing --restore-root value}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:?missing --source-root value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?missing --install-root value}"; shift 2 ;;
    --go-file) GO_FILE="${2:?missing --go-file value}"; shift 2 ;;
    --crontab-file) CRONTAB_FILE="${2:?missing --crontab-file value}"; shift 2 ;;
    *) echo "usenet guard installer: invalid argument: $1" >&2; exit 2 ;;
  esac
done

validate_persisted_path() {
  local value="$1" label="$2"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$value" != */ ]] && [[ "$value" != *"//"* ]] && [[ "$value" != *"/../"* ]] && [[ "$value" != */.. ]] && [[ "$value" != *"/./"* ]] && [[ "$value" != */. ]] || {
    echo "usenet guard installer: $label must be a canonical absolute path" >&2
    exit 2
  }
}

validate_persisted_path "$INSTALL_ROOT" "install root"
if [ -n "$CRONTAB_FILE" ]; then validate_persisted_path "$CRONTAB_FILE" "crontab file"; fi
if [ -n "$RESTORE_ROOT" ]; then validate_persisted_path "$RESTORE_ROOT" "restore root"; fi

EVENT_ROOT="$INSTALL_ROOT/ouro-events"
printf -v EVENT_INSTALLER_Q '%q' "$EVENT_ROOT/install-usenet-guard.sh"
printf -v INSTALL_ROOT_Q '%q' "$INSTALL_ROOT"
BOOT_HOOK="/bin/bash $EVENT_INSTALLER_Q --boot --install-root $INSTALL_ROOT_Q"
PREVIOUS_INSTALLER_BOOT_HOOK="/bin/bash $EVENT_INSTALLER_Q --boot"
if [ -n "$CRONTAB_FILE" ]; then
  printf -v CRONTAB_FILE_Q '%q' "$CRONTAB_FILE"
  BOOT_HOOK+=" --crontab-file $CRONTAB_FILE_Q"
  PREVIOUS_INSTALLER_BOOT_HOOK+=" --crontab-file $CRONTAB_FILE_Q"
fi
LEGACY_BOOT_HOOK="/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
LEGACY_BASH_BOOT_HOOK="/bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
printf -v HEALTH_SCRIPT_Q '%q' "$INSTALL_ROOT/usenet_health.sh"
CRON_LINE="*/15 * * * * /bin/bash $HEALTH_SCRIPT_Q # ouro:usenet-health"
LEGACY_CRON_LINE="*/15 * * * * /bin/bash $HEALTH_SCRIPT_Q"
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
  awk -v legacy="$LEGACY_CRON_LINE" 'index($0, "# ouro:usenet-health") == 0 && $0 != legacy && $0 != "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh" { print }' "$source" > "$target"
  printf '%s\n' "$CRON_LINE" >> "$target"
  /bin/chmod 0600 "$target"
}

render_inactive_cron() {
  local source="$1" target="$2"
  awk -v legacy="$LEGACY_CRON_LINE" 'index($0, "# ouro:usenet-health") == 0 && $0 != legacy && $0 != "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh" { print }' "$source" > "$target"
  /bin/chmod 0600 "$target"
}

render_go_without_owned() {
  local source="$1" target="$2"
  awk '$0 != "/boot/config/custom/ouro-events/bootstrap-spool.sh --mount" && $0 != "/bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount" && $0 !~ /^\/bin\/bash [^[:space:]]+\/ouro-events\/install-usenet-guard\.sh --boot([[:space:]]|$)/ { print }' "$source" > "$target"
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
  /bin/bash "$stage/bootstrap-spool.sh" --mount
  /bin/bash "$stage/bootstrap-spool.sh" --self-test
  /bin/bash "$stage/emit-usenet-event.sh" --self-test "$stage/emit-event.mjs"

  if [ -f "$GO_FILE" ]; then
    /bin/cp -p "$GO_FILE" "$backup/go"
    /bin/cp -p "$GO_FILE" "$stage/go.base"
  else
    printf '#!/bin/bash\n' > "$stage/go.base"
  fi
  go_candidate="$stage/go.candidate"
  grep -Fvx -e "$LEGACY_BOOT_HOOK" -e "$LEGACY_BASH_BOOT_HOOK" -e "$PREVIOUS_INSTALLER_BOOT_HOOK" -e "$BOOT_HOOK" "$stage/go.base" > "$stage/go.filtered" || true
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
  render_inactive_cron "$cron_original" "$cron_inactive"

  for index in "${!TARGET_PATHS[@]}"; do
    target="${TARGET_PATHS[$index]}"
    if [ -e "$target" ]; then
      [ -f "$target" ] && [ ! -L "$target" ] || { echo "usenet guard installer: live asset is unsafe" >&2; return 1; }
      /bin/cp -p "$target" "$backup/asset-$index"
    fi
  done

  set +e
  status=0
  if grep -Fq '# ouro:usenet-health' "$cron_original" || grep -Fxq "$LEGACY_CRON_LINE" "$cron_original"; then activate_cron_file "$cron_inactive" || status=$?; fi
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
  /bin/bash "$EVENT_ROOT/bootstrap-spool.sh" --mount
  /bin/bash "$EVENT_ROOT/bootstrap-spool.sh" --self-test
  /bin/bash "$EVENT_ROOT/emit-usenet-event.sh" --self-test "$EVENT_ROOT/emit-event.mjs"
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

restore_snapshot() {
  local expected_inventory stage backup cron_original cron_inactive cron_candidate go_original go_filtered go_candidate status index target relative source state global_name global_state global_digest global_count go_state cron_state
  expected_inventory=$'present\tcustom/usenet_health.sh\npresent\tcustom/ouro-events/bootstrap-spool.sh\npresent\tcustom/ouro-events/emit-event.mjs\npresent\tcustom/ouro-events/emit-usenet-event.sh\npresent\tcustom/ouro-events/install-usenet-guard.sh\npresent\tgo.butler-lines\npresent\tcrontab.butler-lines\npresent\tglobal-state'
  [ -d "$RESTORE_ROOT" ] && [ ! -L "$RESTORE_ROOT" ] || return 1
  [ -f "$RESTORE_ROOT/inventory" ] && [ ! -L "$RESTORE_ROOT/inventory" ] || return 1
  while IFS=$'\t' read -r state relative; do
    case "$state:$relative" in
      present:custom/usenet_health.sh|absent:custom/usenet_health.sh|present:custom/ouro-events/bootstrap-spool.sh|absent:custom/ouro-events/bootstrap-spool.sh|present:custom/ouro-events/emit-event.mjs|absent:custom/ouro-events/emit-event.mjs|present:custom/ouro-events/emit-usenet-event.sh|absent:custom/ouro-events/emit-usenet-event.sh|present:custom/ouro-events/install-usenet-guard.sh|absent:custom/ouro-events/install-usenet-guard.sh|present:go.butler-lines|present:crontab.butler-lines|present:global-state) ;;
      *) return 1 ;;
    esac
    if [ "$state" = present ]; then [ -f "$RESTORE_ROOT/$relative" ] && [ ! -L "$RESTORE_ROOT/$relative" ] || return 1; else [ ! -e "$RESTORE_ROOT/$relative" ] && [ ! -L "$RESTORE_ROOT/$relative" ] || return 1; fi
  done < "$RESTORE_ROOT/inventory"
  test "$(sed 's/^absent/present/' "$RESTORE_ROOT/inventory")" = "$expected_inventory" || return 1
  index=0
  while IFS=$'\t' read -r global_name global_state global_digest global_count; do
    case "$index:$global_name:$global_state" in
      0:go:present|0:go:absent) go_state="$global_state" ;;
      1:crontab:present|1:crontab:absent) cron_state="$global_state" ;;
      *) return 1 ;;
    esac
    if [ "$global_state" = absent ]; then
      [ "$global_digest" = - ] || return 1
    else
      [ "${#global_digest}" -eq 64 ] || return 1
      case "$global_digest" in *[!0-9a-f]*) return 1 ;; esac
    fi
    case "$global_count" in ''|*[!0-9]*) return 1 ;; esac
    [ "$(awk 'END { print NR + 0 }' "$RESTORE_ROOT/$global_name.butler-lines")" = "$global_count" ] || return 1
    index=$((index + 1))
  done < "$RESTORE_ROOT/global-state"
  [ "$index" -eq 2 ] || return 1
  awk '$0 != "/boot/config/custom/ouro-events/bootstrap-spool.sh --mount" && $0 != "/bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount" && $0 !~ /^\/bin\/bash \/boot\/config\/custom\/ouro-events\/install-usenet-guard\.sh --boot([[:space:]]|$)/ { exit 1 }' "$RESTORE_ROOT/go.butler-lines" || return 1
  awk 'index($0, "# ouro:usenet-health") == 0 && $0 != "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh" { exit 1 }' "$RESTORE_ROOT/crontab.butler-lines" || return 1

  stage="$(/usr/bin/mktemp -d "$INSTALL_ROOT/.ouro-usenet-restore.XXXXXX")"
  STAGE_PATH="$stage"
  backup="$stage/backup"
  /bin/mkdir "$backup"
  cleanup() { [ -z "$STAGE_PATH" ] || /bin/rm -rf "$STAGE_PATH"; }
  trap cleanup EXIT
  for index in "${!TARGET_PATHS[@]}"; do
    target="${TARGET_PATHS[$index]}"
    if [ -e "$target" ]; then [ -f "$target" ] && [ ! -L "$target" ] || return 1; /bin/cp -p "$target" "$backup/asset-$index"; fi
  done
  if [ -e "$GO_FILE" ]; then [ -f "$GO_FILE" ] && [ ! -L "$GO_FILE" ] || return 1; /bin/cp -p "$GO_FILE" "$backup/go"; fi
  go_original="$stage/go.original"
  if [ -f "$GO_FILE" ]; then /bin/cp "$GO_FILE" "$go_original"; else printf '#!/bin/bash\n' > "$go_original"; fi
  go_filtered="$stage/go.filtered"
  render_go_without_owned "$go_original" "$go_filtered"
  go_candidate="$stage/go.candidate"
  if [ -s "$RESTORE_ROOT/go.butler-lines" ]; then
    awk -v fragments="$RESTORE_ROOT/go.butler-lines" 'NR == 1 && /^#!/ { print; while ((getline line < fragments) > 0) print line; close(fragments); next } NR == 1 { while ((getline line < fragments) > 0) print line; close(fragments) } { print }' "$go_filtered" > "$go_candidate"
  else
    /bin/cp "$go_filtered" "$go_candidate"
  fi
  /bin/chmod 0700 "$go_candidate"
  cron_original="$stage/cron.original"
  if [ -n "$CRONTAB_FILE" ]; then
    if [ -f "$CRONTAB_FILE" ]; then /bin/cp -p "$CRONTAB_FILE" "$backup/cron"; /bin/cp "$CRONTAB_FILE" "$cron_original"; else : > "$cron_original"; fi
  else
    read_system_cron "$cron_original"
    /bin/cp "$cron_original" "$backup/cron"
  fi
  cron_inactive="$stage/cron.inactive"
  render_inactive_cron "$cron_original" "$cron_inactive"
  cron_candidate="$stage/cron.candidate"
  /bin/cp "$cron_inactive" "$cron_candidate"
  /bin/cat "$RESTORE_ROOT/crontab.butler-lines" >> "$cron_candidate"
  /bin/chmod 0600 "$cron_candidate"

  set +e
  status=0
  if grep -Fq '# ouro:usenet-health' "$cron_original" || grep -Fxq "$LEGACY_CRON_LINE" "$cron_original"; then activate_cron_file "$cron_inactive" || status=$?; fi
  for index in "${!TARGET_PATHS[@]}"; do
    [ "$status" -eq 0 ] || break
    target="${TARGET_PATHS[$index]}"
    case "$index" in
      0) relative=custom/usenet_health.sh ;;
      1) relative=custom/ouro-events/bootstrap-spool.sh ;;
      2) relative=custom/ouro-events/emit-event.mjs ;;
      3) relative=custom/ouro-events/emit-usenet-event.sh ;;
      4) relative=custom/ouro-events/install-usenet-guard.sh ;;
    esac
    source="$RESTORE_ROOT/$relative"
    if [ -f "$source" ]; then atomic_install "$source" "$target" 0700 || status=$?; else /bin/rm -f "$target" || status=$?; fi
  done
  if [ "$status" -eq 0 ]; then
    if [ "$go_state" = absent ] && [ "$(awk 'NF && $0 !~ /^#!/ { count++ } END { print count + 0 }' "$go_candidate")" -eq 0 ]; then /bin/rm -f "$GO_FILE" || status=$?; else atomic_install "$go_candidate" "$GO_FILE" 0700 || status=$?; fi
  fi
  if [ "$status" -eq 0 ]; then
    if [ "$cron_state" = absent ] && [ ! -s "$cron_candidate" ]; then
      if [ -n "$CRONTAB_FILE" ]; then /bin/rm -f "$CRONTAB_FILE" || status=$?; else crontab -r >/dev/null 2>&1 || status=$?; fi
    else
      activate_cron_file "$cron_candidate" || status=$?
    fi
  fi
  set -e
  if [ "$status" -ne 0 ]; then
    for index in "${!TARGET_PATHS[@]}"; do restore_target "${TARGET_PATHS[$index]}" "$backup/asset-$index"; done
    restore_target "$GO_FILE" "$backup/go"
    if [ -n "$CRONTAB_FILE" ]; then restore_target "$CRONTAB_FILE" "$backup/cron"; elif [ "$SYSTEM_CRON_PRESENT" = true ]; then crontab "$backup/cron"; else crontab -r >/dev/null 2>&1 || true; fi
    return "$status"
  fi
  cleanup
  STAGE_PATH=""
  trap - EXIT
}

case "$ACTION" in
  install) install_transaction ;;
  boot) boot_activate ;;
  restore) restore_snapshot ;;
esac
