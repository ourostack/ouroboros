#!/bin/bash
set -euo pipefail

SPOOL_ROOT="/boot/config/custom/ouro-events/spool"
INSTALL_PATH="/boot/config/custom/ouro-events/bootstrap-spool.sh"
GO_FILE="/boot/config/go"
TMPFS_OPTIONS="size=4m,mode=0755,uid=0,gid=0,nodev,nosuid,noexec"
BOOT_HOOK="/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"
ACTION="mount"

while (($# > 0)); do
  case "$1" in
    --mount|--install-only|--self-test) ACTION="${1#--}"; shift ;;
    --go-file) GO_FILE="${2:?missing --go-file value}"; shift 2 ;;
    --install-path) INSTALL_PATH="${2:?missing --install-path value}"; shift 2 ;;
    *) echo "ouro event spool bootstrap: invalid argument: $1" >&2; exit 2 ;;
  esac
done

mount_spool() {
  local target="$1"
  /bin/mkdir -p "$target"
  /bin/chown 0:0 "$target"
  /bin/chmod 0755 "$target"
  if /bin/mountpoint -q "$target"; then
    [[ "$(/bin/findmnt -n -o FSTYPE --target "$target")" == "tmpfs" ]] || { echo "ouro event spool bootstrap: canonical path is already a non-tmpfs mount" >&2; return 1; }
  else
    /bin/mount -t tmpfs -o "$TMPFS_OPTIONS" ouro-events-spool "$target"
  fi
  [[ "$(/bin/stat -c '%u:%g:%a' "$target")" == "0:0:755" ]] || { echo "ouro event spool bootstrap: tmpfs identity or mode is unsafe" >&2; return 1; }
  local options
  options="$(/bin/findmnt -n -o OPTIONS --target "$target")"
  for required in nodev nosuid noexec; do
    [[ ",$options," == *",$required,"* ]] || { echo "ouro event spool bootstrap: tmpfs is missing $required" >&2; return 1; }
  done
  local size_bytes
  size_bytes="$(/bin/findmnt -bn -o SIZE --target "$target")"
  [[ "$size_bytes" =~ ^[0-9]+$ && "$size_bytes" -le 4194304 ]] || { echo "ouro event spool bootstrap: tmpfs exceeds its 4 MiB bound" >&2; return 1; }
}

install_boot_hook() {
  local install_dir resolved_source resolved_install
  install_dir="$(dirname "$INSTALL_PATH")"
  /bin/mkdir -p "$install_dir"
  resolved_source="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
  resolved_install="$(cd "$install_dir" && pwd -P)/$(basename "$INSTALL_PATH")"
  if [[ "$resolved_source" != "$resolved_install" ]]; then
    install -m 0700 "$0" "$INSTALL_PATH"
  else
    /bin/chmod 0700 "$INSTALL_PATH"
  fi
  [[ -f "$GO_FILE" ]] || printf '#!/bin/bash\n' > "$GO_FILE"
  if ! grep -Fqx "$BOOT_HOOK" "$GO_FILE"; then
    local temporary="${GO_FILE}.ouro-events.$$"
    awk -v hook="$BOOT_HOOK" 'NR == 1 && /^#!/ { print; print hook; next } NR == 1 { print hook } { print }' "$GO_FILE" > "$temporary"
    /bin/chmod 0700 "$temporary"
    /bin/mv "$temporary" "$GO_FILE"
  fi
}

self_test() {
  [[ "$(/usr/bin/id -u)" == "0" ]] || { echo "ouro event spool bootstrap self-test requires root" >&2; return 1; }
  local test_root target readonly_view
  test_root="$(/usr/bin/mktemp -d /tmp/ouro-event-spool.XXXXXX)"
  target="$test_root/spool"
  readonly_view="$test_root/readonly"
  /bin/chmod 0755 "$test_root"
  /bin/mkdir "$target" "$readonly_view"
  cleanup() {
    /bin/umount "$readonly_view" 2>/dev/null || true
    /bin/umount "$target" 2>/dev/null || true
    /bin/rmdir "$readonly_view" "$target" "$test_root" 2>/dev/null || true
  }
  trap cleanup EXIT
  mount_spool "$target"
  /usr/bin/printf 'probe\n' > "$target/probe"
  /bin/chown 0:0 "$target/probe"
  /bin/chmod 0444 "$target/probe"
  /bin/mount --bind "$target" "$readonly_view"
  /bin/mount -o remount,bind,ro,nodev,nosuid,noexec "$readonly_view"
  /usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups /usr/bin/test -r "$readonly_view/probe"
  [[ ",$(/bin/findmnt -n -o OPTIONS --target "$readonly_view")," == *",ro,"* ]] || { echo "ouro event spool bootstrap: test bind is not read-only" >&2; return 1; }
  echo "uid10001-ro-bind: pass"
  cleanup
  trap - EXIT
}

case "$ACTION" in
  mount) mount_spool "$SPOOL_ROOT" ;;
  install-only) install_boot_hook ;;
  self-test) self_test ;;
esac
