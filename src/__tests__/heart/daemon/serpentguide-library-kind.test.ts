import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

/**
 * Layer 3 — SerpentGuide.ouro retroactively tagged as a library bundle.
 *
 * SerpentGuide is content-only (psyche identities), never spawned as an agent.
 * Before this PR it was kept out of discovery via `enabled: false`. Now the
 * architectural reason is `kind: "library"`; `enabled: false` is preserved for
 * back-compat but no longer the load-bearing flag.
 */
describe("SerpentGuide.ouro is tagged as kind:library", () => {
  const repoRoot = path.resolve(__dirname, "../../../..")
  const agentJsonPath = path.join(repoRoot, "SerpentGuide.ouro", "agent.json")

  it("ships agent.json with kind:library", () => {
    const raw = fs.readFileSync(agentJsonPath, "utf-8")
    const parsed = JSON.parse(raw) as { kind?: unknown; enabled?: unknown }

    expect(parsed.kind).toBe("library")
  })

  it("preserves enabled:false for back-compat alongside kind:library", () => {
    const raw = fs.readFileSync(agentJsonPath, "utf-8")
    const parsed = JSON.parse(raw) as { kind?: unknown; enabled?: unknown }

    expect(parsed.enabled).toBe(false)
  })
})
