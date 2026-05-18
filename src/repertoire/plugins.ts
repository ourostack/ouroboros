import * as fs from "fs"
import * as path from "path"

import { loadAgentConfig } from "../heart/identity"
import type { PluginConfig } from "../heart/identity"
import { getOuroCliHome } from "../heart/versioning/ouro-version-manager"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Plugin support for ouroboros (W5.2 of the worker-generalization extraction).
 *
 * Plugins are installed machine-locally at `~/.ouro-cli/plugins/<plugin-id>/`
 * via `ouro plugin install` (W5.3). Each agent's bundle declares which plugins
 * it has enabled via the `plugins[]` field in agent.json (W5.1).
 *
 * This module exposes the loader half: list installed plugins, list the skills
 * a plugin provides, and load a specific plugin skill's body. Mirrors
 * `src/repertoire/skills.ts` priority-chain pattern.
 *
 * Integration with prompt assembly (W5.4): `listPluginSkills(enabledPlugins)`
 * is called from `src/mind/prompt.ts` alongside `listSkills()` so plugin
 * skills appear in the agent's skill index via the same `load_skill` tool.
 */

/** ~/.ouro-cli/plugins/ — machine-scoped plugin install root. */
export function getPluginsRoot(homeDir?: string): string {
  return path.join(getOuroCliHome(homeDir), "plugins")
}

/** ~/.ouro-cli/plugins/<plugin-id>/ — install dir for a specific plugin. */
export function getPluginDir(pluginId: string, homeDir?: string): string {
  return path.join(getPluginsRoot(homeDir), pluginId)
}

/** ~/.ouro-cli/plugins/<plugin-id>/skills/ — the plugin's skill directory. */
export function getPluginSkillsDir(pluginId: string, homeDir?: string): string {
  return path.join(getPluginDir(pluginId, homeDir), "skills")
}

function listMarkdownBasenames(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => {
      // Plugins may use a directory-per-skill layout
      // (`skills/<name>/SKILL.md`) OR a flat-file layout
      // (`skills/<name>.md`). We support both.
      const fullPath = path.join(dir, f)
      if (f.endsWith(".md")) return true
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          return fs.existsSync(path.join(fullPath, "SKILL.md"))
        }
      } catch {
        return false
      }
      return false
    })
    .map((f) => (f.endsWith(".md") ? path.basename(f, ".md") : f))
    .sort()
}

/**
 * List installed plugins under ~/.ouro-cli/plugins/.
 *
 * Returns plugin IDs — directory names under the plugins root. Does NOT
 * filter by enabled-for-this-agent; that's `listEnabledPlugins()`'s job.
 */
