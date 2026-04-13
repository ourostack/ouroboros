import { existsSync, readFileSync, readdirSync } from "fs"
import * as os from "os"
import { join } from "path"

import { describe, expect, it } from "vitest"

import { CANONICAL_BUNDLE_MANIFEST } from "../../mind/bundle-manifest"

function candidateBundleRoots(agent: string): string[] {
  return [
    join(os.homedir(), "AgentBundles", `${agent}.ouro`),
    join(os.homedir(), "AgentBundles--backup", `${agent}.ouro`),
    join(process.cwd(), `${agent}.ouro`),
  ]
}

function resolveBundleRoot(agent: string): string | null {
  for (const candidate of candidateBundleRoots(agent)) {
    if (existsSync(join(candidate, "agent.json"))) {
      return candidate
    }
  }

  return null
}

function resolveRequiredBundleRoots(): { ouroboros: string; slugger: string } | null {
  const ouroboros = resolveBundleRoot("ouroboros")
  const slugger = resolveBundleRoot("slugger")

  if (ouroboros && slugger) {
    return { ouroboros, slugger }
  }

  if (!ouroboros && !slugger) {
    return null
  }

  throw new Error(
    "Bundle contract requires both bundles to be available together or both absent in CI checkout.",
  )
}

/** Paths that must exist on disk for existing bundles.
 *  - `state` is runtime-only (created on first run)
 *  - `arc` is created on first write or migration
 *  - `diary` is new (migrated from psyche/notes on first write)
 *  - `journal` is new (created on first journal write)
 */
function requiredPaths(root: string): string[] {
  return CANONICAL_BUNDLE_MANIFEST
    .filter((entry) => entry.path !== "state" && entry.path !== "diary" && entry.path !== "journal" && !entry.path.startsWith("arc"))
    .map((entry) => join(root, entry.path))
}

describe("bundle skeleton contract", () => {
  it("has required canonical paths when bundles are available", () => {
    const roots = resolveRequiredBundleRoots()
    if (!roots) {
      expect(existsSync(join(process.cwd(), "ouroboros.ouro"))).toBe(false)
      expect(existsSync(join(process.cwd(), "slugger.ouro"))).toBe(false)
      return
    }

    const all = [
      ...requiredPaths(roots.ouroboros),
      ...requiredPaths(roots.slugger),
    ]

    const missing = all.filter((absolutePath) => !existsSync(absolutePath))
    expect(missing).toEqual([])
  })

  it("keeps slugger agent config aligned to gate-2 schema", () => {
    const roots = resolveRequiredBundleRoots()
    if (!roots) {
      expect(existsSync(join(process.cwd(), "ouroboros.ouro"))).toBe(false)
      expect(existsSync(join(process.cwd(), "slugger.ouro"))).toBe(false)
      return
    }

    const ouroborosConfig = JSON.parse(
      readFileSync(join(roots.ouroboros, "agent.json"), "utf-8"),
    ) as Record<string, unknown>
    const sluggerConfig = JSON.parse(
      readFileSync(join(roots.slugger, "agent.json"), "utf-8"),
    ) as Record<string, unknown>

    // Slugger's config may have optional keys (e.g., mcpServers) beyond the template
    for (const key of Object.keys(ouroborosConfig)) {
      expect(sluggerConfig).toHaveProperty(key)
    }
    expect(sluggerConfig).toHaveProperty("version")
    expect(sluggerConfig).toHaveProperty("enabled")
    expect(typeof sluggerConfig.version).toBe("number")
    expect(typeof sluggerConfig.enabled).toBe("boolean")
    expect(sluggerConfig).toHaveProperty("humanFacing")
    expect(sluggerConfig).toHaveProperty("agentFacing")
    const humanFacing = sluggerConfig.humanFacing as Record<string, unknown>
    const agentFacing = sluggerConfig.agentFacing as Record<string, unknown>
    expect(typeof humanFacing.provider).toBe("string")
    expect(typeof humanFacing.model).toBe("string")
    expect(typeof agentFacing.provider).toBe("string")
    expect(typeof agentFacing.model).toBe("string")
    expect(sluggerConfig).not.toHaveProperty("name")
    expect(sluggerConfig).not.toHaveProperty("configPath")
  })

  it("keeps slugger canonical psyche files non-empty", () => {
    const roots = resolveRequiredBundleRoots()
    if (!roots) {
      expect(existsSync(join(process.cwd(), "ouroboros.ouro"))).toBe(false)
      expect(existsSync(join(process.cwd(), "slugger.ouro"))).toBe(false)
      return
    }

    const readPsyche = (file: string): string =>
      readFileSync(join(roots.slugger, "psyche", file), "utf-8").trim()

    expect(readPsyche("IDENTITY.md").length).toBeGreaterThan(0)
    expect(readPsyche("SOUL.md").length).toBeGreaterThan(0)
    expect(readPsyche("LORE.md").length).toBeGreaterThan(0)
    expect(readPsyche("TACIT.md").length).toBeGreaterThan(0)
    expect(readPsyche("ASPIRATIONS.md").length).toBeGreaterThan(0)
  })

  it("ships Serpent Guide bundle with pre-authored identities", () => {
    const specialistRoot = join(process.cwd(), "SerpentGuide.ouro")
    const identitiesDir = join(specialistRoot, "psyche", "identities")

    expect(existsSync(specialistRoot)).toBe(true)
    expect(existsSync(join(specialistRoot, "agent.json"))).toBe(true)
    expect(existsSync(join(specialistRoot, "psyche", "SOUL.md"))).toBe(true)
    expect(existsSync(identitiesDir)).toBe(true)

    const identities = readdirSync(identitiesDir).filter((entry) => entry.endsWith(".md"))
    expect(identities.length).toBeGreaterThanOrEqual(13)
  })

  it("keeps bundles external to harness repo root", () => {
    expect(existsSync(join(process.cwd(), "ouroboros.ouro"))).toBe(false)
    expect(existsSync(join(process.cwd(), "slugger.ouro"))).toBe(false)
    expect(existsSync(join(process.cwd(), "SerpentGuide.ouro"))).toBe(true)

    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(gitignore).not.toContain("*.ouro/")
  })
})
