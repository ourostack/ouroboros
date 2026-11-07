#!/bin/bash
# Moves the Butler's bundle from the hourly host backup onto bundle sync. Runs as root on the Unraid host.
#
#   sanctuary-sync-cutover.sh [--dry-run]   read the before-state, print it and save it to bundle-backup/cutover-before-<time>.txt (the default)
#   sanctuary-sync-cutover.sh --apply       cut over; any failure rolls back to that saved before-state
#   sanctuary-sync-cutover.sh --rollback    put the hourly backup back, from the before-state the apply recorded
#   sanctuary-sync-cutover.sh --verify-live after --apply: the sync path reaches GitHub, the key stays unreadable, a stalled fetch ends
#
# --apply and --rollback run detached (a new session, all output to bundle-backup/cutover-<time>.log). This process only
# follows that log and exits with the detached run's status, so a dropped ssh session or a closed terminal never stops a
# cutover or a rollback halfway. Once a rollback starts it ignores INT, TERM and HUP, runs every step, and when a step fails
# it writes bundle-backup/cutover-ROLLBACK-INCOMPLETE and says whether the Butler is running. --rollback can be run again.
#
# Every git call names its repository and work tree (`git --git-dir=... --work-tree=...`), so git never discovers the
# repository and never refuses it for dubious ownership after the move or the chown. Root's git calls also run no hooks,
# no fsmonitor and no global excludes file, and `git status` takes no optional locks, so root never rewrites the index
# behind the Butler.
#
# From step 13 the Butler owns .git, so its config, hooks and info/attributes may name any command (a clean filter, an
# [include], an ext:: URL). Root runs no git on it after that: --verify-live runs git only inside the container as the
# Butler, an apply refuses while .git is in the bundle, and --rollback first moves .git back, hands it to root and puts
# back config, hooks/ and info/attributes from the root-owned snapshot the apply took before step 1, and only then runs
# git. The hourly backup.sh, which runs git as root with hooks on, therefore only ever runs on that restored, root-owned
# repo.git: never on a .git the Butler has owned.
set -Eeuo pipefail
umask 022

# The bundle's GitHub repository. It is renamed to butler.ouro at R4.
BUNDLE_REPO_OWNER=arimendelow
BUNDLE_REPO_NAME=sanctuary.ouro
BUNDLE_REMOTE="git@github.com:${BUNDLE_REPO_OWNER}/${BUNDLE_REPO_NAME}.git"
BUNDLE_BRANCH=main
AGENT_NAME=sanctuary
# backup.sh's commit identity and the fetch refspec the moved repository must have.
BACKUP_COMMIT_NAME="Sanctuary backup"
BACKUP_COMMIT_EMAIL=16390116+arimendelow@users.noreply.github.com
DEFAULT_FETCH='+refs/heads/*:refs/remotes/origin/*'
PSYCHE_FILES="ASPIRATIONS.md IDENTITY.md LORE.md SOUL.md TACIT.md"

CONTAINER=ouro-butler
CONTAINER_BUNDLE=/home/ouro/AgentBundles/sanctuary.ouro
CLI_ENTRY=/opt/ouro/dist/heart/daemon/ouro-entry.js
GATE_ENTRY=/opt/ouro/deploy/unraid/sanctuary-replay-gate.mjs
SYNC_SSH_WRAPPER=/usr/local/libexec/ouro-sync-ssh
CONTAINER_KEY=/run/ouro-sync/deploy_key
# The image's ouro-sync user, which alone reads the key and runs sync's ssh. The stall probe drops its port-22 traffic.
SYNC_USER=ouro-sync
SYNC_CONTAINER_UID=10002
PROBE_COMMENT=sanctuary-sync-cutover-probe
AUDIT_ICON=https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png
# git status and git add -A --dry-run on the live bundle must each stay under this (M5).
TIMING_LIMIT_MS=300
# A stalled fetch must end on its own within this (the wrapper's ssh timeouts are about 20 s).
STALL_LIMIT_S=25

# Tests point every host path into a temp tree. Nothing else reads this.
TEST_ROOT=${OURO_CUTOVER_ROOT:-}
APPDATA=$TEST_ROOT/mnt/user/appdata/ouro-butler
BUNDLE=$APPDATA/agent/sanctuary.ouro
BACKUP=$APPDATA/bundle-backup
BACKUP_GIT=$BACKUP/repo.git
BACKUP_KEY=$BACKUP/deploy_key
KNOWN_HOSTS=$BACKUP/known_hosts
LOCK_FILE=$BACKUP/lock
CUTOVER_LOCK=$BACKUP/cutover.lock
MARKER=$BACKUP/cutover-done
APPLYING=$BACKUP/cutover-applying
INCOMPLETE=$BACKUP/cutover-ROLLBACK-INCOMPLETE
CRON_DISABLED=$BACKUP/sanctuary-bundle-backup.cron.disabled
# What of repo.git can make git run a command, saved as root before step 1 and put back first on rollback (C1).
GIT_SNAPSHOT_PREFIX=$BACKUP/cutover-git-snapshot
SYNC_DIR=$APPDATA/sync
SYNC_KEY=$SYNC_DIR/deploy_key
CRON_FILE=$TEST_ROOT/boot/config/plugins/dynamix/sanctuary-bundle-backup.cron
CRON_TABLE=$TEST_ROOT/etc/cron.d/root
HOST_NODE=$TEST_ROOT/usr/local/bin/node

# The Butler's uid (owns .git), ouro-sync's uid (owns the key) and root. A test that is not root owns all three.
BUTLER_OWNER=10001:10001
SYNC_OWNER=10002:10002
ROOT_OWNER=0:0
if [ -n "$TEST_ROOT" ] && [ -n "${OURO_CUTOVER_OWNER:-}" ]; then
  BUTLER_OWNER=$OURO_CUTOVER_OWNER
  SYNC_OWNER=$OURO_CUTOVER_OWNER
  ROOT_OWNER=$OURO_CUTOVER_OWNER
fi
if [ -n "$TEST_ROOT" ]; then STALL_LIMIT_S=${OURO_CUTOVER_STALL_LIMIT_S:-$STALL_LIMIT_S}; fi
BUTLER_UID=${BUTLER_OWNER%%:*}
SYNC_UID=${SYNC_OWNER%%:*}
SYNC_GID=${SYNC_OWNER##*:}

# Secret-looking names. The gate's SECRET_PATH is the same pattern; a test pins the two together.
SECRET_NAME_PATTERN='credential|secret|token|\.key$|\.pem$|(^|/)\.env($|\.)'

say() { printf '%s\n' "$*"; }
die() { printf 'cutover: %s\n' "$*" >&2; exit 1; }

# Git on the backup repository (before step 5) and on the bundle's own .git (from step 5). No hooks, no fsmonitor, and no
# global excludes file, so root's view of what is ignored is the repository's own (M5).
GIT_SAFE="-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.excludesFile=/dev/null"
# shellcheck disable=SC2086
backup_git() { git $GIT_SAFE --git-dir="$BACKUP_GIT" --work-tree="$BUNDLE" "$@"; }
# shellcheck disable=SC2086
bundle_git() { git $GIT_SAFE --git-dir="$BUNDLE/.git" --work-tree="$BUNDLE" "$@"; }
# backup.sh's ssh, with the host key it already accepted into bundle-backup/known_hosts now required (I2).
BACKUP_SSH="ssh -i $BACKUP_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o BatchMode=yes"

# A config value, or "(unset)" when git says it is unset (exit 1). Any other failure is a failure (M9).
config_value() {
  local gitfn=$1 key=$2 value rc=0
  value=$("$gitfn" config --get "$key") || rc=$?
  case "$rc" in
    0) printf '%s' "$value" ;;
    1) printf '(unset)' ;;
    *) die "git config --get $key failed (exit $rc)" ;;
  esac
}

