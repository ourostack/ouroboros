#!/bin/bash
# Ouro Butler installer for Unraid 7.2 or newer.
#
# Run it as root in the Unraid web terminal. Download it and read it first if you like:
#   curl -fsSLo /tmp/ouro-butler-install.sh https://github.com/ourostack/ouroboros/releases/latest/download/install.sh
#   bash /tmp/ouro-butler-install.sh
#
# What it does, in order (each step says what it is doing as it goes):
#   1. checks this is Unraid 7.2+, as root, with Docker running and no Butler installed yet
#   2. asks for your name, the Butler's name, a vault email, your Anthropic API key and your Telegram bot token
#      (secrets are read with the terminal's echo off and never appear in a command line)
#   3. pulls the Butler image and seeds the Butler's files under /mnt/user/appdata/ouro-butler
#   4. creates the Butler's vault (you choose its unlock phrase) and stores the Anthropic key in it
#   5. creates two Unraid API keys for the Butler (read-only, and read plus Docker update) and stores them in the vault
#   6. finds your Telegram user id when you message the bot, then installs the root authority that holds the bot
#      token and starts the Butler
#
# Options:
#   --version <0.1.0-alpha.N>   install this release instead of the newest one
#   --vault-server <url>        use your own Vaultwarden-compatible server instead of https://vault.ouro.bot
#   --help                      print this header
set -euo pipefail
umask 077

IMAGE_REPO=ghcr.io/ourostack/ouroboros-butler
APPDATA=/mnt/user/appdata/ouro-butler
RUNTIME=$APPDATA/runtime/.ouro-cli
BUNDLE=$APPDATA/agent/sanctuary.ouro
STAGE=$APPDATA/installer
AUTHORITY=/mnt/user/appdata/ouro-authority
EVENTS=/boot/config/custom/ouro-events
CONTAINER=ouro-butler
AGENT=sanctuary
TTY=/dev/tty
VERSION=""
VAULT_SERVER=""

say() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

ask() { # ask <variable> <prompt> [default]
  local answer
  printf '%s%s: ' "$2" "${3:+ [$3]}" > "$TTY"
  IFS= read -r answer < "$TTY" || die "no answer read from the terminal"
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

ask_secret() { # ask_secret <variable> <prompt>
  local answer saved
  saved=$(stty -g < "$TTY")
  printf '%s (input is hidden): ' "$2" > "$TTY"
  stty -echo < "$TTY"
  IFS= read -r answer < "$TTY" || { stty "$saved" < "$TTY"; die "no answer read from the terminal"; }
  stty "$saved" < "$TTY"
  printf '\n' > "$TTY"
  printf -v "$1" '%s' "$answer"
}

confirm() { local reply; ask reply "$1 (y/n)" n; case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac; }

while (($# > 0)); do
  case "$1" in
    --version) VERSION="${2:?--version needs a value, for example 0.1.0-alpha.970}"; shift 2 ;;
    --vault-server) VAULT_SERVER="${2:?--vault-server needs a URL}"; shift 2 ;;
    --help|-h) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# The ouro CLI from the Butler image, run against the Butler's own files as the Butler's user.
ouro() {
  docker run --rm --pull=never --network host --user 10001:10001 \
    --mount "type=bind,src=$RUNTIME,dst=/home/ouro/.ouro-cli" \
    --mount "type=bind,src=$BUNDLE,dst=/home/ouro/AgentBundles/$AGENT.ouro" \
    --entrypoint node "$IMAGE" /opt/ouro/dist/heart/daemon/ouro-entry.js "$@"
}
ouro_stdin() {
  docker run --rm -i --pull=never --network host --user 10001:10001 \
    --mount "type=bind,src=$RUNTIME,dst=/home/ouro/.ouro-cli" \
    --mount "type=bind,src=$BUNDLE,dst=/home/ouro/AgentBundles/$AGENT.ouro" \
    --entrypoint node "$IMAGE" /opt/ouro/dist/heart/daemon/ouro-entry.js "$@"
}
ouro_interactive() {
  docker run --rm -it --pull=never --network host --user 10001:10001 \
    --mount "type=bind,src=$RUNTIME,dst=/home/ouro/.ouro-cli" \
    --mount "type=bind,src=$BUNDLE,dst=/home/ouro/AgentBundles/$AGENT.ouro" \
    --entrypoint node "$IMAGE" /opt/ouro/dist/heart/daemon/ouro-entry.js "$@" < "$TTY"
}

# Write a private file owned by the Butler's user from stdin.
write_butler_file() {
  local path=$1
  cat > "$path.tmp.$$"
  chown 10001:10001 "$path.tmp.$$"
  chmod 0600 "$path.tmp.$$"
  mv -f "$path.tmp.$$" "$path"
}

