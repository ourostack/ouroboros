# Install Ouro Butler on Unraid

Ouro Butler is an agent that lives on your Unraid server and looks after it with you over Telegram. It answers questions about the array, disks and containers, tells you when something goes wrong, and can update containers when you ask. It is an **alpha**: expect rough edges, and keep your own backups.

## What you need

- Unraid **7.2 or newer**, with Docker enabled and a working internet connection.
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/settings/keys), with credit on the account. The Butler uses Claude models.
- A **Telegram bot** for the Butler: message [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the token it gives you.
- An **email address** for the Butler's vault account. The vault is a Bitwarden-compatible store at `vault.ouro.bot` (or your own server). Use an address no other Butler uses, such as `you+butler@example.com`; nothing is sent to it.
- About 10 minutes at the Unraid web terminal.

## Install

Open the Unraid web terminal (the `>_` icon at the top right), then download the installer, read it if you like, and run it:

```bash
curl -fsSLo /tmp/ouro-butler-install.sh https://github.com/ourostack/ouroboros/releases/latest/download/install.sh
less /tmp/ouro-butler-install.sh   # optional: read it first
bash /tmp/ouro-butler-install.sh
```

The installer asks for your name, the Butler's name, the vault email, the Anthropic key and the bot token. Secrets are read with the terminal's echo off and never appear on a command line. It then:

1. pulls the Butler image `ghcr.io/ourostack/ouroboros-butler` and seeds the Butler's files in `/mnt/user/appdata/ouro-butler`;
2. creates the Butler's vault, asking you to choose an **unlock phrase** (write it down: it is the only way to recover the Butler's secrets if the server is lost), and stores the Anthropic key in it;
3. creates two Unraid API keys for the Butler, `Butler RO …` (read-only) and `Butler RW …` (read-only plus Docker update), and stores them in the vault;
4. asks you to send your bot any message on Telegram, so it learns your Telegram id and answers only you;
5. installs the root authority, a small service that holds the Telegram token outside the Butler's container, and starts the Butler as the `ouro-butler` container.

When it prints `Ouro Butler … is running`, say hello to your bot on Telegram.

To install a specific release instead of the newest one, pass `--version 0.1.0-alpha.N`. To use your own Vaultwarden server, pass `--vault-server https://vault.example.com`.

## Tell it about your home

The Butler reads two files you own and that updates never overwrite:

- `/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/house/house.json`: names (`ownerName`, `butlerName`, `householdName`), `publicEndpoints` it should check (each `{ "name", "url" }`), and `requiredContainers` it should treat as must-run.
- `/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/house/HOUSE.md`: anything else worth knowing, in plain words: who lives here, what each container is for, what matters most.

Edit them as root and keep the owner and mode (`chown 10001:10001`, `chmod 600`). The Butler picks up changes at its next conversation.

## Updates

Releases ship as new images. The Butler's maintainers upgrade with `deploy/unraid/sanctuary-butler-upgrade.mjs upgrade <version>`, which keeps the same Telegram token and rolls back on any failure. A friendlier update command is planned; until then, follow the release notes.

## Known limits of the alpha

- Unraid only, version 7.2 or newer. No docker compose or other hosts yet.
- Anthropic is the supported model provider.
- One owner per Butler; the Butler answers only the Telegram account that messaged it during install.
- Media (Jellyfin) and book integrations are optional extras that are not set up by the installer yet.
- The installer is for a first install. If it stops partway, fix the reported problem and run it again; it reuses the files and vault it already made. If it says a Butler is already installed, it will not touch it.

## Stopping and removing

To pause the Butler, stop the `ouro-butler` container on the Docker tab. To cut it off completely at any time, revoke its access at the source: delete the two `Butler RO …`/`Butler RW …` keys under **Settings → Management Access → API Keys**, revoke the bot token with @BotFather (`/revoke`), and delete the Anthropic key in the Anthropic console.

A one-command uninstall that also removes the root authority's boot hook and files is not in this alpha yet. If you need it before then, open an issue and we will walk you through it.

## Help

Open an issue at [github.com/ourostack/ouroboros](https://github.com/ourostack/ouroboros/issues). Please include the installer's output (it never prints your secrets) and, for install failures, `/var/log/ouro-butler-install.log`.