# Every value of a multi-valued key, joined with " ; ", or "(unset)".
config_all() {
  local gitfn=$1 key=$2 value rc=0
  value=$("$gitfn" config --get-all "$key") || rc=$?
  case "$rc" in
    0) printf '%s' "$value" | awk 'NR > 1 { printf " ; " } { printf "%s", $0 }' ;;
    1) printf '(unset)' ;;
    *) die "git config --get-all $key failed (exit $rc)" ;;
  esac
}

# Sets a config value, or unsets it for "(unset)".
restore_config() {
  local gitfn=$1 key=$2 value=$3
  if [ "$value" = "(unset)" ]; then
    "$gitfn" config --unset-all "$key" || [ $? -eq 5 ]
  else
    "$gitfn" config "$key" "$value"
  fi
}

# One "key: value" line from a file.
file_value() {
  awk -v k="$2: " 'index($0, k) == 1 { print substr($0, length(k) + 1); found = 1; exit } END { exit found ? 0 : 1 }' "$1"
}

# One saved value from the before-state.
before_value() {
  file_value "$BEFORE" "$1" || die "$(basename "$BEFORE") has no \"$1\" line"
}

container_image() {
  local image
  image=$(docker inspect --format '{{.Image}}' "$CONTAINER")
  case "$image" in
    sha256:*) ;;
    *) die "the container's image id is not a sha256 id: $image" ;;
  esac
  [ "${#image}" -eq 71 ] || die "the container's image id is not a sha256 id: $image"
  printf '%s' "$image"
}

# "true", "false", or "unknown" when docker cannot say.
container_running() {
  docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || printf 'unknown'
}

# The exclude list from the release's own code, into $1.
print_exclude() {
  local image=$1 out=$2
  docker run --rm --pull=never --network none --entrypoint node "$image" "$CLI_ENTRY" sanctuary git-exclude --print >"$out.raw"
  # One entry per line and one final newline, exactly as the boot writes it.
  awk 'NF { print }' "$out.raw" >"$out"
  rm -f -- "$out.raw"
  grep -qx 'state/' "$out" || die "the release's exclude list has no state/ entry"
  grep -qx '\*\*/\*\.key' "$out" || die "the release's exclude list has no **/*.key entry"
}

# Milliseconds for git status and git add -A --dry-run. Arguments: the git dir, the work tree and the new exclude list, all
# of which may be read-only. Both run on a private copy of the index (git add --dry-run still takes index.lock), and status
# takes no optional lock, so nothing under the repository is written (I1). No single quotes below: a test runs this text.
# shellcheck disable=SC2016
MEASURE_GIT_SCRIPT='
  repo=$1 w=$2 exclude=$3
  tmp=$(mktemp -d) || exit 1
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT
  if [ -f "$repo/index" ]; then cp "$repo/index" "$tmp/index" || exit 1; fi
  g() { GIT_OPTIONAL_LOCKS=0 GIT_INDEX_FILE="$tmp/index" git -c safe.directory="*" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.excludesFile="$exclude" --git-dir="$repo" --work-tree="$w" "$@"; }
  a=$(date +%s%N); g status --porcelain >/dev/null || exit 1
  b=$(date +%s%N); g add -A --dry-run >/dev/null || exit 1
  c=$(date +%s%N); echo "$(( (b - a) / 1000000 )) $(( (c - b) / 1000000 ))"
'

# The timings inside the release image as the Butler's uid, with the repository and the live bundle mounted read-only.
measure_git() {
  local image=$1 exclude=$2
  docker run --rm --pull=never --network none --user 10001:10001 --entrypoint sh \
    --mount "type=bind,src=$BACKUP_GIT,dst=/cutover/repo.git,readonly" \
    --mount "type=bind,src=$BUNDLE,dst=$CONTAINER_BUNDLE,readonly" \
    --mount "type=bind,src=$exclude,dst=/cutover/exclude,readonly" \
    "$image" -c "$MEASURE_GIT_SCRIPT" sh /cutover/repo.git "$CONTAINER_BUNDLE" /cutover/exclude
}

# Paths in the tracked list ($1, one per line) that look like secrets.
secret_paths() { grep -Ei "$SECRET_NAME_PATTERN" "$1" || true; }

# The paths in a `git status --porcelain --untracked-files=all` file that sync must never commit, from the replay gate's own
# scan inside the release image, so step 10 and the gate cannot drift (I3).
status_problems() {
  local image=$1 status=$2
  docker run --rm -i --pull=never --network none --entrypoint node "$image" "$GATE_ENTRY" status-scan <"$status"
}

# The owner ("uid:gid") and mode ("755") of a path, read without following a link.
owner_and_mode() {
  "$HOST_NODE" -e '
    const s = require("node:fs").lstatSync(process.argv[1]);
    process.stdout.write(s.uid + ":" + s.gid + " " + (s.mode & 0o7777).toString(8));
  ' "$1"
}

# agent.json's "sync" value as JSON, or "(absent)".
agent_sync_value() {
  "$HOST_NODE" -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw new Error(process.argv[1] + " is not a regular file");
    const agent = JSON.parse(fs.readFileSync(fd, "utf8"));
    process.stdout.write(Object.prototype.hasOwnProperty.call(agent, "sync") ? JSON.stringify(agent.sync) : "(absent)");
  ' "$BUNDLE/agent.json"
}

# Edits agent.json's "sync" through a temp file and a rename, keeping its owner and mode. "enable" turns sync on for the
# branch; "restore <json|(absent)>" puts back exactly what the before-state recorded.
edit_agent_sync() {
  "$HOST_NODE" -e '
    const fs = require("node:fs"), path = require("node:path");
    const [file, action, value, branch] = process.argv.slice(1);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(file + " is not a regular file");
    const agent = JSON.parse(fs.readFileSync(fd, "utf8"));
    fs.closeSync(fd);
    if (action === "enable") {
      const sync = agent.sync && typeof agent.sync === "object" ? agent.sync : {};
      agent.sync = { ...sync, enabled: true, branch: sync.branch ?? branch };
    } else if (value === "(absent)") {
      delete agent.sync;
    } else {
      agent.sync = JSON.parse(value);
    }
    const temp = path.join(path.dirname(file), ".agent.json.cutover-" + process.pid);
    const out = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(out, JSON.stringify(agent, null, 2) + "\n");
      fs.fchownSync(out, stat.uid, stat.gid);
      fs.fchmodSync(out, stat.mode & 0o7777);
      fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    fs.renameSync(temp, file);
  ' "$BUNDLE/agent.json" "$1" "${2:-}" "$BUNDLE_BRANCH"
}

# Runs `docker exec "$@"`, its stdout in $EXEC_OUT (default $WORK/exec.out) and its status in $EXEC_STATUS. Dies when the
# check itself could not run (exit 125, 126 or 127, or no such container), so that is never read as the result (M3).
exec_check() {
  EXEC_STATUS=0
  docker exec "$@" >"${EXEC_OUT:-$WORK/exec.out}" 2>"$WORK/exec.err" || EXEC_STATUS=$?
  if { [ "$EXEC_STATUS" -ge 125 ] && [ "$EXEC_STATUS" -le 127 ]; } || grep -qiE 'no such container|is not running' "$WORK/exec.err"; then
    die "the check could not run: docker exec $* exited $EXEC_STATUS: $(head -c 300 "$WORK/exec.err" | tr '\n' ' ')"
  fi
}

