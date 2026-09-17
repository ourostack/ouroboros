#!/bin/sh
set -eu

if [ "$#" -lt 4 ]; then
  exit 64
fi

cgroup_procs=$1
prlimit=$2
setsid=$3
shift 3

printf '%s\n' "$$" > "$cgroup_procs"
printf 'ready\n' >&3
exec 3>&-
exec "$prlimit" --nproc=256 --as=1073741824 -- "$setsid" --wait "$@"
