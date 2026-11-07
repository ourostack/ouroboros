#!/bin/bash
# Moves the Butler's bundle from the hourly host backup onto bundle sync. Runs as root on the Unraid host.
#
#   sanctuary-sync-cutover.sh [--dry-run]   read the before-state, print it and save it to bundle-backup/cutover-before.txt (the default)
#   sanctuary-sync-cutover.sh --apply       cut over; any failure rolls back to the saved before-state
#   sanctuary-sync-cutover.sh --rollback    put the hourly backup back, from cutover-before.txt
#   sanctuary-sync-cutover.sh --verify-live after --apply: the sync path reaches GitHub, the key stays unreadable, a stalled fetch ends
#
# Every git call names its repository and work tree (`git --git-dir=... --work-tree=...`), so git never discovers the
# repository and never refuses it for dubious ownership after the move or the chown. Root's git calls also run no hooks
# and no fsmonitor, and `git status` takes no optional locks, so root never rewrites the index behind the Butler.
set -Eeuo pipefail
umask 022

# The bundle's GitHub repository. It is renamed to butler.ouro at R4.
BUNDLE_REPO_OWNER=arimendelow
BUNDLE_REPO_NAME=sanctuary.ouro
BUNDLE_REMOTE="git@github.com:${BUNDLE_REPO_OWNER}/${BUNDLE_REPO_NAME}.git"
BUNDLE_BRANCH=main
AGENT_NAME=sanctuary

CONTAINER=ouro-butler
CONTAINER_BUNDLE=/home/ouro/AgentBundles/sanctuary.ouro
CLI_ENTRY=/opt/ouro/dist/heart/daemon/ouro-entry.js
SYNC_SSH_WRAPPER=/usr/local/libexec/ouro-sync-ssh
CONTAINER_KEY=/run/ouro-sync/deploy_key
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
LOCK_FILE=$BACKUP/lock
BEFORE=$BACKUP/cutover-before.txt
MARKER=$BACKUP/cutover-done
CRON_DISABLED=$BACKUP/sanctuary-bundle-backup.cron.disabled
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

# Paths sync must never commit, besides what the exclude list covers. Pinned to SANCTUARY_PACKAGE_MANAGED_FILES by a test.
PACKAGE_MANAGED_FILES="provider-readiness.json tool-profiles.json mcp/media-mcp.mjs habits/sanctuary-health.md awaiting/house-care-sweep.md product/PRODUCT.md bundle-meta.json"
SECRET_NAME_PATTERN='credential|secret|token|\.key$|\.pem$|(^|/)\.env($|\.)'

say() { printf '%s\n' "$*"; }
die() { printf 'cutover: %s\n' "$*" >&2; exit 1; }

# Git on the backup repository (before step 5) and on the bundle's own .git (from step 5).
backup_git() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false --git-dir="$BACKUP_GIT" --work-tree="$BUNDLE" "$@"; }
bundle_git() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false --git-dir="$BUNDLE/.git" --work-tree="$BUNDLE" "$@"; }
BACKUP_SSH="ssh -i $BACKUP_KEY -o IdentitiesOnly=yes -o BatchMode=yes"