# The check that the Butler's uid cannot read the key: `cat` and `test -r` must both exit 1.
assert_key_unreadable() {
  EXEC_OUT=/dev/null exec_check -u 10001 "$CONTAINER" cat "$CONTAINER_KEY"
  case "$EXEC_STATUS" in
    0) die "the Butler's uid can read $CONTAINER_KEY" ;;
    1) ;;
    *) die "cat $CONTAINER_KEY as the Butler's uid exited $EXEC_STATUS, not 1" ;;
  esac
  exec_check -u 10001 "$CONTAINER" test -r "$CONTAINER_KEY"
  case "$EXEC_STATUS" in
    0) die "the Butler's uid can read $CONTAINER_KEY" ;;
    1) ;;
    *) die "test -r $CONTAINER_KEY as the Butler's uid exited $EXEC_STATUS, not 1" ;;
  esac
}

# ---------- dry run ----------

# Refuses a state the cutover cannot start from. Changes nothing.
refuse_unless_ready() {
  [ -d "$BACKUP_GIT" ] || die "$BACKUP_GIT is missing"
  [ -d "$BUNDLE" ] || die "$BUNDLE is missing"
  [ ! -e "$INCOMPLETE" ] || die "a rollback did not finish ($INCOMPLETE); run --rollback again"
  [ ! -e "$APPLYING" ] || die "an apply is running or was interrupted ($APPLYING); run --rollback"
  [ ! -e "$BUNDLE/.git" ] || die "$BUNDLE/.git already exists"
  [ ! -e "$MARKER" ] || die "the cutover is already done ($MARKER)"
  [ -f "$CRON_FILE" ] || die "the backup cron file $CRON_FILE is missing"
  [ -f "$BACKUP_KEY" ] || die "the backup deploy key $BACKUP_KEY is missing"
  [ -f "$KNOWN_HOSTS" ] || die "$KNOWN_HOSTS is missing; backup.sh's pushes fill it, and the cutover's ssh requires it"
}

# Reads the before-state, prints it and saves it to a new timestamped file, never overwriting one. Changes nothing else.
# Sets BEFORE, and leaves the exclude list in $WORK/exclude.
preflight() {
  refuse_unless_ready
  local image branch upstream remote merge stash tracked timings status_ms add_ms excluded secrets out
  local origin_url fetch bare worktree sshcmd ucache manyfiles agent_sync repo_stat repo_owner repo_mode key_state
  image=$(container_image)
  print_exclude "$image" "$WORK/exclude"
  chmod 0644 "$WORK/exclude"
  timings=$(measure_git "$image" "$WORK/exclude")
  read -r status_ms add_ms <<<"$timings"
  case "$status_ms:$add_ms" in
    *[!0-9:]* | :* | *:) die "the git timing inside the image printed \"$timings\"" ;;
  esac
  branch=$(backup_git symbolic-ref --short HEAD) || die "the backup repository's HEAD is not on a branch"
  remote=$(config_value backup_git "branch.$branch.remote")
  merge=$(config_value backup_git "branch.$branch.merge")
  upstream=$(backup_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || upstream="(none)"
  stash=$(backup_git rev-list --walk-reflogs --count refs/stash 2>/dev/null) || stash=0
  origin_url=$(config_value backup_git remote.origin.url)
  fetch=$(config_all backup_git remote.origin.fetch)
  bare=$(config_value backup_git core.bare)
  worktree=$(config_value backup_git core.worktree)
  sshcmd=$(config_value backup_git core.sshCommand)
  ucache=$(config_value backup_git core.untrackedCache)
  manyfiles=$(config_value backup_git feature.manyFiles)
  agent_sync=$(agent_sync_value)
  repo_stat=$(owner_and_mode "$BACKUP_GIT")
  repo_owner=${repo_stat% *}
  repo_mode=${repo_stat#* }
  if [ -e "$SYNC_KEY" ]; then key_state=present; else key_state=absent; fi
  tracked=$WORK/tracked
  backup_git ls-files >"$tracked"
  excluded=$(backup_git ls-files -ci --exclude-per-directory=.gitignore --exclude-from="$WORK/exclude")
  secrets=$(secret_paths "$tracked")
  out=$WORK/before
  {
    say "# Bundle sync cutover: the before-state, read $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    say "origin.url: $origin_url"
    say "target.url: $BUNDLE_REMOTE"
    say "remote.origin.fetch: $fetch"
    say "image: $image"
    say "branch: $branch"
    say "upstream: $upstream"
    say "branch.remote: $remote"
    say "branch.merge: $merge"
    say "core.bare: $bare"
    say "core.worktree: $worktree"
    say "core.sshCommand: $sshcmd"
    say "core.untrackedCache: $ucache"
    say "feature.manyFiles: $manyfiles"
    say "repo.git owner: $repo_owner"
    say "repo.git mode: $repo_mode"
    say "agent.json sync: $agent_sync"
    say "sync key: $key_state"
    say "known_hosts: $KNOWN_HOSTS"
    say "stash count: $stash"
    say "git status ms: $status_ms"
    say "git add -A --dry-run ms: $add_ms"
    say "tracked files: $(wc -l <"$tracked" | tr -d ' ')"
    say "tracked paths the new exclude matches: $(printf '%s' "$excluded" | grep -c . || true)"
    [ -z "$excluded" ] || printf '%s\n' "$excluded" | sed 's/^/  /'
    say "secret-named tracked paths: $(printf '%s' "$secrets" | grep -c . || true)"
    [ -z "$secrets" ] || printf '%s\n' "$secrets" | sed 's/^/  /'
    say "cron file: $CRON_FILE"
    sed 's/^/  /' "$CRON_FILE"
    if [ -f "$BACKUP_GIT/info/exclude" ]; then
      say "info/exclude:"
      sed 's/^/  | /' "$BACKUP_GIT/info/exclude"
      say "info/exclude.base64: $(base64 <"$BACKUP_GIT/info/exclude" | tr -d '\n')"
    else
      say "info/exclude: (absent)"
      say "info/exclude.base64: (absent)"
    fi
  } >"$out"
  cat "$out"
  # A new file each time; noclobber refuses to replace one that exists (M10).
  BEFORE=$BACKUP/cutover-before-$(date -u +%Y%m%dT%H%M%SZ)-$$.txt
  (set -C; cat "$out" >"$BEFORE") || die "could not write $BEFORE"
  local problems=0
  if [ "$status_ms" -gt "$TIMING_LIMIT_MS" ] || [ "$add_ms" -gt "$TIMING_LIMIT_MS" ]; then
    say "FAIL: git status took $status_ms ms and git add -A --dry-run $add_ms ms; each must be at most $TIMING_LIMIT_MS ms" >&2
    problems=1
  fi
  if [ -n "$secrets" ]; then
    say "FAIL: tracked paths look like secrets; untrack them and rotate what they hold before the cutover" >&2
    problems=1
  fi
  [ "$problems" -eq 0 ] || die "the dry run found problems; nothing was changed"
  say "dry run ok; saved $BEFORE"
}

# ---------- rollback ----------

ROLLBACK_FAILED=""

# Runs one rollback step and records its result. A failed step never stops the steps after it.
rollback_step() {
  local name=$1
  shift
  if "$@"; then
    say "rollback: $name: ok"
  else
    say "rollback: $name: FAILED"
    ROLLBACK_FAILED="${ROLLBACK_FAILED:+$ROLLBACK_FAILED, }$name"
  fi
}

# Undoes the cutover from the before-state in $BEFORE. Every step reads the state it finds, so a rollback can run again
# after one that was cut short. $1 is the step the apply reached (15 for --rollback): the container is stopped only when
# the apply started it, and started again only when the apply stopped it.
rollback_from() {
  local reached=$1 running
  # Nothing interrupts a rollback: a second Ctrl-C, a TERM or a lost terminal is ignored, here and in every child (C1).
  trap '' INT TERM HUP PIPE
  set +e
  ROLLBACK_FAILED=""
  # Read now: the marker goes, and the INCOMPLETE record is rewritten, before the rollback ends.
  ROLLBACK_SNAPSHOT=$(recorded_value "git snapshot") || ROLLBACK_SNAPSHOT=""
  ROLLBACK_SNAPSHOT_HOOKS=$(recorded_value "git snapshot hooks") || ROLLBACK_SNAPSHOT_HOOKS=""
  ROLLBACK_SNAPSHOT_ATTRIBUTES=$(recorded_value "git snapshot attributes") || ROLLBACK_SNAPSHOT_ATTRIBUTES=""
  say "rolling back from step $reached, from $BEFORE"
  if [ "$reached" -ge 15 ]; then rollback_step "stop the Butler" docker stop "$CONTAINER"; fi
  rollback_step "restore agent.json's sync value" restore_agent_sync
  rollback_step "move .git back to repo.git" move_git_back
  # Before any git: root owns repo.git again and nothing the Butler wrote into it can run (C1).
  rollback_step "give repo.git back to root and put back its config, hooks and attributes" secure_backup_git
  rollback_step "clear a stale index.lock" clear_stale_index_lock
  rollback_step "restore repo.git's config, branch and exclude" git_step restore_backup_repo
  rollback_step "drop an apply commit GitHub never got" git_step drop_unpushed_commit
  rollback_step "restore repo.git's owner and mode" restore_repo_owner
  rollback_step "remove the sync key the apply installed" remove_installed_key
  rollback_step "restore the backup cron" restore_cron
  rollback_step "remove the cutover marker" rm -f -- "$MARKER"
  rollback_step "check the hourly backup can push" git_step check_backup_can_push
  if [ "$reached" -ge 1 ]; then
    rollback_step "start the Butler" docker start "$CONTAINER"
    rollback_step "check the Butler is running" butler_is_running
  fi
  running=$(container_running)
  case "$running" in
    true) running="running" ;;
    false) running="STOPPED" ;;
    *) running="in an unknown state (docker inspect failed)" ;;
  esac
  if [ -n "$ROLLBACK_FAILED" ]; then
    {
      say "before: $BEFORE"
      [ -z "$ROLLBACK_SNAPSHOT" ] || say "git snapshot: $ROLLBACK_SNAPSHOT"
      [ -z "$ROLLBACK_SNAPSHOT_HOOKS" ] || say "git snapshot hooks: $ROLLBACK_SNAPSHOT_HOOKS"
      [ -z "$ROLLBACK_SNAPSHOT_ATTRIBUTES" ] || say "git snapshot attributes: $ROLLBACK_SNAPSHOT_ATTRIBUTES"
      say "failed: $ROLLBACK_FAILED"
      say "at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      say "butler: $running"
    } >"$INCOMPLETE" || say "could not write $INCOMPLETE"
    say "ROLLBACK INCOMPLETE: these steps failed: $ROLLBACK_FAILED. The Butler is $running. See $INCOMPLETE; fix the cause, then run --rollback again."
    return 1
  fi
  rm -f -- "$INCOMPLETE" "$APPLYING"
  say "rolled back: the hourly backup owns the bundle again; commits already pushed stay on GitHub. The Butler is $running."
  [ "$reached" -lt 1 ] || [ "$running" = running ]
}

