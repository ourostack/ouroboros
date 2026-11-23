# Versioning Strategy

This repo has a few different kinds of "version", and they answer different questions.

## 1. Runtime Package Version

Source:

- `package.json`

Example:

- `0.1.0-alpha.36`

This is the version reported by:

- `npx ouro.bot@latest -v`
- `ouro -v`
- `ouro status`

It is the main answer to "what runtime am I running?"

### Release numbering

Pull requests never set the version. The release job on `main` (`publish` in `.github/workflows/coverage.yml`, and `container-publish.yml` for the image) runs `scripts/release-version.cjs`, which works it out from npm and main's history:

- Counting starts at npm's last release: the newest published version whose commit (npm's `gitHead`, or its `v<version>` tag) was on main's first-parent line before this push. Numbers already on npm never change, whatever later edits do to the rules below.
- After it, every first-parent commit that releases something takes the next number in order (`0.1.0-alpha.N`, then `N+1`). A commit releases something when it changes shipped source, scripts, skills, the Unraid deploy files, `package.json`, the lockfiles, `SerpentGuide.ouro/`, `RepairGuide.ouro/`, `assets/` or the `ouro.bot` wrapper, or adds or edits a change note. A commit that changes only docs, tests or workflows, or only removes change notes, publishes nothing.
- Only a commit that moves `package.json`'s version to a new, higher release line (`0.2.0-alpha.0` after `0.1.0-alpha.N`, or `1.0.0`) starts counting again, from that version. Any other version change (an old-style bump, a bump and its drop-bump landing together in a rebase merge, a stale bump back) is an ordinary commit and takes the next number, so no commit can stop the releases after it. The publish job also refuses any version at or below npm's highest unless this commit already published it, and npm itself refuses a number it has. `changes/README.md` must be in the tree, or the release stops.
- A push to `main` publishes once, when any commit it brought releases something, under the number of the newest such commit. A squash merge is one commit, so it takes one number. A rebase merge of several commits publishes one version and skips the numbers of its earlier commits.
- Every changelog entry since this scheme began is rebuilt from main's history on every release; nothing is read from npm's tarballs. A version npm has gets the change notes added by the commits since the release before it, as the commit npm published it from left them, and this push's version gets those since npm's last release: one line per paragraph or bullet, or the commits' subjects when none of them added a note. The notes of a number npm never had (a failed publish, a rebase merge's skipped numbers) go into the next version npm has, so no entry names a version npm never had. When npm hasn't listed the last push's release yet, the version is still right and that release's notes appear under this push's version until the next release rebuilds them under their own. A release that starts a new line puts its own `changelog.json` entry first.
- Entries from before this scheme come from `changelog.json` as committed on `main`, so a pull request can still fix their wording there. Entries since come only from change notes, which can't be edited once landed.

The job writes the version into `package.json`, both lockfiles, `packages/ouro.bot/package.json` and the Sanctuary deploy files (`deploy/unraid/sanctuary.xml`, `deploy/unraid/sanctuary.ouro/bundle-meta.json`), and the entries into `changelog.json`, newest first, in its own checkout only. Nothing is committed back, so on `main` those files keep the version they were committed with; the published package and image carry the real one. The GitHub release attaches the written `sanctuary.xml`, and the template's `TemplateURL` points at `releases/latest/download/sanctuary.xml`, so Unraid always finds the newest image. Planning reads npm with two `npm view` calls (the version list, and every version's `gitHead` in one range query). The container job waits, for up to 90 minutes, until npm has published a version from this very commit, and tags the image with that version, so the image and the package always carry the same number; it writes the changelog from main's history the same way. Each run waits on its own, so a failed npm publish only holds up its own image; the builds and the tagging run one at a time. Publishes run one at a time in push order, and a publish that finds a later version already on npm's `latest` publishes on `alpha` instead.