# ---------------------------------------------------------------------------------------------------------------
say "1. checking this host"
test "$(id -u)" = 0 || die "run this as root (the Unraid web terminal is root)"
test -r "$TTY" || die "this installer needs a terminal for its questions; run it in the Unraid web terminal"
test -r /etc/unraid-version || die "this is not Unraid (no /etc/unraid-version)"
UNRAID_VERSION=$(sed -n 's/^version="\([0-9.]*\).*/\1/p' /etc/unraid-version)
IFS=. read -r UNRAID_MAJOR UNRAID_MINOR _ <<< "$UNRAID_VERSION"
if ((UNRAID_MAJOR < 7 || (UNRAID_MAJOR == 7 && UNRAID_MINOR < 2))); then die "Unraid $UNRAID_VERSION is too old; the Butler needs Unraid 7.2 or newer"; fi
ok "Unraid $UNRAID_VERSION"
command -v node >/dev/null || die "node is missing (Unraid 7.2 ships it at /usr/local/bin/node)"
command -v unraid-api >/dev/null || die "unraid-api is missing (Unraid 7.2 ships it)"
docker info >/dev/null 2>&1 || die "Docker is not running; start it in Settings > Docker"
ok "node, unraid-api and Docker are available"
! docker container inspect "$CONTAINER" >/dev/null 2>&1 || die "an $CONTAINER container already exists; this installer is for a first install (upgrades use the Butler's own upgrade path)"
test ! -e "$AUTHORITY/active.json" || die "a Butler authority is already installed on this host"
ok "no Butler installed yet"

if test -z "$VERSION"; then
  VERSION=$(node -e 'fetch("https://registry.npmjs.org/-/package/@ouro.bot/cli/dist-tags").then(r => r.json()).then(t => process.stdout.write(t.latest)).catch(() => process.exit(1))') \
    || die "could not look up the newest Butler release; pass --version"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || die "version $VERSION does not look like a release version"
IMAGE=$IMAGE_REPO:$VERSION
ok "installing Ouro Butler $VERSION"