butler_is_running() { [ "$(container_running)" = true ]; }

# Before step 1, while root still owns repo.git: a root-owned 0600 tar of what in it can make git run a command, which
# the Butler can change once it owns .git: config, hooks/ and info/attributes. Sets SNAPSHOT and SNAPSHOT_LINES, the lines
# the apply records with its state so a rollback finds the snapshot.
take_git_snapshot() {
  local hooks=absent attributes=absent
  local -a members=(config)
  [ ! -L "$BACKUP_GIT" ] && [ -d "$BACKUP_GIT" ] || die "$BACKUP_GIT is not a real directory"
  [ ! -L "$BACKUP_GIT/config" ] && [ -f "$BACKUP_GIT/config" ] || die "$BACKUP_GIT/config is not a regular file"
  if [ -d "$BACKUP_GIT/hooks" ] && [ ! -L "$BACKUP_GIT/hooks" ]; then hooks=present; members+=(hooks); fi
  if [ -f "$BACKUP_GIT/info/attributes" ] && [ ! -L "$BACKUP_GIT/info/attributes" ]; then attributes=present; members+=(info/attributes); fi
  SNAPSHOT=$GIT_SNAPSHOT_PREFIX-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar
  (set -C; umask 077; : >"$SNAPSHOT") || die "could not create $SNAPSHOT"
  tar -C "$BACKUP_GIT" -cf "$SNAPSHOT" -- "${members[@]}" || die "could not save $BACKUP_GIT's config and hooks to $SNAPSHOT"
  if ! { chown "$ROOT_OWNER" "$SNAPSHOT" && chmod 0600 "$SNAPSHOT"; }; then die "could not make $SNAPSHOT root-only"; fi
  SNAPSHOT_LINES=$(printf 'git snapshot: %s\ngit snapshot hooks: %s\ngit snapshot attributes: %s' "$SNAPSHOT" "$hooks" "$attributes")
}

# A value the apply recorded: in the in-progress file, the unfinished rollback's file, or the marker.
recorded_value() {
  local file value
  for file in "$APPLYING" "$INCOMPLETE" "$MARKER"; do
    if [ -f "$file" ] && value=$(file_value "$file" "$1"); then printf '%s' "$value"; return 0; fi
  done
  return 1
}

# Moves a path aside as <path>.disabled-<time>-<pid>, never deleting it.
disable_path() {
  local target
  target="$1.disabled-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv -- "$1" "$target" && say "moved aside $1 (now $target)"
}