A manual run of `container-publish.yml` rebuilds the image for main's head only, and only when npm published main's version from that very commit (npm's `gitHead`), so an image never carries code npm did not ship under its tag. `npm run butler:ship -- <version>` finds a release's commit the same way, then from its `v<version>` tag.

To start a new release line (for example `0.2.0-alpha.0`, or a stable `1.0.0`), a pull request sets that version with `npm run release:bump`; the preflight allows a move to a new, higher line and refuses a move within one. That pull request writes the new version's `changelog.json` entry itself and adds no change note, since its own landing publishes that version from that entry; entries worked out for the old line are kept. A branch made before this scheme that still carries a bump runs `npm run release:drop-bump`, which moves the `changelog.json` entries it added into a change note named after the branch (one name main does not have), keeps any fix it made to an older entry, puts the release files back and merges main. The preflight also refuses any commit on a branch that changes the version, even one a later commit undoes, because a rebase merge would replay it on main; such a branch is rebuilt as one commit on main (`git reset --soft $(git merge-base origin/main HEAD) && git commit`, then `git push --force-with-lease`).

## 2. Runtime Metadata

Source:

- `src/heart/daemon/runtime-metadata.ts`

Runtime metadata exposes:

- `version`
- `lastUpdated`

`lastUpdated` prefers the latest git commit timestamp when available and falls back to `package.json` mtime when git metadata is unavailable.

## 3. Installed Launcher Version

The installed `ouro` command is a tiny launcher written to:

- `~/.local/bin/ouro`

It delegates to the version-managed runtime under `~/.ouro-cli/CurrentVersion`.
The bootstrap and update channel is:

- `ouro.bot@latest`
- `@ouro.bot/cli@latest`

`latest` is the supported npm dist-tag channel. During the pre-stable era,
trusted publishing sets `latest` directly when publishing prerelease builds.
After `latest` points at a stable release, future prereleases publish to their
prerelease channel instead of replacing stable `latest`.

The legacy `alpha` dist-tag may exist on npm for historical packages, but it is
not a supported consumption channel while prereleases are the default runtime.
The trusted-publishing workflow advances one selected consumption tag per
package, so current clients, docs, launchers, and update checks must consume
`latest` until a stable `latest` release exists.

The launcher should always converge on the same runtime channel as the bootstrap path. `ouro up` repairs stale launcher contents if needed.

## 4. Bootstrap Wrapper

`ouro.bot` is the bootstrap wrapper package.

Its job is simple:

- get the human into the current CLI runtime
- stay boring
- never become a second source of truth

The harness includes logic to reclaim the global `ouro.bot` binary when a stale global CLI install has hijacked it.

## 5. Daemon Runtime Version

The daemon is version-aware.

If:

- the local launcher/runtime is newer
- and the running daemon reports an older version

then `ouro up` replaces the stale daemon instead of leaving launcher and daemon on different versions. `ouro dev` always force-restarts from the local repo build regardless of version drift.

That keeps:

- `npx ouro.bot@latest`
- `ouro`
- daemon behavior

in sync.

## 6. Bundle Meta

Each bundle has:

- `~/AgentBundles/<agent>.ouro/bundle-meta.json`

Fields:

- `runtimeVersion`
- `bundleSchemaVersion`
- `lastUpdated`
- `previousRuntimeVersion` (when applicable)

This answers:

- which runtime last touched this bundle?
- did this bundle just cross a runtime boundary?

It is not the same thing as the package version, but it tracks that package version per bundle.

## 7. Schema Version Fields

There are additional format-version fields that are narrower in scope:

### `agent.json.version`

- bundle config schema version

### `FriendRecord.schemaVersion`

- friend-record schema version

### session envelope `version`

- saved conversation/session file format version

These are file-format markers, not "what runtime am I on?" markers.

## 8. How They Relate

Use this mental model:

- package version -> the runtime release itself
- runtime metadata -> what this running checkout believes it is
- launcher/bootstrap version -> whether the human enters through the right runtime
- daemon version -> whether the long-lived process matches the current runtime
- bundle-meta -> what runtime last touched a specific bundle
- schema versions -> whether individual file formats changed

## 9. Practical Update Story

For humans, the desired update path is:

```bash
cd ~
npx ouro.bot@latest up
ouro status
```

What should happen:

- bootstrap reaches the current runtime
- launcher repairs if stale
- daemon repairs if stale
- bundle update hooks run as needed

The user should not have to reason about wrapper/package drift just to get current.
