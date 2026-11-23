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

Pull requests never set the version. The release job on `main` (`publish` in
`.github/workflows/coverage.yml`, and `container-publish.yml` for the image)
runs `scripts/release-version.cjs`, which works it out from main's history:

- The anchor is the last commit on main's first-parent line that changed
  `package.json`'s version. It releases that version.
- After it, every commit that releases something takes the next number in
  order (`0.1.0-alpha.N`, then `N+1`). A commit releases something when it
  changes shipped source, scripts, skills, the Unraid deploy files,
  `package.json`, the `ouro.bot` wrapper, or adds a change note. A commit that
  changes only docs, tests or workflows publishes nothing.
- Its changelog entry is the change notes it added under `changes/`, one line
  per paragraph or bullet, or its subject when it added none.

The job writes the version into `package.json`, both lockfiles,
`packages/ouro.bot/package.json` and the Sanctuary deploy files
(`deploy/unraid/sanctuary.xml`, `deploy/unraid/sanctuary.ouro/bundle-meta.json`),
and puts the new entries on top of `changelog.json`, in its own checkout only.
Nothing is committed back, so on `main` those files keep the anchor's version;
the published package and image carry the real one. The same commit always
gets the same version, so every job agrees without asking npm.

To start a new release line (for example `0.2.0-alpha.0`, or a stable
`1.0.0`), a pull request sets that version with `npm run release:bump`; the
preflight allows a move to a new, higher line and refuses a move within one.
A branch made before this scheme that still carries a bump runs
`npm run release:drop-bump`, which moves its `changelog.json` lines into a
change note, puts the release files back and merges main.

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
