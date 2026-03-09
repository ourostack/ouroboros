# Versioning Strategy

How the various version fields in the ouro runtime relate to each other.

## Version Fields

### `AgentConfig.version` (agent.json)
- **Location**: `~/AgentBundles/<name>.ouro/agent.json`
- **Type**: `number`
- **Current value**: `1`
- **Purpose**: Schema version of the agent configuration file format.
- **Status**: No migrations exist. All agents are at v1.

### `FriendRecord.schemaVersion` (friends/*.json)
- **Location**: `~/AgentBundles/<name>.ouro/friends/<uuid>.json`
- **Type**: `number`
- **Current value**: `1`
- **Purpose**: Schema version of the friend profile format.
- **Status**: No migrations exist. All records are at v1.

### Session envelope `version` (context.ts)
- **Location**: Session files (serialized conversations)
- **Type**: `number`
- **Current value**: `1`
- **Purpose**: Format version for saved conversation state (messages + usage).
- **Status**: No migrations exist. Sessions at other versions are treated as corrupt and discarded.

### `BundleMeta` (bundle-meta.json)
- **Location**: `~/AgentBundles/<name>.ouro/bundle-meta.json`
- **Type**: Object with `runtimeVersion`, `bundleSchemaVersion`, `lastUpdated`, `previousRuntimeVersion`
- **Current `bundleSchemaVersion`**: `1`
- **Purpose**: Tracks which runtime version last touched this bundle, enabling version-aware behavior on startup.

## How They Relate

The three schema version fields (`AgentConfig.version`, `FriendRecord.schemaVersion`, session `version`) are all at v1 with no migrations. They are independent format markers.

`bundle-meta.json` is the unified tracking layer that sits above all of these. It answers a different question: "which runtime version last ran this agent?" rather than "what format is this file in?"

When the runtime version changes (detected via `runtimeVersion` mismatch in bundle-meta.json), the update hooks system runs. This is where future bundle migrations would live -- if agent.json ever needs a v2, a hook would handle the migration and bump `AgentConfig.version`.

## Update Flow

1. Runtime starts (daemon or CLI)
2. `applyPendingUpdates()` iterates all `.ouro` bundles
3. For each bundle, compares `bundle-meta.json.runtimeVersion` with current package version
4. On mismatch, runs registered update hooks (currently: `bundleMetaHook`)
5. `bundleMetaHook` saves old version as `previousRuntimeVersion`, updates `runtimeVersion` and `lastUpdated`
6. Agent's system prompt shows "runtime version: X.Y.Z" and "previously: A.B.C" when applicable

## No Changes Needed

The existing version fields stay as-is. No migrations are planned. `bundle-meta.json` provides the infrastructure for future migrations without requiring any changes to the existing versioning scheme.
