# Credit gateway runbook

The credit gateway lets the Butler run on the API credits of several Claude Max plans through one key. Agents present a single master key; the gateway holds the real Anthropic API keys and spends them in a fixed order: it uses the first key until the API says that key's credit balance is too low, then the second, then the third. It never spreads load across keys.

It runs from the same image as the Butler (no separate image), as a second container named `ouro-credit-gateway`. Both containers use host networking, so the gateway listens on `127.0.0.1:8787` and the Butler reaches it at `http://127.0.0.1:8787`. Nothing is published to the network.

## How it behaves

- `master.key` in the keys folder is the key clients must send, as `x-api-key` or `Authorization: Bearer`. A wrong or missing key gets HTTP 401 `invalid x-api-key`.
- Every other `*.key` file is an upstream Anthropic API key. The gateway uses them in file-name order (`acct1.key`, `acct2.key`, `acct3.key`). The label in logs and health is the file name without `.key`. Key contents are never logged.
- The gateway reads the keys once at start. Restart the container after changing a key file.
- When the API answers HTTP 400, 402 or 403 with "credit balance is too low", the gateway skips that key for the cooldown (60 minutes by default), logs `gateway: <label> out of credits; moving on`, and retries the same request with the next key. After the cooldown it tries the key again, which is how a key comes back once its org's credits refresh. A rejected credit check is not billed.
- The skip list is saved in `gateway-state.json` in the keys folder (mode 0600), so a restart remembers it. Delete that file to retry every key at once.
- When every key is out of credits, clients get HTTP 400 with the API's last credit-balance error.
- If the API cannot be reached, clients get HTTP 502 and the gateway does not move to the next key.
- Every request logs one line: `gateway: <label> <method> <path> <status> <ms>ms`. Read them with `docker logs ouro-credit-gateway`.

## One-time setup (as root on the Unraid host)

1. Create the keys folder, owned by the image's user (UID/GID 10001) and closed to everyone else:

   ```sh
   install -d -o 10001 -g 10001 -m 0700 /mnt/user/appdata/credit-gateway /mnt/user/appdata/credit-gateway/keys
   ```

2. Put one upstream API key per account in the folder, one key per file, each file mode 0600. Copy the key files in rather than pasting keys on the command line, so they stay out of shell history:

   ```sh
   cd /mnt/user/appdata/credit-gateway/keys
   install -o 10001 -g 10001 -m 0600 /path/to/acct1.key acct1.key
   install -o 10001 -g 10001 -m 0600 /path/to/acct2.key acct2.key
   install -o 10001 -g 10001 -m 0600 /path/to/acct3.key acct3.key
   ```

3. Generate the master key:

   ```sh
   cd /mnt/user/appdata/credit-gateway/keys
   (umask 077; printf 'ouro-gw-%s\n' "$(openssl rand -hex 32)" > master.key)
   chown 10001:10001 master.key
   ```

4. Check the result. Every file should be `-rw------- 10001 10001`:

   ```sh
   ls -ln /mnt/user/appdata/credit-gateway/keys
   ```

The folder must stay writable by UID 10001, because the gateway saves `gateway-state.json` there.

## Run the gateway

Use the same image tag the Butler runs (the `<Repository>` in `sanctuary.xml`). The image's entrypoint starts the agent daemon, so override it with `--entrypoint node`. The image's built-in health check probes the agent, so replace it with a check of the gateway's own health URL:

```sh
docker run -d --name ouro-credit-gateway \
  --network host \
  --restart unless-stopped \
  --entrypoint node \
  -v /mnt/user/appdata/credit-gateway/keys:/keys \
  --health-cmd 'curl -fsS http://127.0.0.1:8787/health || exit 1' \
  --health-interval 30s --health-timeout 5s --health-retries 3 \
  ghcr.io/ourostack/ouroboros-butler:<same tag as ouro-butler> \
  /opt/ouro/dist/heart/daemon/ouro-entry.js gateway serve --keys-dir /keys --host 127.0.0.1 --port 8787
```

Port 8787 is also the default port of Readarr and its forks (such as Bookshelf). If `ss -ltn | grep 8787` shows it in use, pick a free port (for example 8788) and use it in `--port`, the health check and the Butler's `--base-url`.

Optional flags after `gateway serve`: `--cooldown-minutes <n>` (default 60), `--state <path>` (default `<keys-dir>/gateway-state.json`), `--upstream <url>` (default `https://api.anthropic.com`).

## Check it

```sh
docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' ouro-credit-gateway
curl -fsS http://127.0.0.1:8787/health
docker logs --tail 20 ouro-credit-gateway
```

`/health` needs no key and returns, for example, `{"ok":true,"keys":[{"label":"acct1","available":true},{"label":"acct2","available":false,"skipUntil":"2026-11-01T10:00:00.000Z"},{"label":"acct3","available":true}]}`.

## Point the Butler at it

Store the master key and the gateway URL as the Butler's Anthropic credentials (API-key mode). The key is read from a file or standard input, never from the command line:

```sh
docker exec -i -u 10001 ouro-butler node /opt/ouro/dist/heart/daemon/ouro-entry.js \
  auth --agent sanctuary --provider anthropic --api-key-file /dev/stdin --base-url http://127.0.0.1:8787 \
  < /mnt/user/appdata/credit-gateway/keys/master.key
```

Then select an Anthropic model for the Butler's lanes with `ouro use`. In API-key mode the agent sends a plain API key, with no Claude Code identity headers, no Claude Code system preamble and no token refresh.

## Change or rotate keys

Replace the file (keep owner 10001 and mode 0600), then `docker restart ouro-credit-gateway`. After rotating `master.key`, run the `auth` step above again so the Butler sends the new master key.