# The first thing a rollback does to repo.git, before any git runs on it: root owns it again, config is the snapshot's
# byte for byte (so no [include], filter, alias, sshCommand, insteadOf, hooksPath, fsmonitor or extension the Butler
# added survives), config.worktree and commondir are gone, hooks/ holds exactly the snapshot's hooks (anything else moved
# aside, never deleted), and info/attributes is the snapshot's or absent. GIT_READY says whether git may run on it.
GIT_READY=0
secure_backup_git() {
  local snapshot hooks attributes owner mode tmp entry name rc=0
  GIT_READY=0
  snapshot=$ROLLBACK_SNAPSHOT hooks=$ROLLBACK_SNAPSHOT_HOOKS attributes=$ROLLBACK_SNAPSHOT_ATTRIBUTES
  [ -n "$snapshot" ] && [ -n "$hooks" ] && [ -n "$attributes" ] || { say "no git snapshot is recorded, so no git runs on $BACKUP_GIT"; return 1; }
  [ -f "$snapshot" ] && [ ! -L "$snapshot" ] || { say "the git snapshot $snapshot is missing, so no git runs on $BACKUP_GIT"; return 1; }
  [ -d "$BACKUP_GIT" ] && [ ! -L "$BACKUP_GIT" ] || { say "$BACKUP_GIT is not a real directory"; return 1; }
  owner=$(before_value "repo.git owner") || return 1
  mode=$(before_value "repo.git mode") || return 1
  chown -R -h "$owner" "$BACKUP_GIT" && chmod "$mode" "$BACKUP_GIT" || return 1
  tmp=$(umask 077; mktemp -d "$BACKUP/.cutover-git-restore.XXXXXX") || return 1
  # In a subshell, so the work directory is removed whichever step fails.
  (
    tar -C "$tmp" -xf "$snapshot" || exit 1
    # Each copy goes to a fresh name first (rm never follows a link the Butler may have planted there), then over the old file.
    rm -f -- "$BACKUP_GIT/.config.cutover-restore" && cp -p -- "$tmp/config" "$BACKUP_GIT/.config.cutover-restore" && mv -f -- "$BACKUP_GIT/.config.cutover-restore" "$BACKUP_GIT/config" || exit 1
    rm -f -- "$BACKUP_GIT/config.worktree" || exit 1
    if [ -e "$BACKUP_GIT/commondir" ] || [ -L "$BACKUP_GIT/commondir" ]; then disable_path "$BACKUP_GIT/commondir" || exit 1; fi
    if [ -L "$BACKUP_GIT/hooks" ] || { [ -e "$BACKUP_GIT/hooks" ] && [ ! -d "$BACKUP_GIT/hooks" ]; }; then disable_path "$BACKUP_GIT/hooks" || exit 1; fi
    if [ "$hooks" = present ] || [ -d "$BACKUP_GIT/hooks" ]; then
      mkdir -p -- "$BACKUP_GIT/hooks" || exit 1
      for entry in "$BACKUP_GIT/hooks"/* "$BACKUP_GIT/hooks"/.[!.]* "$BACKUP_GIT/hooks"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        name=${entry##*/}
        case "$name" in *.disabled-*) continue ;; esac
        if [ -f "$tmp/hooks/$name" ] && [ ! -L "$tmp/hooks/$name" ] && [ -f "$entry" ] && [ ! -L "$entry" ] && cmp -s -- "$entry" "$tmp/hooks/$name"; then continue; fi
        disable_path "$entry" || exit 1
      done
      for entry in "$tmp/hooks"/* "$tmp/hooks"/.[!.]* "$tmp/hooks"/..?*; do
        [ -f "$entry" ] && [ ! -L "$entry" ] || continue
        name=${entry##*/}
        rm -f -- "$BACKUP_GIT/hooks/.$name.cutover-restore" && cp -p -- "$entry" "$BACKUP_GIT/hooks/.$name.cutover-restore" && mv -f -- "$BACKUP_GIT/hooks/.$name.cutover-restore" "$BACKUP_GIT/hooks/$name" || exit 1
      done
    fi
    if [ -L "$BACKUP_GIT/info" ] || { [ -e "$BACKUP_GIT/info" ] && [ ! -d "$BACKUP_GIT/info" ]; }; then disable_path "$BACKUP_GIT/info" || exit 1; fi
    if [ "$attributes" = present ]; then
      mkdir -p -- "$BACKUP_GIT/info" || exit 1
      rm -f -- "$BACKUP_GIT/info/.attributes.cutover-restore" && cp -p -- "$tmp/info/attributes" "$BACKUP_GIT/info/.attributes.cutover-restore" && mv -f -- "$BACKUP_GIT/info/.attributes.cutover-restore" "$BACKUP_GIT/info/attributes" || exit 1
    elif [ -e "$BACKUP_GIT/info/attributes" ] || [ -L "$BACKUP_GIT/info/attributes" ]; then
      rm -f -- "$BACKUP_GIT/info/attributes" || exit 1
    fi
    chown -R -h "$owner" "$BACKUP_GIT" && chmod "$mode" "$BACKUP_GIT"
  ) || rc=1
  rm -rf -- "$tmp"
  [ "$rc" -eq 0 ] || return 1
  GIT_READY=1
}

# A rollback step that runs git on repo.git: only once secure_backup_git has put it back.
git_step() {
  if [ "$GIT_READY" -ne 1 ]; then say "skipped: repo.git's config and hooks were not put back, so no git runs on it"; return 1; fi
  "$@"
}

restore_agent_sync() {
  local value
  value=$(file_value "$BEFORE" "agent.json sync") || { say "the before-state has no agent.json sync line"; return 1; }
  [ "$(agent_sync_value)" = "$value" ] || edit_agent_sync restore "$value"
}

move_git_back() {
  if [ -e "$BUNDLE/.git" ] && [ -e "$BACKUP_GIT" ]; then say "both $BUNDLE/.git and $BACKUP_GIT exist"; return 1; fi
  if [ -e "$BUNDLE/.git" ]; then mv -- "$BUNDLE/.git" "$BACKUP_GIT"; fi
  [ -d "$BACKUP_GIT" ]
}

# A git that a stop killed mid-write leaves index.lock behind, and every hourly backup would then fail unseen. It is removed
# only when no git runs on the host or in the container (M16).
clear_stale_index_lock() {
  [ -e "$BACKUP_GIT/index.lock" ] || return 0
  if pgrep -x git >/dev/null; then say "a git process is running on the host; $BACKUP_GIT/index.lock is left in place"; return 1; fi
  if [ "$(container_running)" != false ]; then
    local rc=0
    docker exec "$CONTAINER" pgrep -x git >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 1 ]; then say "git may be running in $CONTAINER (pgrep exited $rc); $BACKUP_GIT/index.lock is left in place"; return 1; fi
  fi
  rm -f -- "$BACKUP_GIT/index.lock" && say "removed a stale $BACKUP_GIT/index.lock (no git was running)"
}

# Puts back the backup repository's config, branch, HEAD and exclude from the before-state.
restore_backup_repo() {
  local branch key value encoded
  [ -d "$BACKUP_GIT" ] || return 1
  branch=$(before_value branch) || return 1
  if [ "$branch" != "$BUNDLE_BRANCH" ] && backup_git rev-parse --verify -q "refs/heads/$BUNDLE_BRANCH" >/dev/null \
    && [ "$(backup_git symbolic-ref --short HEAD)" = "$BUNDLE_BRANCH" ]; then
    backup_git branch -M "$BUNDLE_BRANCH" "$branch" || return 1
  fi
  value=$(before_value origin.url) || return 1
  restore_config backup_git remote.origin.url "$value" || return 1
  value=$(before_value branch.remote) || return 1
  restore_config backup_git "branch.$branch.remote" "$value" || return 1
  value=$(before_value branch.merge) || return 1
  restore_config backup_git "branch.$branch.merge" "$value" || return 1
  for key in core.bare core.worktree core.sshCommand core.untrackedCache feature.manyFiles; do
    value=$(before_value "$key") || return 1
    restore_config backup_git "$key" "$value" || return 1
  done
  encoded=$(before_value info/exclude.base64) || return 1
  if [ "$encoded" = "(absent)" ]; then
    rm -f -- "$BACKUP_GIT/info/exclude"
  else
    mkdir -p -- "$BACKUP_GIT/info" || return 1
    rm -f -- "$BACKUP_GIT/info/exclude.restore" || return 1
    printf '%s' "$encoded" | base64 -d >"$BACKUP_GIT/info/exclude.restore" || return 1
    mv -f -- "$BACKUP_GIT/info/exclude.restore" "$BACKUP_GIT/info/exclude"
  fi
}

