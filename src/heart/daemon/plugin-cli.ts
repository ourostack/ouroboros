import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

import { getAgentBundlesRoot, getAgentRoot, type PluginConfig } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { getOuroCliHome } from "../versioning/ouro-version-manager"
import type { OuroCliCommand } from "./cli-types"

// Plugins are installed machine-locally at ~/.ouro-cli/plugins/<id>/ via
// git clone. Each agent's bundle declares which plugins are enabled in
// agent.json plugins[]. Daemon discovers + loads at agent startup; install
// is a separate one-shot operation that requires `ouro up` to activate.

export type PluginCliDeps = {
  writeStdout: (s: string) => void
}

function getPluginsRootDir(): string {
  return path.join(getOuroCliHome(), "plugins")
}

// ── agent.json plugin-list helpers ───────────────────────────────────────────
//
// Each agent's bundle (~/AgentBundles/<name>.ouro/agent.json) declares a
// `plugins[]` array of PluginConfig entries. `--agent <name>` flags on
// `ouro plugin install / list / remove` operate on that array. This is the
// ouro-side per-agent enable mechanism; it lives in the consuming agent's
// bundle, NOT in the plugin's manifest, which stays portable across the
// universal Claude Code / Copilot CLI spec.
//
// Atomic-write note: codebase pattern is plain `fs.writeFileSync(file, JSON
// + "\n")`. Daemon writes to agent.json are already racy with other handlers,
// so we match the existing pattern. A future `writeAgentConfig` atomic helper
// would benefit ~3 callsites; deferred.

function getAgentJsonPath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "agent.json")
}

function readAgentJsonOrThrow(agentName: string): { raw: Record<string, unknown>; path: string } {
  const jsonPath = getAgentJsonPath(agentName)
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `Agent '${agentName}' bundle not found at ${path.dirname(jsonPath)}. Bundle must exist before installing a plugin for it.`,
    )
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Record<string, unknown>
  return { raw, path: jsonPath }
}

function writeAgentJson(jsonPath: string, raw: Record<string, unknown>): void {
  fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2) + "\n", "utf-8")
}

function readAgentPluginsList(agentName: string): PluginConfig[] {
  try {
    const { raw } = readAgentJsonOrThrow(agentName)
    return Array.isArray(raw.plugins) ? (raw.plugins as PluginConfig[]) : []
  } catch {
    return []
  }
}

function addPluginToAgent(
  agentName: string,
  entry: PluginConfig,
): { added: boolean; agentJsonPath: string } {
  const { raw, path: jsonPath } = readAgentJsonOrThrow(agentName)
  const existing = Array.isArray(raw.plugins) ? (raw.plugins as PluginConfig[]) : []
  if (existing.some((p) => p.id === entry.id)) {
    return { added: false, agentJsonPath: jsonPath }
  }
  raw.plugins = [...existing, entry]
  writeAgentJson(jsonPath, raw)
  return { added: true, agentJsonPath: jsonPath }
}

function removePluginFromAgent(
  agentName: string,
  pluginId: string,
): { removed: boolean; agentJsonPath: string } {
  const { raw, path: jsonPath } = readAgentJsonOrThrow(agentName)
  const existing = Array.isArray(raw.plugins) ? (raw.plugins as PluginConfig[]) : []
  const next = existing.filter((p) => p.id !== pluginId)
  if (next.length === existing.length) {
    return { removed: false, agentJsonPath: jsonPath }
  }
  raw.plugins = next
  writeAgentJson(jsonPath, raw)
  return { removed: true, agentJsonPath: jsonPath }
}

function listAgentsReferencingPlugin(pluginId: string): string[] {
  const bundlesRoot = getAgentBundlesRoot()
  if (!fs.existsSync(bundlesRoot)) return []
  const agents: string[] = []
  for (const entry of fs.readdirSync(bundlesRoot)) {
    if (!entry.endsWith(".ouro")) continue
    const agentName = entry.slice(0, -".ouro".length)
    if (readAgentPluginsList(agentName).some((p) => p.id === pluginId)) {
      agents.push(agentName)
    }
  }
  return agents.sort()
}

