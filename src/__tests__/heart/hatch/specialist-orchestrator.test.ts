import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("listExistingBundles", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("returns sorted list of .ouro directories", async () => {
    const { listExistingBundles } = await import("../../../heart/hatch/specialist-orchestrator")
    const bundlesRoot = makeTempDir("bundles")
    cleanup.push(bundlesRoot)

    fs.mkdirSync(path.join(bundlesRoot, "Zebra.ouro"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "Alpha.ouro"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "Middle.ouro"), { recursive: true })

    const result = listExistingBundles(bundlesRoot)
    expect(result).toEqual(["Alpha", "Middle", "Zebra"])
  })

  it("filters out non-.ouro directories and non-directory .ouro entries", async () => {
    const { listExistingBundles } = await import("../../../heart/hatch/specialist-orchestrator")
    const bundlesRoot = makeTempDir("bundles")
    cleanup.push(bundlesRoot)

    fs.mkdirSync(path.join(bundlesRoot, "RealBot.ouro"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "not-a-bundle"), { recursive: true })
    fs.writeFileSync(path.join(bundlesRoot, "fake.ouro"), "not a dir", "utf-8")

    const result = listExistingBundles(bundlesRoot)
    expect(result).toEqual(["RealBot"])
  })

  it("returns empty array for non-existent directory", async () => {
    const { listExistingBundles } = await import("../../../heart/hatch/specialist-orchestrator")
    const result = listExistingBundles("/nonexistent/path/to/bundles")
    expect(result).toEqual([])
  })

  it("returns empty array for empty directory", async () => {
    const { listExistingBundles } = await import("../../../heart/hatch/specialist-orchestrator")
    const bundlesRoot = makeTempDir("empty-bundles")
    cleanup.push(bundlesRoot)

    const result = listExistingBundles(bundlesRoot)
    expect(result).toEqual([])
  })
})

describe("loadIdentityPhrases", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("loads identity-specific phrases from agent.json", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)

    fs.writeFileSync(
      path.join(dir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["base thinking"], tool: ["base tool"], followup: ["base followup"] },
        identityPhrases: {
          medusa: {
            thinking: ["the serpent contemplates"],
            tool: ["consulting the oracle"],
            followup: ["the prophecy unfolds"],
          },
        },
      }),
    )

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("the serpent contemplates")
    expect(result.tool).toContain("consulting the oracle")
    expect(result.followup).toContain("the prophecy unfolds")
  })

  it("falls back to base phrases when identity not found", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)

    fs.writeFileSync(
      path.join(dir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["base thinking"], tool: ["base tool"], followup: ["base followup"] },
        identityPhrases: {
          other: { thinking: ["nope"], tool: ["nope"], followup: ["nope"] },
        },
      }),
    )

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("base thinking")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when agent.json missing", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)
    // No agent.json

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("working")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when agent.json is malformed", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)

    fs.writeFileSync(path.join(dir, "agent.json"), "not-json{{{")

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("working")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when base phrases are incomplete", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)

    fs.writeFileSync(
      path.join(dir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["partial"], tool: ["partial"] },
        identityPhrases: {},
      }),
    )

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("working")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when identity phrases are incomplete", async () => {
    const { loadIdentityPhrases } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("identity-phrases")
    cleanup.push(dir)

    fs.writeFileSync(
      path.join(dir, "agent.json"),
      JSON.stringify({
        identityPhrases: {
          medusa: { thinking: ["partial"], tool: ["partial"] },
        },
      }),
    )

    const result = loadIdentityPhrases(dir, "medusa.md")
    expect(result.thinking).toContain("working")
  })
})

describe("pickRandomIdentity", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("picks a random identity from the identities directory", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const identitiesDir = makeTempDir("identities")
    cleanup.push(identitiesDir)

    fs.writeFileSync(path.join(identitiesDir, "medusa.md"), "# Medusa\nI am Medusa.", "utf-8")
    fs.writeFileSync(path.join(identitiesDir, "python.md"), "# Python\nI am Python.", "utf-8")

    // random=0 picks first file
    const result = pickRandomIdentity(identitiesDir, () => 0)
    expect(result.fileName).toBe("medusa.md")
    expect(result.content).toContain("I am Medusa")
  })

  it("picks second file with high random value", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const identitiesDir = makeTempDir("identities")
    cleanup.push(identitiesDir)

    fs.writeFileSync(path.join(identitiesDir, "medusa.md"), "# Medusa\nI am Medusa.", "utf-8")
    fs.writeFileSync(path.join(identitiesDir, "python.md"), "# Python\nI am Python.", "utf-8")

    // random=0.99 picks second file
    const result = pickRandomIdentity(identitiesDir, () => 0.99)
    expect(result.fileName).toBe("python.md")
    expect(result.content).toContain("I am Python")
  })

  it("returns default identity for non-existent directory", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const result = pickRandomIdentity("/nonexistent/identities/dir")
    expect(result.fileName).toBe("default")
    expect(result.content).toContain("serpent guide")
  })

  it("returns default identity for empty identities directory", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const identitiesDir = makeTempDir("empty-identities")
    cleanup.push(identitiesDir)

    const result = pickRandomIdentity(identitiesDir)
    expect(result.fileName).toBe("default")
    expect(result.content).toContain("serpent guide")
  })

  it("filters out non-.md files", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const identitiesDir = makeTempDir("identities")
    cleanup.push(identitiesDir)

    fs.writeFileSync(path.join(identitiesDir, "medusa.md"), "# Medusa\nI am Medusa.", "utf-8")
    fs.writeFileSync(path.join(identitiesDir, "readme.txt"), "not an identity", "utf-8")

    // Only medusa.md should be picked
    const result = pickRandomIdentity(identitiesDir, () => 0)
    expect(result.fileName).toBe("medusa.md")
  })

  it("uses Math.random when no random function provided", async () => {
    const { pickRandomIdentity } = await import("../../../heart/hatch/specialist-orchestrator")
    const identitiesDir = makeTempDir("identities")
    cleanup.push(identitiesDir)

    fs.writeFileSync(path.join(identitiesDir, "medusa.md"), "# Medusa\nI am Medusa.", "utf-8")

    // Should succeed without explicit random function
    const result = pickRandomIdentity(identitiesDir)
    expect(result.fileName).toBe("medusa.md")
  })
})

describe("loadSoulText", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("reads SOUL.md from psyche directory", async () => {
    const { loadSoulText } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("soul")
    cleanup.push(dir)

    const psycheDir = path.join(dir, "psyche")
    fs.mkdirSync(psycheDir, { recursive: true })
    fs.writeFileSync(path.join(psycheDir, "SOUL.md"), "# Soul\nI help humans hatch agents.", "utf-8")

    const result = loadSoulText(dir)
    expect(result).toContain("I help humans hatch agents")
  })

  it("returns empty string when SOUL.md is missing", async () => {
    const { loadSoulText } = await import("../../../heart/hatch/specialist-orchestrator")
    const dir = makeTempDir("no-soul")
    cleanup.push(dir)

    const result = loadSoulText(dir)
    expect(result).toBe("")
  })

  it("returns empty string for non-existent directory", async () => {
    const { loadSoulText } = await import("../../../heart/hatch/specialist-orchestrator")
    const result = loadSoulText("/nonexistent/bundle/dir")
    expect(result).toBe("")
  })
})