# A commit the apply made after step 4 that GitHub never got (step 9 stopped before its push) is dropped from the branch,
# so the hourly backup never pushes it. Only GitHub's own main decides: the branch moves back to the step-4 head only when
# GitHub's main is that head. A push can reach GitHub and still fail on the host, and the owner can push meanwhile, so
# local refs are never trusted for this. The work tree is not touched.
drop_unpushed_commit() {
  local head current listed github
  head=$(file_value "$APPLYING" head 2>/dev/null) || return 0
  [ -d "$BACKUP_GIT" ] || return 1
  current=$(backup_git rev-parse HEAD) || return 1
  [ "$current" != "$head" ] || return 0
  listed=$(GIT_SSH_COMMAND=$BACKUP_SSH backup_git ls-remote origin "refs/heads/$BUNDLE_BRANCH") || {
    say "could not read GitHub's $BUNDLE_BRANCH (ls-remote failed), so the branch was left at $current; check GitHub, then run --rollback again"
    return 1
  }
  github=${listed%%[[:space:]]*}
  if [ "$github" = "$head" ]; then
    backup_git reset -q --mixed "$head" || return 1
    say "reset the branch to $head, dropping a commit GitHub never got"
  else
    say "kept the branch: GitHub already has ${github:-(no $BUNDLE_BRANCH)}"
  fi
}

# The hourly backup's push hides its failures, so the rollback proves now that the next one can land.
check_backup_can_push() {
  local out
  [ -d "$BACKUP_GIT" ] || return 1
  if out=$(GIT_SSH_COMMAND=$BACKUP_SSH backup_git push --dry-run origin "HEAD:$BUNDLE_BRANCH" 2>&1); then return 0; fi
  if printf '%s' "$out" | grep -qiE 'rejected|non-fast-forward|fetch first'; then
    say "the hourly backup can't push; GitHub has commits the host doesn't. Merge GitHub's $BUNDLE_BRANCH into repo.git's branch, then run --rollback again"
  else
    say "the hourly backup can't push: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  fi
  return 1
}

# repo.git's owner (recursively) and mode, as the before-state recorded them (M8).
restore_repo_owner() {
  local owner mode
  [ -d "$BACKUP_GIT" ] || return 1
  owner=$(before_value "repo.git owner") || return 1
  mode=$(before_value "repo.git mode") || return 1
  chown -R -h "$owner" "$BACKUP_GIT" && chmod "$mode" "$BACKUP_GIT"
}

remove_installed_key() {
  local state
  state=$(before_value "sync key") || return 1
  [ "$state" = present ] || rm -f -- "$SYNC_KEY" "$SYNC_DIR/.deploy_key.cutover"
}

restore_cron() {
  if [ ! -e "$CRON_FILE" ] && [ -f "$CRON_DISABLED" ]; then mv -- "$CRON_DISABLED" "$CRON_FILE" || return 1; fi
  [ -f "$CRON_FILE" ] || { say "$CRON_FILE is missing"; return 1; }
  update_cron || return 1
  grep -q 'backup\.sh' "$CRON_TABLE" || { say "$CRON_TABLE has no backup.sh entry after update_cron"; return 1; }
}

# Whether nothing of a cutover is on disk: no marker, no .git in the bundle, no apply in progress, no unfinished rollback
# and no disabled cron file.
nothing_to_roll_back() {
  [ ! -e "$MARKER" ] && [ ! -e "$BUNDLE/.git" ] && [ ! -e "$APPLYING" ] && [ ! -e "$INCOMPLETE" ] && [ ! -e "$CRON_DISABLED" ]
}

# The before-state the apply recorded: in the in-progress file, the unfinished rollback's file, or the marker.
recorded_before() {
  local file value
  for file in "$APPLYING" "$INCOMPLETE" "$MARKER"; do
    if [ -f "$file" ] && value=$(file_value "$file" before) && [ -f "$value" ]; then printf '%s' "$value"; return 0; fi
  done
  return 1
}

rollback() {
  if nothing_to_roll_back; then say "nothing to roll back: no cutover marker and no .git in the bundle"; return 0; fi
  # A running apply holds this lock and rolls itself back on failure; a second writer would race it.
  exec 8>>"$CUTOVER_LOCK"
  if ! flock -n 8; then
    die "an apply is running (log: $(file_value "$APPLYING" log 2>/dev/null || printf 'unknown')); it rolls itself back on failure. Run --rollback after it ends"
  fi
  BEFORE=$(recorded_before) || die "no recorded before-state: none of $APPLYING, $INCOMPLETE or $MARKER names one"
  exec 9>>"$LOCK_FILE"
  flock -w 900 9 || die "the backup lock stayed busy for 15 minutes"
  rollback_from 15
}

# ---------- apply ----------

STEP=0
APPLIED=0
IPTABLES_RULE=""
BEFORE=""
DETACHED_LOG=${OURO_CUTOVER_DETACHED:-}

# The one EXIT trap: an apply that did not finish rolls back from the step it reached; the iptables rule and the work
# directory never outlive the script; a detached run records its final status for the process following its log.
on_exit() {
  local status=$?
  trap '' INT TERM HUP PIPE
  # A failure inside a redirected command (`f >/dev/null`) runs this trap under that redirection: write to the script's own output.
  exec 1>&5 2>&6
  if [ "$MODE" = apply ] && [ "$APPLIED" -ne 1 ] && [ "$STEP" -gt 0 ]; then
    say "cutover failed at step $STEP (exit $status); rolling back"
    rollback_from "$STEP" || true
    status=1
  fi
  remove_drop_rule || status=1
  [ -z "${WORK:-}" ] || rm -rf -- "$WORK"
  if [ -n "$DETACHED_LOG" ]; then
    printf '%s\n' "$status" >"$DETACHED_LOG.status.tmp" && mv -f -- "$DETACHED_LOG.status.tmp" "$DETACHED_LOG.status"
  fi
  exit "$status"
}

assert_owned_by_butler() {
  local strays
  strays=$(find "$BUNDLE/.git" ! -uid "$BUTLER_UID" -print | head -5)
  [ -z "$strays" ] || die ".git still has paths not owned by $BUTLER_UID: $strays"
}

# The key's mode, owner and type, read without opening it.
assert_sync_key() {
  "$HOST_NODE" -e '
    const fs = require("node:fs");
    const [dir, key, uid, gid, rootUid] = process.argv.slice(1);
    const d = fs.lstatSync(dir), k = fs.lstatSync(key);
    const fail = (m) => { process.stderr.write("cutover: " + m + "\n"); process.exit(1); };
    if (!d.isDirectory() || (d.mode & 0o7777) !== 0o755 || d.uid !== Number(rootUid)) fail(dir + " must be a root-owned 0755 directory");
    if (!k.isFile() || (k.mode & 0o7777) !== 0o400 || k.uid !== Number(uid) || k.gid !== Number(gid)) fail(key + " must be a regular file, mode 0400, owner " + uid + ":" + gid);
  ' "$SYNC_DIR" "$SYNC_KEY" "$SYNC_UID" "$SYNC_GID" "${ROOT_OWNER%%:*}"
}

# Every psyche file is still tracked (M5).
assert_psyche_tracked() {
  local name
  for name in $PSYCHE_FILES; do
    bundle_git ls-files --error-unmatch -- "psyche/$name" >/dev/null 2>&1 || die "psyche/$name would no longer be tracked; nothing was pushed"
  done
}

# The effective audit of the started container, with sync on, so a missing /run/ouro-sync mount fails the apply (13b).
audit_started_container() {
  local image=$1 reference
  reference=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")
  (umask 077; docker inspect "$CONTAINER" >"$WORK/container.json"; docker image inspect "$image" >"$WORK/image.json")
  docker run --rm --pull=never --network=none \
    --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
    --mount "type=bind,src=$WORK/container.json,dst=/audit/container.json,readonly" \
    --mount "type=bind,src=$WORK/image.json,dst=/audit/image.json,readonly" \
    "$image" --inspect /audit/container.json --image-inspect /audit/image.json --expected-image "$image" \
    --mount-contract canonical-gateway --expected-image-reference "$reference" --expected-icon "$AUDIT_ICON" --sync-enabled true
}