# A config value, or "(unset)".
config_value() {
  local gitfn=$1 key=$2 value
  if value=$("$gitfn" config --get "$key"); then printf '%s' "$value"; else printf '(unset)'; fi
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

# One saved value from cutover-before.txt.
before_value() {
  awk -v k="$1: " 'index($0, k) == 1 { print substr($0, length(k) + 1); found = 1; exit } END { exit found ? 0 : 1 }' "$BEFORE" \
    || die "cutover-before.txt has no \"$1\" line"
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

# Milliseconds for git status and git add -A --dry-run, inside the release image as the Butler's uid, on the live bundle.
measure_git() {
  local image=$1 exclude=$2
  docker run --rm --pull=never --network none --user 10001:10001 --entrypoint sh \
    --mount "type=bind,src=$BACKUP_GIT,dst=/cutover/repo.git,readonly" \
    --mount "type=bind,src=$BUNDLE,dst=$CONTAINER_BUNDLE,readonly" \
    --mount "type=bind,src=$exclude,dst=/cutover/exclude,readonly" \
    "$image" -c '
      w=$1
      g() { git -c safe.directory="*" -c core.fsmonitor=false -c core.excludesFile=/cutover/exclude --git-dir=/cutover/repo.git --work-tree="$w" "$@"; }
      a=$(date +%s%N); GIT_OPTIONAL_LOCKS=0 g status --porcelain >/dev/null || exit 1
      b=$(date +%s%N); g add -A --dry-run >/dev/null || exit 1
      c=$(date +%s%N); echo "$(( (b - a) / 1000000 )) $(( (c - b) / 1000000 ))"' sh "$CONTAINER_BUNDLE"
}

# Paths in the tracked list ($1, one per line) that look like secrets.
secret_paths() { grep -Ei "$SECRET_NAME_PATTERN" "$1" || true; }

# Status lines naming a package-managed or secret path. Prints them; empty means clean.
dirty_status_paths() {
  local status=$1 file
  for file in $PACKAGE_MANAGED_FILES; do
    awk -v f="$file" 'substr($0, 4) == f' "$status"
  done
  cut -c4- "$status" | grep -Ei "$SECRET_NAME_PATTERN" || true
}

# ---------- dry run ----------

# Reads the before-state, prints it and saves it. Changes nothing else. Leaves the exclude list in $WORK/exclude.
preflight() {
  [ -d "$BACKUP_GIT" ] || die "$BACKUP_GIT is missing"
  [ -d "$BUNDLE" ] || die "$BUNDLE is missing"
  [ ! -e "$BUNDLE/.git" ] || die "$BUNDLE/.git already exists"
  [ ! -e "$MARKER" ] || die "the cutover is already done ($MARKER)"
  [ -f "$CRON_FILE" ] || die "the backup cron file $CRON_FILE is missing"
  [ -f "$BACKUP_KEY" ] || die "the backup deploy key $BACKUP_KEY is missing"
  local image branch upstream remote merge stash tracked timings status_ms add_ms excluded secrets out
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
  tracked=$WORK/tracked
  backup_git ls-files >"$tracked"
  excluded=$(backup_git ls-files -ci --exclude-per-directory=.gitignore --exclude-from="$WORK/exclude")
  secrets=$(secret_paths "$tracked")
  out=$WORK/before
  {
    say "# Bundle sync cutover: the before-state, read $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    say "origin.url: $(config_value backup_git remote.origin.url)"
    say "target.url: $BUNDLE_REMOTE"
    say "image: $image"
    say "branch: $branch"
    say "upstream: $upstream"
    say "branch.remote: $remote"
    say "branch.merge: $merge"
    say "core.bare: $(config_value backup_git core.bare)"
    say "core.worktree: $(config_value backup_git core.worktree)"
    say "core.sshCommand: $(config_value backup_git core.sshCommand)"
    say "core.untrackedCache: $(config_value backup_git core.untrackedCache)"
    say "feature.manyFiles: $(config_value backup_git feature.manyFiles)"
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
  mv -f -- "$out" "$BEFORE"
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

# Undoes every step up to $1 (15 for a full rollback), from cutover-before.txt. Keeps going past a failure and reports it.
rollback_from() {
  local reached=$1 failed=0 branch
  set +e
  say "rolling back from step $reached" >&2
  step_try() { "$@" || { failed=1; say "rollback: failed: $*" >&2; }; }
  # Apply stopped the container at step 1 and starts it only at step 15.
  if [ "$reached" -ge 15 ]; then step_try docker stop "$CONTAINER" >/dev/null; fi
  if [ "$reached" -ge 12 ]; then step_try set_sync_enabled false; fi
  if [ "$reached" -ge 5 ] && [ -d "$BUNDLE/.git" ] && [ ! -e "$BACKUP_GIT" ]; then step_try mv -- "$BUNDLE/.git" "$BACKUP_GIT"; fi
  if [ "$reached" -ge 5 ] && [ -d "$BACKUP_GIT" ]; then
    step_try restore_backup_repo
    step_try chown -R -h "$ROOT_OWNER" "$BACKUP_GIT"
  fi
  if [ "$reached" -ge 11 ] && [ "${SYNC_KEY_CREATED:-0}" = 1 ]; then step_try rm -f -- "$SYNC_KEY"; fi
  if [ "$reached" -ge 2 ] && [ -f "$CRON_DISABLED" ] && [ ! -e "$CRON_FILE" ]; then
    step_try mv -- "$CRON_DISABLED" "$CRON_FILE"
    step_try update_cron
  fi
  if [ "$reached" -ge 14 ]; then step_try rm -f -- "$MARKER"; fi
  if [ "$reached" -ge 1 ]; then step_try docker start "$CONTAINER" >/dev/null; fi
  set -e
  if [ "$failed" -ne 0 ]; then say "rollback finished with failures; see above" >&2; return 1; fi
  say "rolled back: the hourly backup owns the bundle again; commits already pushed stay on GitHub" >&2
}

# Puts back the backup repository's config, branch and exclude from cutover-before.txt.
restore_backup_repo() {
  local branch key value encoded
  branch=$(before_value branch) || return 1
  if [ "$branch" != "$BUNDLE_BRANCH" ] && backup_git rev-parse --verify -q "refs/heads/$BUNDLE_BRANCH" >/dev/null; then
    [ "$(backup_git symbolic-ref --short HEAD)" = "$BUNDLE_BRANCH" ] && backup_git branch -M "$BUNDLE_BRANCH" "$branch"
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
    printf '%s' "$encoded" | base64 -d >"$BACKUP_GIT/info/exclude.restore" || return 1
    mv -f -- "$BACKUP_GIT/info/exclude.restore" "$BACKUP_GIT/info/exclude"
  fi
}

# Sets agent.json's sync.enabled (and the branch), through a temp file and a rename, keeping its owner and mode.
set_sync_enabled() {
  "$HOST_NODE" -e '
    const fs = require("node:fs"), path = require("node:path");
    const [file, enabled, branch] = process.argv.slice(1);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(file + " is not a regular file");
    const agent = JSON.parse(fs.readFileSync(fd, "utf8"));
    fs.closeSync(fd);
    const sync = agent.sync && typeof agent.sync === "object" ? agent.sync : {};
    agent.sync = { ...sync, enabled: enabled === "true", branch: sync.branch ?? branch };
    const temp = path.join(path.dirname(file), ".agent.json.cutover-" + process.pid);
    const out = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(out, JSON.stringify(agent, null, 2) + "\n");
      fs.fchownSync(out, stat.uid, stat.gid);
      fs.fchmodSync(out, stat.mode & 0o7777);
      fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    fs.renameSync(temp, file);
  ' "$BUNDLE/agent.json" "$1" "$BUNDLE_BRANCH"
}

# ---------- apply ----------

STEP=0
APPLIED=0
SYNC_KEY_CREATED=0
IPTABLES_RULE=""
# The one EXIT trap: an apply that did not finish rolls back from the step it reached; the iptables rule and the
# work directory never outlive the script.
on_exit() {
  local status=$?
  if [ "$MODE" = apply ] && [ "$APPLIED" -ne 1 ] && [ "$STEP" -gt 0 ]; then
    say "cutover failed at step $STEP (exit $status); rolling back" >&2
    rollback_from "$STEP" || true
    status=1
  fi
  remove_drop_rule
  [ -z "${WORK:-}" ] || rm -rf -- "$WORK"
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
  local image head remote_head untrack status
  image=$(before_value image)

  STEP=1; say "1. stopping $CONTAINER"
  docker stop "$CONTAINER" >/dev/null

  STEP=2; say "2. disabling the hourly backup cron"
  mv -- "$CRON_FILE" "$CRON_DISABLED"
  update_cron
  if grep -q 'backup\.sh' "$CRON_TABLE"; then die "$CRON_TABLE still runs backup.sh"; fi

  STEP=3; say "3. taking $LOCK_FILE"
  exec 9>>"$LOCK_FILE"
  flock -w 900 9 || die "the backup lock stayed busy for 15 minutes"

  STEP=4; say "4. the last backup commit and push"
  backup_git add -A
  if ! backup_git diff --cached --quiet; then
    backup_git -c "user.name=$AGENT_NAME" -c "user.email=$AGENT_NAME@ouro.local" commit -q -m "backup: last hourly backup before bundle sync"
  fi
  GIT_SSH_COMMAND=$BACKUP_SSH backup_git push -q origin "HEAD:$BUNDLE_BRANCH"

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
    GIT_SSH_COMMAND=$BACKUP_SSH bundle_git push -q origin "HEAD:$BUNDLE_BRANCH"
  fi
  bundle_git config core.untrackedCache true
  bundle_git config feature.manyFiles true

  STEP=10; say "10. checking nothing excluded is tracked"
  [ -z "$(bundle_git ls-files -ci --exclude-standard)" ] || die "excluded files are still tracked"
  status=$WORK/status
  GIT_OPTIONAL_LOCKS=0 bundle_git status --porcelain >"$status"
  [ -z "$(dirty_status_paths "$status")" ] || die "git status shows package-managed or secret paths: $(dirty_status_paths "$status" | tr '\n' ' ')"

  STEP=11; say "11. installing the sync key for ouro-sync"
  [ ! -L "$SYNC_DIR" ] || die "$SYNC_DIR is a symlink"
  [ -e "$SYNC_KEY" ] || SYNC_KEY_CREATED=1
  mkdir -p -- "$SYNC_DIR"
  chown -h "$ROOT_OWNER" "$SYNC_DIR"
  chmod 0755 "$SYNC_DIR"
  rm -f -- "$SYNC_DIR/.deploy_key.cutover"
  cp -- "$BACKUP_KEY" "$SYNC_DIR/.deploy_key.cutover"
  chown "$SYNC_OWNER" "$SYNC_DIR/.deploy_key.cutover"
  chmod 0400 "$SYNC_DIR/.deploy_key.cutover"
  mv -f -- "$SYNC_DIR/.deploy_key.cutover" "$SYNC_KEY"
  assert_sync_key

  STEP=12; say "12. turning sync on in agent.json"
  set_sync_enabled true

  STEP=13; say "13. handing .git to the Butler"
  chown -R -h "$BUTLER_OWNER" "$BUNDLE/.git"
  assert_owned_by_butler

  STEP=14; say "14. writing $MARKER"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"

  STEP=15; say "15. starting $CONTAINER"
  docker start "$CONTAINER" >/dev/null
  say "13b. auditing the started container with sync on"
  audit_started_container "$image" >/dev/null
  if docker exec -u 10001 "$CONTAINER" test -r "$CONTAINER_KEY"; then die "the Butler's uid can read $CONTAINER_KEY"; fi

  APPLIED=1
  say "cutover done. Run --verify-live next."
}

# ---------- verify live ----------

remove_drop_rule() {
  if [ -n "$IPTABLES_RULE" ]; then
    # shellcheck disable=SC2086
    iptables -D $IPTABLES_RULE || say "verify: could not remove the iptables rule: iptables -D $IPTABLES_RULE" >&2
    IPTABLES_RULE=""
  fi
}

container_ip() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$CONTAINER" | awk '{ print $1 }'
}

butler_sync() { docker exec -u 10001 "$CONTAINER" timeout 60 node "$CLI_ENTRY" sync --agent "$AGENT_NAME"; }

verify_live() {
  [ -e "$MARKER" ] || die "the cutover is not done ($MARKER is missing)"
  local heads ip start elapsed status leftover

  say "the sync path reaches GitHub as ouro-sync"
  heads=$(docker exec -u 10001 -e "GIT_SSH_COMMAND=sudo -n -u ouro-sync $SYNC_SSH_WRAPPER" -e GIT_SSH_VARIANT=ssh "$CONTAINER" \
    git ls-remote "$BUNDLE_REMOTE" "refs/heads/$BUNDLE_BRANCH")
  [ -n "$heads" ] || die "git ls-remote through $SYNC_SSH_WRAPPER returned no $BUNDLE_BRANCH"

  say "the Butler's uid cannot read the key"
  if docker exec -u 10001 "$CONTAINER" cat "$CONTAINER_KEY" >/dev/null 2>&1; then die "the Butler's uid can read $CONTAINER_KEY"; fi
  if docker exec -u 10001 "$CONTAINER" test -r "$CONTAINER_KEY"; then die "the Butler's uid can read $CONTAINER_KEY"; fi

  say "a stalled fetch ends on its own"
  ip=$(container_ip)
  [ -n "$ip" ] || die "the container has no IP address to scope the iptables rule to"
  IPTABLES_RULE="FORWARD -s $ip -p tcp --dport 22 -j DROP"
  # shellcheck disable=SC2086
  iptables -I $IPTABLES_RULE
  start=$(date +%s)
  if butler_sync; then status=0; else status=$?; fi
  elapsed=$(( $(date +%s) - start ))
  remove_drop_rule
  [ "$status" -ne 0 ] || die "ouro sync succeeded while TCP 22 was dropped, so the rule did not stall it"
  [ "$elapsed" -le "$STALL_LIMIT_S" ] || die "the stalled ouro sync took ${elapsed}s; it must end within ${STALL_LIMIT_S}s"
  leftover=$(docker exec "$CONTAINER" ps -u 10002 -o pid= || true)
  [ -z "$leftover" ] || die "ouro-sync processes outlived the stalled sync: $leftover"
  say "the stalled sync ended in ${elapsed}s with nothing left running"

  say "ouro sync works again"
  butler_sync
  say "verify-live ok"
}

# ---------- main ----------

MODE=dry-run
case "${1:-}" in
  "" | --dry-run) MODE=dry-run ;;
  --apply) MODE=apply ;;
  --rollback) MODE=rollback ;;
  --verify-live) MODE=verify-live ;;
  *) die "usage: sanctuary-sync-cutover.sh [--dry-run|--apply|--rollback|--verify-live]" ;;
esac
[ "$#" -le 1 ] || die "usage: sanctuary-sync-cutover.sh [--dry-run|--apply|--rollback|--verify-live]"
if [ -z "$TEST_ROOT" ] && [ "$(id -u)" -ne 0 ]; then die "run this as root on the host"; fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sanctuary-sync-cutover.XXXXXX")
trap on_exit EXIT
trap 'exit 130' INT TERM

case "$MODE" in
  dry-run) preflight ;;
  apply) apply ;;
  rollback)
    [ -f "$BEFORE" ] || die "$BEFORE is missing, so there is no before-state to restore"
    exec 9>>"$LOCK_FILE"
    flock -w 900 9 || die "the backup lock stayed busy for 15 minutes"
    rollback_from 15
    ;;
  verify-live) verify_live ;;
esac
