import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { readAgencyMetadata } from "../../repertoire/plugins"
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

type InstallContext = {
  inProgress: Set<string>
  depth: number
  noDeps: boolean
}

export async function executePluginInstall(
  command: Extract<OuroCliCommand, { kind: "plugin.install" }>,
  deps: PluginCliDeps,
): Promise<string> {
  return executePluginInstallInternal(command, deps, {
    inProgress: new Set(),
    depth: 0,
    noDeps: command.noDeps ?? false,
  })
}

async function executePluginInstallInternal(
  command: Extract<OuroCliCommand, { kind: "plugin.install" }>,
  deps: PluginCliDeps,
  ctx: InstallContext,
): Promise<string> {
  const { source } = command
  const pluginsRoot = getPluginsRootDir()
  const pluginId = derivePluginIdFromSource(source)
  const installDir = path.join(pluginsRoot, pluginId)
  const indent = "  ".repeat(ctx.depth)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_install_start",
    message: "installing plugin",
    meta: { source, pluginId, installDir, depth: ctx.depth },
  })

  if (ctx.inProgress.has(pluginId)) {
    const message = `${indent}Skipping '${pluginId}': dependency cycle detected.`
    deps.writeStdout(message)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.plugin_install_dep_skip_cycle",
      message: "dependency cycle detected",
      meta: { pluginId, inProgress: Array.from(ctx.inProgress) },
    })
    return message
  }

  if (fs.existsSync(installDir)) {
    if (ctx.depth > 0) {
      const message = `${indent}Dependency '${pluginId}' already installed; skipping.`
      deps.writeStdout(message)
      emitNervesEvent({
        component: "daemon",
        event: "daemon.plugin_install_dep_skip_installed",
        message: "dep already installed; skipping",
        meta: { pluginId, installDir },
      })
      return message
    }
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

  ctx.inProgress.add(pluginId)
  try {
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
        meta: { source, pluginId, error: errMessage, depth: ctx.depth },
      })
      if (fs.existsSync(installDir)) {
        fs.rmSync(installDir, { recursive: true, force: true })
      }
      const message = `${indent}Plugin install failed: ${errMessage}`
      deps.writeStdout(message)
      return message
    }

    const pluginJson = path.join(installDir, ".claude-plugin", "plugin.json")
    if (!fs.existsSync(pluginJson)) {
      fs.rmSync(installDir, { recursive: true, force: true })
      const message = `${indent}Plugin install failed: .claude-plugin/plugin.json missing in ${installDir}. Rolled back.`
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

    // Resolve transitive deps via agency.json. Failure of a dep does NOT roll
    // back the parent (warn-and-continue policy); operator can retry deps
    // manually with `ouro plugin install <dep-source>`.
    if (!ctx.noDeps) {
      const agencyMeta = readAgencyMetadata(pluginId)
      const depSources = agencyMeta?.dependencies ?? []
      for (const depSource of depSources) {
        deps.writeStdout(`${indent}→ resolving dependency: ${depSource}`)
        try {
          await executePluginInstallInternal(
            { kind: "plugin.install", source: depSource },
            deps,
            { ...ctx, depth: ctx.depth + 1 },
          )
        } catch (e) {
          /* v8 ignore start -- defensive: recursive call only throws Error instances */
          const errMessage = e instanceof Error ? e.message : String(e)
          /* v8 ignore stop */
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.plugin_install_dep_failed",
            message: "dependency install failed; parent stays installed",
            meta: { parent: pluginId, depSource, error: errMessage },
          })
          deps.writeStdout(
            `${indent}  ⚠ dependency '${depSource}' install failed: ${errMessage}. Parent '${pluginId}' is still installed; you can retry the dep with 'ouro plugin install ${depSource}'.`,
          )
        }
      }
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.plugin_install_end",
      message: "plugin installed",
      meta: { source, pluginId, installDir, depth: ctx.depth },
    })

    const message =
      ctx.depth === 0
        ? `Plugin '${pluginId}' installed at ${installDir}. Run 'ouro up' to activate.`
        : `${indent}Installed dependency '${pluginId}'.`
    deps.writeStdout(message)
    return message
  } finally {
    ctx.inProgress.delete(pluginId)
  }
}

export async function executePluginList(
  command: Extract<OuroCliCommand, { kind: "plugin.list" }>,
  deps: PluginCliDeps,
): Promise<string> {
  void command
  const pluginsRoot = getPluginsRootDir()
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_list_start",
    message: "listing plugins",
    meta: { pluginsRoot },
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
  const entries = fs
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
  const { pluginId } = command
  const installDir = path.join(getPluginsRootDir(), pluginId)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.plugin_remove_start",
    message: "removing plugin",
    meta: { pluginId, installDir },
  })
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
