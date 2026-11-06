import * as fs from "fs"
import * as path from "path"

import {
  loadAgentConfig,
  getAgentRoot,
  type McpServerConfig,
} from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getPluginDir, getPluginsRoot } from "./plugins"

/**
 * Plugin MCP discovery (W6 Unit 9 of the desk-as-universal-substrate plan).
 *
 * Each enabled plugin can declare stdio MCP servers in `<plugin-root>/.mcp.json`
 * using the Anthropic/Claude-Code-public-spec shape:
 *
 *     {
 *       "mcpServers": {
 *         "<name>": {
 *           "type": "stdio",
 *           "command": "node",
 *           "args": ["./mcp/index.js", "--root", "${DESK:-./desk}"],
 *           "env": { }
 *         }
 *       }
 *     }
 *
 * `listPluginMcpServers()` walks every enabled plugin for the current agent
 * (re-using `listEnabledPlugins()` semantics from `plugins.ts`), reads each
 * plugin's `.mcp.json` if present, parses the `mcpServers` map, resolves
 * `${VAR:-default}` substitution in args + env values against the process env
 * (with the special `DESK` fallback pointed at the agent's bundle desk root),
 * and returns one `PluginMcpServer` entry per `(plugin, server-name)` pair.
 *
 * Behavior contract:
 *  - Missing `.mcp.json`           → plugin skipped cleanly, no error emitted.
 *  - Malformed JSON                → plugin skipped, `plugin_mcp.parse_error`
 *                                    nerves event emitted, daemon does NOT crash.
 *  - `mcpServers` map missing      → skipped cleanly (treated like no decls).
 *  - Entry missing `command`       → that one entry skipped (defensive — the
 *                                    spawn would fail anyway and this surfaces
 *                                    a friendlier signal).
 *  - `${VAR:-default}`             → resolves to `process.env[VAR]` if set, else
 *                                    `default`. `DESK` defaults to bundle/desk/.
 *  - `${VAR}` with no default      → empty string when unset.
 *
 * Downstream (`getSharedMcpManager()`) merges these entries into the same
 * `McpManager.start()` it already runs for `agent.json`-declared servers.
 */

export interface PluginMcpServer {
  /** The plugin id (directory name under `~/.ouro-cli/plugins/`). */
  pluginId: string
  /** The server name from the `mcpServers` map key. */
  serverName: string
  /** Resolved command (env-var-substituted). */
  command: string
  /** Resolved args (env-var-substituted). */
  args: string[]
  /** Resolved env (env-var-substituted values). */
  env: Record<string, string>
  /** Plugin install dir — used as `cwd` so relative paths in args resolve. */
  cwd: string
}

interface RawServerEntry {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Resolve `${VAR}` and `${VAR:-default}` against the process env (with a
 * caller-supplied override map applied first — used to inject the `DESK`
 * fallback bound to the agent's bundle desk root).
 *
 * Anything that isn't a recognized `${...}` token passes through verbatim.
 * Multiple substitutions per string are supported.
 */
function resolveVars(input: string, overrides: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, varName, _full, def) => {
    if (overrides[varName] !== undefined) return overrides[varName]
    const fromEnv = process.env[varName]
    if (fromEnv !== undefined) return fromEnv
    if (def !== undefined) return def
    return ""
  })
}

function resolveArgs(args: string[], overrides: Record<string, string>): string[] {
  return args.map((a) => resolveVars(a, overrides))
}

function resolveEnv(
  env: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = resolveVars(v, overrides)
  }
  return out
}

function readPluginMcpManifest(pluginRoot: string): Record<string, RawServerEntry> | null {
  const manifestPath = path.join(pluginRoot, ".mcp.json")
  if (!fs.existsSync(manifestPath)) return null
  const raw = fs.readFileSync(manifestPath, "utf-8")
  try {
    const parsed = JSON.parse(raw)
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== "object") return {}
    return servers as Record<string, RawServerEntry>
  } catch (err) {
    /* v8 ignore next -- err.message vs String(err) branch is defensive @preserve */
    const reason = err instanceof Error ? err.message : String(err)
    emitNervesEvent({
      level: "error",
      event: "plugin_mcp.parse_error",
      component: "repertoire",
      message: `failed to parse plugin .mcp.json at ${manifestPath}: ${reason}`,
      meta: { manifestPath, reason },
    })
    return null
  }
}

/**
 * List the MCP servers declared across the current agent's enabled plugins.
 *
 * Returns a flat list — one entry per `(plugin, server-name)` pair — already
 * resolved against process env + the `DESK` bundle-default. The result is
 * suitable for direct hand-off to `McpManager.start()` after key-flattening.
 *
 * `homeDir` is an optional override for the `~/.ouro-cli/` root (test-only).
 */
export function listPluginMcpServers(homeDir?: string): PluginMcpServer[] {
  emitNervesEvent({
    event: "plugin_mcp.list_start",
    component: "repertoire",
    message: "discovering plugin-declared MCP servers",
    meta: { operation: "listPluginMcpServers" },
  })

  const config = loadAgentConfig()
  const declaredPlugins = config.plugins ?? []
  const pluginsRoot = getPluginsRoot(homeDir)

  // Per-agent override: DESK defaults to <bundleRoot>/desk/ when not explicitly set.
  const overrides: Record<string, string> = {}
  if (process.env.DESK === undefined) {
    overrides.DESK = path.join(getAgentRoot(), "desk")
  }

  const out: PluginMcpServer[] = []

  for (const plugin of declaredPlugins) {
    if (!plugin.enabled) continue
    const pluginDir = getPluginDir(plugin.id, homeDir)
    // If the plugins root or plugin dir doesn't exist, skip (installed-but-removed
    // or never-installed). The manifest read does its own .mcp.json existence
    // check; we only need to avoid touching missing plugin dirs.
    if (!fs.existsSync(pluginsRoot)) break
    if (!fs.existsSync(pluginDir)) continue

    const manifest = readPluginMcpManifest(pluginDir)
    if (!manifest) continue

    for (const [serverName, entry] of Object.entries(manifest)) {
      if (!entry || typeof entry.command !== "string" || entry.command.length === 0) {
        continue
      }
      out.push({
        pluginId: plugin.id,
        serverName,
        command: resolveVars(entry.command, overrides),
        args: resolveArgs(entry.args ?? [], overrides),
        env: resolveEnv(entry.env ?? {}, overrides),
        cwd: pluginDir,
      })
    }
  }

  emitNervesEvent({
    event: "plugin_mcp.list_end",
    component: "repertoire",
    message: "discovered plugin-declared MCP servers",
    meta: {
      operation: "listPluginMcpServers",
      pluginCount: declaredPlugins.length,
      serverCount: out.length,
    },
  })

  return out
}

/**
 * Adapter: convert a `PluginMcpServer` into the shape `McpManager.start()`
 * already consumes (`McpServerConfig`). Used by `getSharedMcpManager()` so
 * builtin + plugin servers can be merged into one start call.
 */
export function pluginMcpServerToConfig(server: PluginMcpServer): McpServerConfig {
  return {
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
  }
}