export function listPlugins(homeDir?: string): string[] {
  emitNervesEvent({
    event: "plugins.list_start",
    component: "repertoire",
    message: "listing installed plugins",
    meta: { operation: "listPlugins" },
  })
  const root = getPluginsRoot(homeDir)
  if (!fs.existsSync(root)) {
    emitNervesEvent({
      event: "plugins.list_end",
      component: "repertoire",
      message: "no plugins root yet",
      meta: { operation: "listPlugins", count: 0, root },
    })
    return []
  }
  const plugins = fs
    .readdirSync(root)
    .filter((name) => {
      const fullPath = path.join(root, name)
      try {
        return fs.statSync(fullPath).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
  emitNervesEvent({
    event: "plugins.list_end",
    component: "repertoire",
    message: "listed installed plugins",
    meta: { operation: "listPlugins", count: plugins.length },
  })
  return plugins
}

/**
 * List plugins this agent has enabled via agent.json `plugins[]`.
 *
 * Reads the agent config + filters to entries with `enabled: true` whose
 * plugin directory actually exists under ~/.ouro-cli/plugins/. Returns
 * the matched PluginConfig entries (not just IDs) so callers have access
 * to source + version metadata.
 */
export function listEnabledPlugins(homeDir?: string): PluginConfig[] {
  emitNervesEvent({
    event: "plugins.list_enabled_start",
    component: "repertoire",
    message: "listing enabled plugins for agent",
    meta: { operation: "listEnabledPlugins" },
  })
  const config = loadAgentConfig()
  const declared = config.plugins ?? []
  const installed = new Set(listPlugins(homeDir))
  const enabled = declared.filter((p) => p.enabled && installed.has(p.id))
  emitNervesEvent({
    event: "plugins.list_enabled_end",
    component: "repertoire",
    message: "filtered to enabled + installed plugins",
    meta: {
      operation: "listEnabledPlugins",
      declared: declared.length,
      enabled: enabled.length,
    },
  })
  return enabled
}

/**
 * List skill names provided by the given enabled plugins.
 *
 * Walks each plugin's `skills/` directory; supports both directory-per-skill
 * (`skills/<name>/SKILL.md`) and flat-file (`skills/<name>.md`) layouts.
 *
 * Returns a deduplicated sorted list across all plugins. If two plugins
 * declare a skill with the same name, the later-sorted plugin's skill wins
 * (Set dedupe by name; callers concerned with collision can call this per
 * plugin instead).
 */
export function listPluginSkills(
  enabledPlugins: PluginConfig[],
  homeDir?: string,
): string[] {
  emitNervesEvent({
    event: "plugins.list_skills_start",
    component: "repertoire",
    message: "listing skills across enabled plugins",
    meta: { operation: "listPluginSkills", pluginCount: enabledPlugins.length },
  })
  const all: string[] = []
  for (const plugin of enabledPlugins) {
    const skillsDir = getPluginSkillsDir(plugin.id, homeDir)
    const skills = listMarkdownBasenames(skillsDir)
    all.push(...skills)
  }
  const deduped = [...new Set(all)].sort()
  emitNervesEvent({
    event: "plugins.list_skills_end",
    component: "repertoire",
    message: "listed plugin skills",
    meta: {
      operation: "listPluginSkills",
      pluginCount: enabledPlugins.length,
      skillCount: deduped.length,
    },
  })
  return deduped
}

/**
 * Load the body of a specific skill from a specific plugin.
 *
 * Tries both layout shapes: `skills/<name>.md` then `skills/<name>/SKILL.md`.
 * Throws if not found in either.
 */
export function loadPluginSkill(
  pluginId: string,
  skillName: string,
  homeDir?: string,
): string {
  emitNervesEvent({
    event: "plugins.load_skill_start",
    component: "repertoire",
    message: "loading plugin skill",
    meta: { operation: "loadPluginSkill", plugin: pluginId, skill: skillName },
  })
  const skillsDir = getPluginSkillsDir(pluginId, homeDir)
  const flatPath = path.join(skillsDir, `${skillName}.md`)
  const nestedPath = path.join(skillsDir, skillName, "SKILL.md")

  let resolvedPath: string | null = null
  if (fs.existsSync(flatPath)) {
    resolvedPath = flatPath
  } else if (fs.existsSync(nestedPath)) {
    resolvedPath = nestedPath
  }

  if (!resolvedPath) {
    emitNervesEvent({
      level: "error",
      event: "plugins.load_skill_error",
      component: "repertoire",
      message: "plugin skill not found",
      meta: {
        operation: "loadPluginSkill",
        plugin: pluginId,
        skill: skillName,
        checkedPaths: [flatPath, nestedPath],
      },
    })
    throw new Error(
      `plugin skill '${pluginId}:${skillName}' not found in:\n` +
        `- ${flatPath}\n` +
        `- ${nestedPath}`,
    )
  }

  const content = fs.readFileSync(resolvedPath, "utf-8")
  emitNervesEvent({
    event: "plugins.load_skill_end",
    component: "repertoire",
    message: "loaded plugin skill",
    meta: {
      operation: "loadPluginSkill",
      plugin: pluginId,
      skill: skillName,
      path: resolvedPath,
    },
  })
  return content
}
