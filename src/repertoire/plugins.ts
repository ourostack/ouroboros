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

function listSkillDirNames(dir: string): string[] {
  // Industry-standard plugin skill layout: each skill is a directory under
  // `skills/`, containing a `SKILL.md` (Claude Code / Copilot CLI / agency
  // convention; SKILL.md is the cross-vendor "agent skill" format with YAML
  // frontmatter + markdown body). Older flat-file layouts (`skills/<name>.md`)
  // are not part of the spec and not supported.
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => {
      const candidate = path.join(dir, name)
      try {
        if (!fs.statSync(candidate).isDirectory()) return false
        return fs.existsSync(path.join(candidate, "SKILL.md"))
      } catch {
        return false
      }
    })
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
 * Walks each plugin's `skills/` directory using the industry-standard
 * directory-per-skill layout (`skills/<name>/SKILL.md`). The SKILL.md
 * convention is shared across Claude Code, Copilot CLI, and the agency CLI.
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
    const skills = listSkillDirNames(skillsDir)
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
 * Resolves the industry-standard directory-per-skill layout:
 * `skills/<skillName>/SKILL.md`. Throws if not found.
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
  const skillPath = path.join(skillsDir, skillName, "SKILL.md")

  if (!fs.existsSync(skillPath)) {
    emitNervesEvent({
      level: "error",
      event: "plugins.load_skill_error",
      component: "repertoire",
      message: "plugin skill not found",
      meta: {
        operation: "loadPluginSkill",
        plugin: pluginId,
        skill: skillName,
        checkedPath: skillPath,
      },
    })
    throw new Error(
      `plugin skill '${pluginId}:${skillName}' not found at ${skillPath}`,
    )
  }

  const content = fs.readFileSync(skillPath, "utf-8")
  emitNervesEvent({
    event: "plugins.load_skill_end",
    component: "repertoire",
    message: "loaded plugin skill",
    meta: {
      operation: "loadPluginSkill",
      plugin: pluginId,
      skill: skillName,
      path: skillPath,
    },
  })
  return content
}

/**
 * Agency CLI overlay metadata read from `<plugin>/agency.json`.
 *
 * The agency CLI (and now ouroboros) read this sibling-of-plugin.json file
 * for cross-engine extensions that aren't part of the Claude Code /
 * Copilot CLI universal manifest:
 *   - `engines`: list of engine names that may install this plugin
 *     (e.g. `["claude", "copilot", "ouro"]`). Empty / absent = any engine.
 *   - `dependencies`: list of source strings (`github:owner/repo:plugins/<id>`)
 *     to install transitively.
 *   - `category`, `tags`: discovery metadata; surfaced to operator on
 *     `ouro plugin list` later.
 *
 * agency.json is OPTIONAL. If absent, `readAgencyMetadata` returns null
 * and callers treat the plugin as no-engine-restriction, no-deps.
 */
export type PluginAgencyMetadata = {
  engines?: string[]
  dependencies?: string[]
  category?: string
  tags?: string[]
}

/**
 * Read `<pluginDir>/agency.json`. Returns null if absent. Returns null AND
 * emits a nerves error event if the file exists but is malformed JSON
 * (treating malformed-optional-file as no-op rather than breaking install).
 */
export function readAgencyMetadata(
  pluginId: string,
  homeDir?: string,
): PluginAgencyMetadata | null {
  const pluginDir = getPluginDir(pluginId, homeDir)
  const agencyJsonPath = path.join(pluginDir, "agency.json")
  emitNervesEvent({
    event: "plugins.agency_read_start",
    component: "repertoire",
    message: "reading plugin agency.json",
    meta: { operation: "readAgencyMetadata", plugin: pluginId, path: agencyJsonPath },
  })
  if (!fs.existsSync(agencyJsonPath)) {
    emitNervesEvent({
      event: "plugins.agency_read_end",
      component: "repertoire",
      message: "plugin has no agency.json (optional)",
      meta: { operation: "readAgencyMetadata", plugin: pluginId, present: false },
    })
    return null
  }
  try {
    const raw = fs.readFileSync(agencyJsonPath, "utf-8")
    const parsed = JSON.parse(raw) as PluginAgencyMetadata
    emitNervesEvent({
      event: "plugins.agency_read_end",
      component: "repertoire",
      message: "read plugin agency.json",
      meta: {
        operation: "readAgencyMetadata",
        plugin: pluginId,
        present: true,
        engines: parsed.engines,
        depCount: parsed.dependencies?.length ?? 0,
      },
    })
    return parsed
  } catch (e) {
    /* v8 ignore start -- defensive: JSON.parse only throws Error subclasses */
    const errMessage = e instanceof Error ? e.message : String(e)
    /* v8 ignore stop */
    emitNervesEvent({
      level: "error",
      event: "plugins.agency_read_error",
      component: "repertoire",
      message: "agency.json malformed; treating as no metadata",
      meta: {
        operation: "readAgencyMetadata",
        plugin: pluginId,
        path: agencyJsonPath,
        error: errMessage,
      },
    })
    return null
  }
}
