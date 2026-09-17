#!/bin/sh
set -eu
umask 077
test "$(id -u):$(id -g)" = 0:0
cd /
case "${1-}" in
  --boot)
    test "$#" -eq 1
    # Unraid's go hook can run before the array and Docker are available.
    attempt=0
    while test ! -f /mnt/user/appdata/ouro-authority/active.json || test ! -S /var/run/docker.sock || ! /usr/bin/docker info >/dev/null 2>&1; do
      attempt=$((attempt + 1))
      test "$attempt" -le 300
      sleep 1
    done
    exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      /usr/local/bin/node /mnt/user/appdata/ouro-authority/package/dist/heart/daemon/sanctuary-authority-root-lifecycle.js boot </dev/null
    ;;
  "") test "$#" -eq 0 ;;
  *) exit 2 ;;
esac
test -d /mnt/user/appdata/ouro-authority
test ! -L /mnt/user/appdata/ouro-authority
test "$(stat -c '%u:%g:%a' /mnt/user/appdata/ouro-authority)" = 0:0:700
test -f /mnt/user/appdata/ouro-authority/active.json
test ! -L /mnt/user/appdata/ouro-authority/active.json
test "$(stat -c '%u:%g:%a' /mnt/user/appdata/ouro-authority/active.json)" = 0:0:600
exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/local/bin/node /mnt/user/appdata/ouro-authority/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js \
  --config /mnt/user/appdata/ouro-authority/active.json </dev/null