apply() {
  preflight
  local image head remote_head untrack status dirty fetch
  image=$(before_value image)
  # The moved repository must fetch every branch into refs/remotes/origin/, so a push moves the tracking ref (I4).
  fetch=$(before_value remote.origin.fetch)
  [ "$fetch" = "$DEFAULT_FETCH" ] || die "repo.git's remote.origin.fetch is \"$fetch\", not \"$DEFAULT_FETCH\"; nothing was changed"
  exec 8>>"$CUTOVER_LOCK"
  flock -n 8 || die "another cutover run holds $CUTOVER_LOCK; nothing was changed"

  take_git_snapshot
  STEP=1; say "1. stopping $CONTAINER"
  printf 'before: %s\nlog: %s\nstarted: %s\n%s\n' "$BEFORE" "${DETACHED_LOG:-(none)}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SNAPSHOT_LINES" >"$APPLYING.tmp"
  mv -f -- "$APPLYING.tmp" "$APPLYING"
  docker stop "$CONTAINER" >/dev/null

  STEP=2; say "2. disabling the hourly backup cron"
  mv -- "$CRON_FILE" "$CRON_DISABLED"
  update_cron
  if grep -q 'backup\.sh' "$CRON_TABLE"; then die "$CRON_TABLE still runs backup.sh"; fi

  STEP=3; say "3. taking $LOCK_FILE"
  exec 9>>"$LOCK_FILE"
  flock -w 900 9 || die "the backup lock stayed busy for 15 minutes"

  STEP=4; say "4. the last backup commit and push, as backup.sh makes them"
  backup_git add -A
  if ! backup_git diff --cached --quiet; then
    backup_git -c "user.name=$BACKUP_COMMIT_NAME" -c "user.email=$BACKUP_COMMIT_EMAIL" commit -q -m "backup $(date -u +%Y-%m-%dT%H:%MZ)"
  fi
  GIT_SSH_COMMAND=$BACKUP_SSH backup_git push -q origin "HEAD:$BUNDLE_BRANCH"
  printf 'head: %s\n' "$(backup_git rev-parse HEAD)" >>"$APPLYING"

  STEP=5; say "5. moving the repository into the bundle"
  mv -- "$BACKUP_GIT" "$BUNDLE/.git"
  restore_config bundle_git core.bare "(unset)"
  restore_config bundle_git core.worktree "(unset)"
  restore_config bundle_git core.sshCommand "(unset)"

  STEP=6; say "6. origin is $BUNDLE_REMOTE"
  bundle_git remote set-url origin "$BUNDLE_REMOTE"

  STEP=7; say "7. fetching origin $BUNDLE_BRANCH and tracking it"
  GIT_SSH_COMMAND=$BACKUP_SSH bundle_git fetch -q origin "+refs/heads/$BUNDLE_BRANCH:refs/remotes/origin/$BUNDLE_BRANCH"
  bundle_git branch -M "$BUNDLE_BRANCH"
  bundle_git branch -q -u "origin/$BUNDLE_BRANCH"
  head=$(bundle_git rev-parse HEAD)
  remote_head=$(bundle_git rev-parse "refs/remotes/origin/$BUNDLE_BRANCH")
  [ "$head" = "$remote_head" ] || die "HEAD $head is not origin/$BUNDLE_BRANCH $remote_head"

  STEP=8; say "8. writing the release's exclude list"
  mkdir -p -- "$BUNDLE/.git/info"
  cp -- "$WORK/exclude" "$BUNDLE/.git/info/exclude.cutover"
  mv -f -- "$BUNDLE/.git/info/exclude.cutover" "$BUNDLE/.git/info/exclude"

  STEP=9; say "9. untracking excluded files"
  untrack=$WORK/untrack
  bundle_git ls-files -ci --exclude-standard -z >"$untrack"
  if [ -s "$untrack" ]; then
    bundle_git --literal-pathspecs rm --cached --quiet --pathspec-from-file="$untrack" --pathspec-file-nul
    bundle_git -c "user.name=$AGENT_NAME" -c "user.email=$AGENT_NAME@ouro.local" commit -q -m "sync: stop tracking package-managed and excluded files"
    assert_psyche_tracked
    GIT_SSH_COMMAND=$BACKUP_SSH bundle_git push -q origin "HEAD:$BUNDLE_BRANCH"
  fi
  assert_psyche_tracked
  bundle_git config core.untrackedCache true
  bundle_git config feature.manyFiles true

  STEP=10; say "10. checking nothing excluded is tracked"
  [ -z "$(bundle_git ls-files -ci --exclude-standard)" ] || die "excluded files are still tracked"
  status=$WORK/status
  GIT_OPTIONAL_LOCKS=0 bundle_git status --porcelain --untracked-files=all >"$status"
  dirty=$(status_problems "$image" "$status")
  [ -z "$dirty" ] || die "git status shows package-managed or secret paths: $(printf '%s' "$dirty" | tr '\n' ' ')"

  STEP=11; say "11. installing the sync key for ouro-sync"
  [ ! -L "$SYNC_DIR" ] || die "$SYNC_DIR is a symlink"
  mkdir -p -- "$SYNC_DIR"
  chown -h "$ROOT_OWNER" "$SYNC_DIR"
  chmod 0755 "$SYNC_DIR"
  rm -f -- "$SYNC_DIR/.deploy_key.cutover"
  # The copy is born 0600, so it is never readable to anyone else, even before the chmod (M6).
  (umask 077; cp -- "$BACKUP_KEY" "$SYNC_DIR/.deploy_key.cutover")
  chown "$SYNC_OWNER" "$SYNC_DIR/.deploy_key.cutover"
  chmod 0400 "$SYNC_DIR/.deploy_key.cutover"
  mv -f -- "$SYNC_DIR/.deploy_key.cutover" "$SYNC_KEY"
  assert_sync_key

  STEP=12; say "12. turning sync on in agent.json"
  edit_agent_sync enable

  STEP=13; say "13. handing .git to the Butler"
  chown -R -h "$BUTLER_OWNER" "$BUNDLE/.git"
  assert_owned_by_butler

  STEP=14; say "14. writing $MARKER"
  printf 'before: %s\n%s\ndone: %s\n' "$BEFORE" "$SNAPSHOT_LINES" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MARKER"

  STEP=15; say "15. starting $CONTAINER"
  docker start "$CONTAINER" >/dev/null
  say "13b. auditing the started container with sync on"
  audit_started_container "$image" >/dev/null
  exec_check -u 10001 "$CONTAINER" test -r "$CONTAINER_KEY"
  case "$EXEC_STATUS" in
    0) die "the Butler's uid can read $CONTAINER_KEY" ;;
    1) ;;
    *) die "test -r $CONTAINER_KEY as the Butler's uid exited $EXEC_STATUS, not 1" ;;
  esac

  rm -f -- "$APPLYING"
  APPLIED=1
  say "cutover done. Run --verify-live next."
}

# ---------- verify live ----------

