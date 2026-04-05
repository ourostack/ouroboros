import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { DEFAULT_AGENT_PHRASES, type AgentConfig } from "../identity"

/**
 * List existing .ouro bundles in the given directory.
 */
export function listExistingBundles(bundlesRoot: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const discovered: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
    const agentName = entry.name.slice(0, -5)
    discovered.push(agentName)
  }
  return discovered.sort((a, b) => a.localeCompare(b))
}

/**
 * Load identity-specific phrases from the specialist's agent.json.
 * Falls back to DEFAULT_AGENT_PHRASES if not found.
 */
export function loadIdentityPhrases(
  bundleSourceDir: string,
  identityFileName: string,
): AgentConfig["phrases"] {
  const agentJsonPath = path.join(bundleSourceDir, "agent.json")
  try {
    const raw = fs.readFileSync(agentJsonPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      phrases?: AgentConfig["phrases"]
      identityPhrases?: Record<string, AgentConfig["phrases"]>
    }
    const identityKey = identityFileName.replace(/\.md$/, "")
    const identity = parsed.identityPhrases?.[identityKey]
    if (identity?.thinking?.length && identity?.tool?.length && identity?.followup?.length) {
      return identity
    }
    if (parsed.phrases?.thinking?.length && parsed.phrases?.tool?.length && parsed.phrases?.followup?.length) {
      return parsed.phrases
    }
  } catch {
    // agent.json missing or malformed -- fall through
  }
  return { ...DEFAULT_AGENT_PHRASES }
}

/**
 * Pick a random identity from the specialist's identities directory.
 */
export function pickRandomIdentity(
  identitiesDir: string,
  random: () => number = Math.random,
): { fileName: string; content: string } {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.specialist_identity_pick",
    message: "picking specialist identity",
    meta: { identitiesDir },
  })

  let files: string[]
  try {
    files = fs.readdirSync(identitiesDir).filter((f) => f.endsWith(".md"))
  } catch {
    return { fileName: "default", content: "I am a serpent guide who helps humans hatch their first agent." }
  }

  if (files.length === 0) {
    return { fileName: "default", content: "I am a serpent guide who helps humans hatch their first agent." }
  }
  const idx = Math.floor(random() * files.length)
  const fileName = files[idx]
  const content = fs.readFileSync(path.join(identitiesDir, fileName), "utf-8")

  emitNervesEvent({
    component: "daemon",
    event: "daemon.specialist_identity_picked",
    message: "picked specialist identity",
    meta: { identity: fileName },
  })

  return { fileName, content }
}

/**
 * Read SOUL.md from the specialist bundle.
 */
export function loadSoulText(bundleSourceDir: string): string {
  const soulPath = path.join(bundleSourceDir, "psyche", "SOUL.md")
  try {
    return fs.readFileSync(soulPath, "utf-8")
  } catch {
    return ""
  }
}