# ---------------------------------------------------------------------------------------------------------------
say "2. a few questions"
printf 'The Butler lives on this server and talks to you on Telegram. You can change any name later in\n%s/house/house.json.\n\n' "$BUNDLE" > "$TTY"
ask OWNER_NAME "Your first name" ""
test -n "$OWNER_NAME" || die "a name is needed so the Butler knows who it works for"
ask BUTLER_NAME "What should the Butler call itself" "Butler"
ask HOUSEHOLD_NAME "A name for this household or server" "$(hostname)"
printf '\nThe Butler keeps its secrets in a Bitwarden-compatible vault. It gets its own vault account, so use an\nemail address no other Butler uses (for example you+butler@example.com). No mail is sent to it.\n' > "$TTY"
ask VAULT_EMAIL "Vault account email" ""
[[ "$VAULT_EMAIL" == *@*.* ]] || die "that does not look like an email address"
printf '\nThe Butler thinks with Anthropic models. Create an API key at https://console.anthropic.com/settings/keys\n' > "$TTY"
ask_secret ANTHROPIC_KEY "Anthropic API key"
[[ "$ANTHROPIC_KEY" == sk-ant-* ]] || die "Anthropic API keys start with sk-ant-"
printf '\nCreate a Telegram bot for the Butler: message @BotFather, send /newbot, and copy the token it gives you.\n' > "$TTY"
ask_secret BOT_TOKEN "Telegram bot token"
[[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "that does not look like a Telegram bot token (digits, a colon, then letters)"
BOT_INFO=$(TOKEN="$BOT_TOKEN" node -e '
  fetch(`https://api.telegram.org/bot${process.env.TOKEN}/getMe`).then(r => r.json()).then(b => {
    if (!b.ok) process.exit(2)
    process.stdout.write(`${b.result.id}\t${b.result.username}`)
  }).catch(() => process.exit(1))') || die "Telegram did not accept that bot token"
BOT_USERNAME=${BOT_INFO#*$'\t'}
ok "Telegram knows the bot @$BOT_USERNAME"

# ---------------------------------------------------------------------------------------------------------------
say "3. Butler image and files"
docker pull "$IMAGE" >/dev/null || die "could not pull $IMAGE"
ok "pulled $IMAGE"
install -d -m 0700 -o 10001 -g 10001 "$APPDATA" "$APPDATA/runtime" "$APPDATA/agent" "$RUNTIME" "$BUNDLE"
install -d -m 0700 -o 0 -g 0 "$AUTHORITY" "$STAGE"
if test ! -f "$RUNTIME/machine.json"; then
  NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  printf '{\n  "schemaVersion": 1,\n  "machineId": "%s",\n  "createdAt": "%s",\n  "updatedAt": "%s",\n  "hostnameAliases": []\n}\n' "$AGENT" "$NOW" "$NOW" | write_butler_file "$RUNTIME/machine.json"
fi
if test ! -f "$BUNDLE/agent.json"; then
  test -z "$(find "$BUNDLE" -mindepth 1 -print -quit)" || die "$BUNDLE has files but no agent.json; move it aside and run the installer again"
  docker run --rm --pull=never --network=none --user 10001:10001 \
    --mount "type=bind,src=$BUNDLE,dst=/home/ouro/AgentBundles/$AGENT.ouro" \
    --entrypoint /bin/sh "$IMAGE" -ceu '
      cp -R /opt/ouro/deploy/unraid/sanctuary.ouro/. /home/ouro/AgentBundles/sanctuary.ouro/
      find /home/ouro/AgentBundles/sanctuary.ouro -type d -exec chmod 0700 {} +
      find /home/ouro/AgentBundles/sanctuary.ouro -type f -exec chmod 0600 {} +'
fi
ok "Butler files seeded in $BUNDLE"
install -d -m 0700 -o 10001 -g 10001 "$BUNDLE/house"
OWNER_NAME=$OWNER_NAME BUTLER_NAME=$BUTLER_NAME HOUSEHOLD_NAME=$HOUSEHOLD_NAME node -e '
  const house = { ownerName: process.env.OWNER_NAME, butlerName: process.env.BUTLER_NAME, householdName: process.env.HOUSEHOLD_NAME, publicEndpoints: [], requiredContainers: [] }
  process.stdout.write(`${JSON.stringify(house, null, 2)}\n`)' | write_butler_file "$BUNDLE/house/house.json"
if test ! -f "$BUNDLE/house/HOUSE.md"; then
  printf '# %s\n\n%s owns this Unraid server and is the person %s works for.\n\nAdd anything the Butler should know about this household here: who lives here, what each container is for, what matters most. The Butler reads this file at the start of every conversation.\n' \
    "$HOUSEHOLD_NAME" "$OWNER_NAME" "$BUTLER_NAME" | write_butler_file "$BUNDLE/house/HOUSE.md"
fi
ok "house description written to $BUNDLE/house"

ASSETS=ouro-butler-installer-assets
docker rm -f "$ASSETS" >/dev/null 2>&1 || true
docker create --name "$ASSETS" "$IMAGE" >/dev/null
docker cp "$ASSETS:/opt/ouro/deploy/unraid/sanctuary-butler-upgrade.mjs" "$STAGE/sanctuary-butler-upgrade.mjs" >/dev/null
docker cp "$ASSETS:/opt/ouro/deploy/unraid/ouro-events/bootstrap-spool.sh" "$STAGE/bootstrap-spool.sh" >/dev/null
docker rm -f "$ASSETS" >/dev/null
chown 0:0 "$STAGE"/*; chmod 0700 "$STAGE"/*
bash "$STAGE/bootstrap-spool.sh" --install-only
bash "$EVENTS/bootstrap-spool.sh" --mount
ok "event spool mounted and registered to mount at boot"

# ---------------------------------------------------------------------------------------------------------------
say "4. vault and model provider"
VAULT_STATUS=$(ouro vault status --agent "$AGENT" --store plaintext-file 2>&1 || true)
if [[ "$VAULT_STATUS" != *"local unlock: available"* ]]; then
  printf 'Creating the vault. Choose an unlock phrase and keep it somewhere safe: it is the only way to recover\nthe Butler'"'"'s secrets if this server is lost.\n' > "$TTY"
  ouro_interactive vault create --agent "$AGENT" --email "$VAULT_EMAIL" ${VAULT_SERVER:+--server "$VAULT_SERVER"} --store plaintext-file \
    || die "vault creation did not finish; run the installer again to retry"
fi
ok "vault ready"
printf '%s' "$ANTHROPIC_KEY" | ouro_stdin auth --agent "$AGENT" --provider anthropic --api-key-file /dev/stdin >/dev/null \
  || die "storing the Anthropic key failed"
unset ANTHROPIC_KEY
for LANE in outward inner; do
  ouro check --agent "$AGENT" --lane "$LANE" >/dev/null 2>&1 || die "the $LANE model lane did not answer; check the Anthropic key and your account's credit"
done
ok "Anthropic key stored in the vault; both model lanes answer"

# ---------------------------------------------------------------------------------------------------------------
say "5. Unraid API access"
PORT=$(sed -n 's/^PORT="\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' /boot/config/ident.cfg 2>/dev/null | head -1)
GRAPHQL_URL="http://127.0.0.1${PORT:+$( [ "$PORT" = 80 ] || printf ':%s' "$PORT")}/graphql"
READ_PERMISSIONS="ARRAY:READ_ANY,DASHBOARD:READ_ANY,DISK:READ_ANY,DOCKER:READ_ANY,INFO:READ_ANY,LOGS:READ_ANY,NOTIFICATIONS:READ_ANY,SHARE:READ_ANY,VARS:READ_ANY"
STAMP=$(date +%Y%m%d%H%M%S)
create_unraid_key() { # create_unraid_key <name> <permissions> <vault field>
  unraid-api apikey --create --name "$1" --permissions "$2" --description "Ouro Butler ($3)" --json 2>/dev/null \
    | node -e '
        let text = ""; process.stdin.on("data", (c) => text += c).on("end", () => {
          const start = text.indexOf("{"); if (start < 0) process.exit(1)
          const key = JSON.parse(text.slice(start)).key; if (typeof key !== "string" || !key) process.exit(1)
          process.stdout.write(key) })' \
    | ouro_stdin vault config set --agent "$AGENT" --key "$3" --scope machine --value-file /dev/stdin >/dev/null \
    || die "creating the Unraid API key $1 failed"
}
create_unraid_key "Butler RO $STAMP" "$READ_PERMISSIONS" unraidReadApiKey
create_unraid_key "Butler RW $STAMP" "$READ_PERMISSIONS,DOCKER:UPDATE_ANY" unraidWriteApiKey
ouro vault config set --agent "$AGENT" --key unraidGraphqlUrl --scope machine --value "$GRAPHQL_URL" >/dev/null
ok "API keys \"Butler RO $STAMP\" and \"Butler RW $STAMP\" created (see Settings > Management Access > API Keys)"

# ---------------------------------------------------------------------------------------------------------------
say "6. Telegram and the root authority"
test ! -L "$AUTHORITY/incoming-token" || die "$AUTHORITY/incoming-token is a link; remove it and run again"
printf '%s' "$BOT_TOKEN" > "$AUTHORITY/incoming-token.tmp.$$"
chmod 0600 "$AUTHORITY/incoming-token.tmp.$$"
mv -f "$AUTHORITY/incoming-token.tmp.$$" "$AUTHORITY/incoming-token"
unset BOT_TOKEN
printf '\nOpen Telegram, find @%s and send it any message (for example "hello"). Waiting up to 3 minutes...\n' "$BOT_USERNAME" > "$TTY"
OWNER_INFO=$(node -e '
  const token = require("node:fs").readFileSync(process.argv[1], "utf8").trim()
  const api = (method, query) => fetch(`https://api.telegram.org/bot${token}/${method}?${query}`).then((r) => r.json())
  const deadline = Date.now() + 180000
  ;(async () => {
    while (Date.now() < deadline) {
      const body = await api("getUpdates", "timeout=20&allowed_updates=%5B%22message%22%5D").catch(() => null)
      const updates = body && body.ok ? body.result : []
      const latest = updates.filter((u) => u.message && u.message.chat && u.message.chat.type === "private" && u.message.from).pop()
      if (latest) {
        await api("getUpdates", `offset=${latest.update_id + 1}&timeout=0`).catch(() => null)
        const from = latest.message.from
        process.stdout.write(`${from.id}\t${from.first_name || ""}${from.username ? ` (@${from.username})` : ""}`)
        return
      }
      if (body && body.ok === false) { process.stderr.write(`Telegram: ${body.description}\n`); process.exit(2) }
    }
    process.exit(1)
  })()' "$AUTHORITY/incoming-token") || die "no message reached the bot; run the installer again and message the bot when asked"
OWNER_ID=${OWNER_INFO%%$'\t'*}
confirm "The message came from ${OWNER_INFO#*$'\t'}. Is that you" || die "only the owner should message the bot during install; run the installer again"
ok "owner Telegram id found"

UPGRADE=(node "$STAGE/sanctuary-butler-upgrade.mjs")
"${UPGRADE[@]}" preflight "$VERSION" --fresh || die "preflight found a problem (above); nothing has been installed yet"
"${UPGRADE[@]}" prepare "$VERSION" --fresh --owner-id "$OWNER_ID" || die "prepare found a problem (above)"
LOG=/var/log/ouro-butler-install.log
printf 'Installing the authority and starting the Butler. This runs on even if this terminal closes; its log is %s.\n' "$LOG" > "$TTY"
setsid nohup "${UPGRADE[@]}" install "$VERSION" > "$LOG" 2>&1 < /dev/null &
INSTALL_PID=$!
tail -n +1 --pid="$INSTALL_PID" -f "$LOG"
wait "$INSTALL_PID" || die "install did not complete and was rolled back; the log is $LOG"
"${UPGRADE[@]}" verify || die "the Butler is installed but verify found a problem (above)"

say "done"
printf 'Ouro Butler %s is running. Say hello to @%s on Telegram.\n' "$VERSION" "$BOT_USERNAME"
printf 'Tell it about your household in %s/house/HOUSE.md.\n' "$BUNDLE"
printf 'Keep the vault unlock phrase you chose somewhere safe.\n'