# Removes the stall probe's rule and proves it is gone (`iptables -C` must then fail).
remove_drop_rule() {
  [ -n "$IPTABLES_RULE" ] || return 0
  local rule=$IPTABLES_RULE
  IPTABLES_RULE=""
  # shellcheck disable=SC2086
  iptables -D $rule || say "verify: could not remove the iptables rule: iptables -D $rule" >&2
  # shellcheck disable=SC2086
  if iptables -C $rule 2>/dev/null; then
    say "verify: THE IPTABLES RULE IS STILL IN PLACE; remove it by hand: iptables -D $rule" >&2
    return 1
  fi
}

butler_sync() { docker exec -u 10001 "$CONTAINER" timeout 60 node "$CLI_ENTRY" sync --agent "$AGENT_NAME"; }

verify_live() {
  [ -e "$MARKER" ] || die "the cutover is not done ($MARKER is missing)"
  local heads uid start elapsed status out leftover
  trap 'trap "" INT TERM HUP; exit 130' INT TERM
  trap 'trap "" INT TERM HUP; exit 129' HUP

  say "the sync path reaches GitHub as ouro-sync"
  heads=$(docker exec -u 10001 -e "GIT_SSH_COMMAND=sudo -n -u ouro-sync $SYNC_SSH_WRAPPER" -e GIT_SSH_VARIANT=ssh "$CONTAINER" \
    git ls-remote "$BUNDLE_REMOTE" "refs/heads/$BUNDLE_BRANCH")
  [ -n "$heads" ] || die "git ls-remote through $SYNC_SSH_WRAPPER returned no $BUNDLE_BRANCH"

  say "the Butler's uid cannot read the key"
  assert_key_unreadable

  say "a stalled fetch ends on its own"
  # The container shares the host's network, so the rule drops port 22 for the sync user's uid alone (M4).
  exec_check "$CONTAINER" id -u "$SYNC_USER"
  uid=$(tr -d '[:space:]' <"$WORK/exec.out")
  [ "$EXEC_STATUS" -eq 0 ] && [ "$uid" = "$SYNC_CONTAINER_UID" ] || die "the image's $SYNC_USER uid is \"$uid\", not $SYNC_CONTAINER_UID"
  IPTABLES_RULE="OUTPUT -m owner --uid-owner $uid -p tcp --dport 22 -m comment --comment $PROBE_COMMENT -j DROP"
  # shellcheck disable=SC2086
  iptables -I $IPTABLES_RULE
  start=$(date +%s)
  status=0
  out=$(butler_sync 2>&1) || status=$?
  elapsed=$(( $(date +%s) - start ))
  remove_drop_rule || die "the stall probe's iptables rule could not be removed"
  printf '%s\n' "$out"
  [ "$status" -ne 0 ] || die "ouro sync succeeded while TCP 22 was dropped, so the rule did not stall it"
  if printf '%s' "$out" | grep -qi 'paused'; then die "ouro sync was paused, so the stall proves nothing; remove state/sync-paused and run again"; fi
  # The stall must end the way a stall ends: a timeout or a failed connect, not some other fast failure (M2).
  printf '%s' "$out" | grep -Eqi 'timed out|connect to host' || die "the stalled ouro sync failed without a timeout or a connect failure (exit $status)"
  [ "$elapsed" -le "$STALL_LIMIT_S" ] || die "the stalled ouro sync took ${elapsed}s; it must end within ${STALL_LIMIT_S}s"
  exec_check "$CONTAINER" ps -u "$uid" -o pid=
  leftover=$(tr -d '[:space:]' <"$WORK/exec.out")
  case "$EXEC_STATUS" in
    0) die "ouro-sync processes outlived the stalled sync: $leftover" ;;
    1) [ -z "$leftover" ] || die "ouro-sync processes outlived the stalled sync: $leftover" ;;
    *) die "ps -u $uid exited $EXEC_STATUS, not 0 or 1" ;;
  esac
  say "the stalled sync ended in ${elapsed}s with nothing left running"

  say "ouro sync works again"
  butler_sync
  say "verify-live ok"
}

# ---------- detaching ----------

# Starts this script again for $1 in a new session with all output in a new log, then follows that log and exits with
# the detached run's status. Losing this process (Ctrl-C, a closed terminal, a dropped ssh session) never stops the run.
run_detached() {
  local mode=$1 log
  [ -d "$BACKUP" ] || die "$BACKUP is missing"
  log=$BACKUP/cutover-$(date -u +%Y%m%dT%H%M%SZ)-$$.log
  (set -C; umask 077; : >"$log") || die "could not create $log"
  OURO_CUTOVER_DETACHED=$log setsid -f bash "$0" "$mode" </dev/null >>"$log" 2>&1 || die "could not start the detached run"
  say "running detached; its log is $log"
  follow_log "$log"
}

follow_log() {
  local log=$1 printed=0 size pid="" waited=0
  trap 'say ""; say "stopped following. The run continues detached; its log is $log"; exit 130' INT TERM HUP
  while :; do
    size=$(wc -c <"$log" | tr -d ' ')
    if [ "$size" -gt "$printed" ]; then
      tail -c +"$((printed + 1))" "$log" | head -c "$((size - printed))" || true
      printed=$size
    fi
    if [ -f "$log.status" ]; then
      size=$(wc -c <"$log" | tr -d ' ')
      [ "$size" -le "$printed" ] || tail -c +"$((printed + 1))" "$log"
      exit "$(cat "$log.status")"
    fi
    [ -n "$pid" ] || pid=$(cat "$log.pid" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && [ ! -f "$log.status" ]; then
      tail -c +"$((printed + 1))" "$log"
      say "THE DETACHED RUN (pid $pid) ENDED WITHOUT A STATUS. Read $log; if the Butler is not back, run --rollback."
      exit 1
    fi
    if [ -z "$pid" ]; then
      waited=$((waited + 1))
      [ "$waited" -lt 100 ] || { say "the detached run never started; see $log"; exit 1; }
    fi
    sleep 0.2
  done
}

# ---------- main ----------

MODE=dry-run
MODE_ARG=${1:-}
case "$MODE_ARG" in
  "" | --dry-run) MODE=dry-run ;;
  --apply) MODE=apply ;;
  --rollback) MODE=rollback ;;
  --verify-live) MODE=verify-live ;;
  *) die "usage: sanctuary-sync-cutover.sh [--dry-run|--apply|--rollback|--verify-live]" ;;
esac
[ "$#" -le 1 ] || die "usage: sanctuary-sync-cutover.sh [--dry-run|--apply|--rollback|--verify-live]"
if [ -z "$TEST_ROOT" ] && [ "$(id -u)" -ne 0 ]; then die "run this as root on the host"; fi

if [ -z "$DETACHED_LOG" ] && { [ "$MODE" = apply ] || [ "$MODE" = rollback ]; }; then
  # The detached run starts this file again, so it must be one (not `bash -s` reading stdin).
  { [ -f "$0" ] && [ -r "$0" ]; } || die "run this script from a file, not stdin"
  if [ "$MODE" = rollback ] && nothing_to_roll_back; then say "nothing to roll back: no cutover marker and no .git in the bundle"; exit 0; fi
  run_detached "$MODE_ARG"
fi

if [ -n "$DETACHED_LOG" ]; then
  # A detached run outlives its terminal: HUP is ignored, as under nohup. INT and TERM end an apply into its rollback.
  trap '' HUP
  printf '%s\n' "$$" >"$DETACHED_LOG.pid"
fi
exec 5>&1 6>&2
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sanctuary-sync-cutover.XXXXXX")
trap on_exit EXIT
trap 'trap "" INT TERM HUP; exit 130' INT TERM

case "$MODE" in
  dry-run) preflight ;;
  apply) apply ;;
  rollback)
    trap '' INT TERM HUP PIPE
    rollback
    ;;
  verify-live) verify_live ;;
esac
