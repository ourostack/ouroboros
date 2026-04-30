# Versioning Strategy

This repo has a few different kinds of "version", and they answer different questions.

## 1. Runtime Package Version

Source:

- `package.json`

Example:

- `0.1.0-alpha.36`

This is the version reported by:

- `npx ouro.bot@alpha -v`
- `ouro -v`
- `ouro status`

It is the main answer to "what runtime am I running?"

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

- `ouro.bot@alpha`
- `@ouro.bot/cli@alpha`

`alpha` is the supported npm dist-tag channel while the package version still uses
alpha prerelease semver. `latest` may lag during prerelease publish recovery, so
runtime-managed bootstrap paths do not use it as the source of truth.

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

- `npx ouro.bot@alpha`
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
npx ouro.bot@alpha up
ouro status
```

What should happen:

- bootstrap reaches the current runtime
- launcher repairs if stale
- daemon repairs if stale
- bundle update hooks run as needed

The user should not have to reason about wrapper/package drift just to get current.