export function derivePluginIdFromSource(source: string): string {
  // Accepts:
  //   github:org/repo:plugins/<id>
  //   github:org/repo:path/to/<id>
  //   https://github.com/org/repo[.git]
  //   local:/abs/path/to/<id>
  //   /abs/path/to/<id>
  // Returns the trailing path segment as the plugin id.
  const cleaned = source
    .replace(/^github:[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^local:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
  const segments = cleaned.split("/").filter(Boolean)
  const last = segments[segments.length - 1]
  if (!last) {
    throw new Error(`Could not derive plugin id from source: ${source}`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(last)) {
    throw new Error(
      `Derived plugin id '${last}' is not a valid name (alphanumeric + dashes only)`,
    )
  }
  return last
}

function buildPluginCloneUrl(source: string): string {
  if (source.startsWith("github:")) {
    const match = source.match(/^github:([^/]+)\/([^:]+)(?::(.*))?$/)
    if (!match) {
      throw new Error(`Invalid github: source: ${source}`)
    }
    const [, org, repo] = match
    return `https://github.com/${org}/${repo}.git`
  }
  if (source.startsWith("local:")) {
    return source.replace(/^local:/, "")
  }
  return source
}

function buildPluginSubpath(source: string): string | null {
  const match = source.match(/^github:[^/]+\/[^:]+:(.+)$/)
  if (match) return match[1]
  return null
}

export async function executePluginInstall(
  command: Extract<OuroCliCommand, { kind: "plugin.install" }>,
  deps: PluginCliDeps,
): Promise<string> {
  const { source } = command
  const pluginsRoot = getPluginsRootDir()
  const pluginId = derivePluginIdFromSource(source)
  const installDir = path.join(pluginsRoot, pluginId)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_install_start",
    message: "installing plugin",
    meta: { source, pluginId, installDir },
  })

  if (fs.existsSync(installDir)) {
    const message = `Plugin '${pluginId}' is already installed at ${installDir}. Run 'ouro plugin remove ${pluginId}' first to reinstall.`
    deps.writeStdout(message)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_install_error",
      message: "plugin already installed",
      meta: { source, pluginId, installDir },
    })
    return message
  }

  fs.mkdirSync(pluginsRoot, { recursive: true })

  const cloneUrl = buildPluginCloneUrl(source)
  const subpath = buildPluginSubpath(source)

  try {
    if (subpath) {
      const tmpClone = path.join(pluginsRoot, `.${pluginId}.clone-${Date.now()}`)
      execFileSync("git", ["clone", "--depth", "1", cloneUrl, tmpClone], { stdio: "pipe" })
      const subpathInClone = path.join(tmpClone, subpath)
      if (!fs.existsSync(subpathInClone)) {
        fs.rmSync(tmpClone, { recursive: true, force: true })
        throw new Error(`Subpath '${subpath}' not found in cloned repo`)
      }
      fs.renameSync(subpathInClone, installDir)
      fs.rmSync(tmpClone, { recursive: true, force: true })
    } else {
      execFileSync("git", ["clone", "--depth", "1", cloneUrl, installDir], { stdio: "pipe" })
    }
  } catch (e) {
    const errMessage = e instanceof Error ? e.message : String(e)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_install_error",
      message: "plugin clone failed",
      meta: { source, pluginId, error: errMessage },
    })
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true })
    }
    const message = `Plugin install failed: ${errMessage}`
    deps.writeStdout(message)
    return message
  }

  const pluginJson = path.join(installDir, ".claude-plugin", "plugin.json")
  if (!fs.existsSync(pluginJson)) {
    fs.rmSync(installDir, { recursive: true, force: true })
    const message = `Plugin install failed: .claude-plugin/plugin.json missing in ${installDir}. Rolled back.`
    deps.writeStdout(message)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_install_error",
      message: "plugin manifest missing",
      meta: { source, pluginId, expectedManifest: pluginJson },
    })
    return message
  }

  // Wire the plugin entry into the agent's agent.json plugins[] when
  // --agent was passed.
  let agentEnableMessage: string | null = null
  if (command.agent) {
    try {
      const entry: PluginConfig = {
        id: pluginId,
        enabled: true,
        /* v8 ignore next -- command.source is a required field; falsy branch unreachable */
        ...(command.source ? { source: command.source } : {}),
        ...(command.version ? { version: command.version } : {}),
      }
      const result = addPluginToAgent(command.agent, entry)
      agentEnableMessage = result.added
        ? `Enabled plugin '${pluginId}' for agent '${command.agent}' (updated ${result.agentJsonPath}).`
        : `Plugin '${pluginId}' was already enabled for agent '${command.agent}'.`
      emitNervesEvent({
        component: "daemon",
        event: result.added
          ? "daemon.plugin_agent_enable_end"
          : "daemon.plugin_agent_enable_noop",
        message: result.added
          ? "plugin enabled for agent"
          : "plugin already enabled for agent",
        meta: { pluginId, agent: command.agent, agentJsonPath: result.agentJsonPath },
      })
    } catch (e) {
      /* v8 ignore start -- defensive: readAgentJsonOrThrow only throws Error */
      const errMessage = e instanceof Error ? e.message : String(e)
      /* v8 ignore stop */
      agentEnableMessage = `Plugin installed on disk, but enabling for agent '${command.agent}' failed: ${errMessage}`
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.plugin_agent_enable_error",
        message: "agent enable failed; plugin still installed on disk",
        meta: { pluginId, agent: command.agent, error: errMessage },
      })
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_install_end",
    message: "plugin installed",
    meta: { source, pluginId, installDir, agent: command.agent },
  })

  const baseMessage = `Plugin '${pluginId}' installed at ${installDir}. Run 'ouro up' to activate.`
  const message = agentEnableMessage ? `${baseMessage}\n${agentEnableMessage}` : baseMessage
  deps.writeStdout(message)
  return message
}

