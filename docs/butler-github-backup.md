# Backing up and editing your Butler with GitHub

Your Butler keeps everything it is in its bundle: its psyche (who it is and what it has learned), its friends, its habits and its notes. Bundle sync keeps that bundle in a private GitHub repository. After you turn it on:

- every change the Butler makes is committed and pushed to GitHub after each turn, so GitHub always holds a backup;
- you can edit the psyche from any computer, push, and the Butler picks up your edit before its next turn.

Without a remote, sync still commits each change locally inside the bundle, so you have history but no off-machine backup.

## What goes to GitHub

Sync commits the bundle except for what its exclude list leaves out. The Butler writes that list to the bundle's `.git/info/exclude` on every start, and `ouro sanctuary git-exclude --print` shows it. It leaves out:

- credentials and keys (`**/credentials.json`, `*.key`, `*.pem`, `.env`, ssh keys);
- runtime state (`state/`, `inbox/`) and caches;
- the files each release installs, which the release replaces anyway.

Before your first push, look at what is tracked (`git ls-files`) and make sure nothing private is in it. The repository should be private.

## Set it up

You need a GitHub account, and shell access to the server that runs the Butler.

1. **Create an empty private repository** on GitHub, for example `<you>/butler.ouro`. Do not add a README; the Butler's history goes in first.
2. **Make a deploy key** for that repository, on the server:

   ```sh
   mkdir -p /mnt/user/appdata/ouro-butler/sync
   ssh-keygen -t ed25519 -N '' -C butler-sync -f /mnt/user/appdata/ouro-butler/sync/deploy_key
   ```

   In the repository's **Settings > Deploy keys**, add the contents of `deploy_key.pub` and tick **Allow write access**. A deploy key opens this one repository and nothing else in your account.
3. **Lock the key down** so only the sync helper can read it. The Butler itself runs as uid 10001 and must not be able to read the key; the container's `ouro-sync` user (uid 10002) pushes for it:

   ```sh
   chown 10002:10002 /mnt/user/appdata/ouro-butler/sync/deploy_key
   chmod 0400 /mnt/user/appdata/ouro-butler/sync/deploy_key
   rm /mnt/user/appdata/ouro-butler/sync/deploy_key.pub
   ```

   The template mounts this folder read-only at `/run/ouro-sync` ("Bundle sync key"). Leave that mapping as it is.
4. **Point the bundle at the repository.** Run git inside the container as the Butler, so the files keep the Butler as owner:

   ```sh
   docker exec -u 10001 ouro-butler git -C /home/ouro/AgentBundles/sanctuary.ouro remote add origin git@github.com:<you>/butler.ouro.git
   ```

   Sync talks only to `git@github.com`, and only to the one repository the remote names.
5. **Turn sync on** in the bundle's `agent.json`:

   ```json
   "sync": { "enabled": true, "branch": "main" }
   ```

6. **Restart the container.**
7. **Push the first time**, and see that it works:

   ```sh
   docker exec -u 10001 ouro-butler node /opt/ouro/dist/heart/daemon/ouro-entry.js sync --agent sanctuary
   ```

   The repository on GitHub now has the bundle. From now on, each turn's changes follow on their own.

## Edit the Butler from your computer

```sh
git clone git@github.com:<you>/butler.ouro.git
cd butler.ouro
# edit psyche/SOUL.md, psyche/TACIT.md and the rest
git commit -am "teach it something"
git push
```

Before each turn the Butler pulls from GitHub, so your edit is live on its next message. Use your own account's ssh key for this clone, not the deploy key.

When you and the Butler change the same thing:

- **In `psyche/`**, your version wins. The Butler merges and keeps your edit.
- **Anywhere else**, the Butler stops the merge, keeps its own commits, and tells you which files clash. If the same clash comes back, it pushes its side to the branch `sync-conflict/<name>`. Merge that branch into `main` yourself, and sync resumes.

## Pausing sync

Sync pauses while `state/sync-paused` exists in the bundle. The file holds JSON with `startedAt` and `expiresAt`, and sync removes it on its own once `expiresAt` passes, so a forgotten pause cannot stop backups for good. A pause lasts at most 24 hours. Remove the file to resume at once.

## Turning it off

Set `"enabled": false` in `agent.json` and restart the container. The bundle keeps its `.git` and its history; nothing more is pushed. You can then remove the deploy key from GitHub and delete `/mnt/user/appdata/ouro-butler/sync/deploy_key`.
