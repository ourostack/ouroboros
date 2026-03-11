import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"

import { emitNervesEvent } from "../../nerves/runtime"

export interface SubagentInstallResult {
  claudeInstalled: number
  codexInstalled: number
  notes: string[]
}

export interface SubagentInstallerOptions {
  repoRoot?: string
  homeDir?: string
  which?: (binary: string) => string | null
}

function detectCliBinary(binary: string): string | null {
  const result = spawnSync("which", [binary], { encoding: "utf-8" })
  if (result.status !== 0) return null
  const resolved = result.stdout.trim()
  return resolved.length > 0 ? resolved : null
}

function listSubagentSources(subagentsDir: string): string[] {
  if (!fs.existsSync(subagentsDir)) return []
  return fs.readdirSync(subagentsDir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => name !== "README.md")
    .map((name) => path.join(subagentsDir, name))
    .sort((a, b) => a.localeCompare(b))
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

function isSameFile(source: string, target: string): boolean {
  try {
    const sourceStats = fs.statSync(source)
    const targetStats = fs.statSync(target)
    return sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino
  } catch {
    return false
  }
}

function ensureSymlink(source: string, target: string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true })

  if (pathExists(target)) {
    const stats = fs.lstatSync(target)
    if (stats.isSymbolicLink()) {
      const linkedPath = fs.readlinkSync(target)
      if (linkedPath === source) return false
    }
    fs.unlinkSync(target)
  }

  fs.symlinkSync(source, target)
  return true
}

function ensureHardLink(source: string, target: string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true })

  if (pathExists(target)) {
    const stats = fs.lstatSync(target)
    if (!stats.isSymbolicLink() && isSameFile(source, target)) {
      return false
    }
    fs.unlinkSync(target)
  }

  fs.linkSync(source, target)
  return true
}

function hasOpenAiSkillHome(homeDir: string): boolean {
  return pathExists(path.join(homeDir, ".codex")) || pathExists(path.join(homeDir, ".agents"))
}

function openAiSkillTargets(homeDir: string, source: string): string[] {
  const skillName = path.basename(source, ".md")
  return [path.join(homeDir, ".agents", "skills", skillName, "SKILL.md")]
}

export async function installSubagentsForAvailableCli(
  options: SubagentInstallerOptions = {},
): Promise<SubagentInstallResult> {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, "..", "..", "..")
  const homeDir = options.homeDir ?? os.homedir()
  const which = options.which ?? detectCliBinary
  const subagentsDir = path.join(repoRoot, "subagents")
  const sources = listSubagentSources(subagentsDir)
  const notes: string[] = []

  emitNervesEvent({
    component: "daemon",
    event: "daemon.subagent_install_start",
    message: "starting subagent auto-install",
    meta: { sources: sources.length },
  })

  if (sources.length === 0) {
    notes.push(`no subagent files found at ${subagentsDir}`)
    return { claudeInstalled: 0, codexInstalled: 0, notes }
  }

  let claudeInstalled = 0
  let codexInstalled = 0

  const claudePath = which("claude")
  if (!claudePath) {
    notes.push("claude CLI not found; skipping subagent install")
  } else {
    const claudeAgentsDir = path.join(homeDir, ".claude", "agents")
    for (const source of sources) {
      const target = path.join(claudeAgentsDir, path.basename(source))
      if (ensureSymlink(source, target)) {
        claudeInstalled += 1
      }
    }
  }

  const codexPath = which("codex")
  if (!codexPath && !hasOpenAiSkillHome(homeDir)) {
    notes.push("codex CLI/config not found; skipping subagent install")
  } else {
    for (const source of sources) {
      let installedForSkill = false
      for (const target of openAiSkillTargets(homeDir, source)) {
        if (ensureHardLink(source, target)) {
          installedForSkill = true
        }
      }
      if (installedForSkill) {
        codexInstalled += 1
      }
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.subagent_install_end",
    message: "completed subagent auto-install",
    meta: { claudeInstalled, codexInstalled, notes: notes.length },
  })

  return { claudeInstalled, codexInstalled, notes }
}