export async function executePluginList(
  command: Extract<OuroCliCommand, { kind: "plugin.list" }>,
  deps: PluginCliDeps,
): Promise<string> {
  const pluginsRoot = getPluginsRootDir()
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_list_start",
    message: "listing plugins",
    meta: { pluginsRoot, agent: command.agent },
  })
  if (!fs.existsSync(pluginsRoot)) {
    const message = "No plugins installed."
    deps.writeStdout(message)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.plugin_list_end",
      message: "no plugins root",
      meta: { count: 0 },
    })
    return message
  }
  let entries = fs
    .readdirSync(pluginsRoot)
    .filter((name) => {
      try {
        return (
          fs.statSync(path.join(pluginsRoot, name)).isDirectory() &&
          !name.startsWith(".")
        )
      } catch {
        return false
      }
    })
    .sort()

  // With --agent X, filter to plugins enabled for X (intersect installed-on-disk
  // with X's agent.json plugins[]). Without --agent, list all installed.
  if (command.agent) {
    const agentPlugins = readAgentPluginsList(command.agent)
    const enabledIds = new Set(agentPlugins.filter((p) => p.enabled).map((p) => p.id))
    entries = entries.filter((id) => enabledIds.has(id))
    if (entries.length === 0) {
      const message = `No plugins enabled for agent '${command.agent}'.`
      deps.writeStdout(message)
      return message
    }
    const message =
      `Plugins enabled for agent '${command.agent}' (${entries.length}):\n` +
      entries.map((id) => `  - ${id}`).join("\n")
    deps.writeStdout(message)
    return message
  }

  if (entries.length === 0) {
    const message = "No plugins installed."
    deps.writeStdout(message)
    return message
  }
  const message =
    `Installed plugins (${entries.length}):\n` +
    entries.map((id) => `  - ${id}`).join("\n")
  deps.writeStdout(message)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_list_end",
    message: "listed plugins",
    meta: { count: entries.length },
  })
  return message
}

export async function executePluginRemove(
  command: Extract<OuroCliCommand, { kind: "plugin.remove" }>,
  deps: PluginCliDeps,
): Promise<string> {
  const { pluginId, agent } = command
  const installDir = path.join(getPluginsRootDir(), pluginId)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_remove_start",
    message: "removing plugin",
    meta: { pluginId, installDir, agent },
  })

  // With --agent X: scoped to that agent's plugins[] only; never touches disk.
  if (agent) {
    try {
      const { removed, agentJsonPath } = removePluginFromAgent(agent, pluginId)
      const message = removed
        ? `Plugin '${pluginId}' disabled for agent '${agent}' (updated ${agentJsonPath}). Run 'ouro up' to apply.`
        : `Plugin '${pluginId}' was not enabled for agent '${agent}'.`
      deps.writeStdout(message)
      emitNervesEvent({
        component: "daemon",
        event: "daemon.plugin_remove_end",
        message: removed ? "plugin disabled for agent" : "plugin was not enabled for agent",
        meta: { pluginId, agent, agentJsonPath, removed },
      })
      return message
    } catch (e) {
      /* v8 ignore start -- defensive: removePluginFromAgent only throws Error */
      const errMessage = e instanceof Error ? e.message : String(e)
      /* v8 ignore stop */
      const message = `Plugin remove failed for agent '${agent}': ${errMessage}`
      deps.writeStdout(message)
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.plugin_remove_error",
        message: "agent remove failed",
        meta: { pluginId, agent, error: errMessage },
      })
      return message
    }
  }

  // Without --agent: machine-wide remove. Refuse if any agent's plugins[]
  // still references this plugin (silent removal would break those agents
  // on next `ouro up`).
  const refs = listAgentsReferencingPlugin(pluginId)
  if (refs.length > 0) {
    const message =
      `Cannot remove plugin '${pluginId}': still enabled for: ${refs.join(", ")}.\n` +
      `Disable per-agent first with 'ouro plugin remove ${pluginId} --agent <name>', then re-run.`
    deps.writeStdout(message)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_remove_error",
      message: "plugin still referenced by agents",
      meta: { pluginId, refs },
    })
    return message
  }

  if (!fs.existsSync(installDir)) {
    const message = `Plugin '${pluginId}' is not installed at ${installDir}.`
    deps.writeStdout(message)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_remove_error",
      message: "plugin not installed",
      meta: { pluginId, installDir },
    })
    return message
  }
  fs.rmSync(installDir, { recursive: true, force: true })
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_remove_end",
    message: "plugin removed",
    meta: { pluginId, installDir },
  })
  const message = `Plugin '${pluginId}' removed from ${installDir}. Run 'ouro up' to deactivate.`
  deps.writeStdout(message)
  return message
}
