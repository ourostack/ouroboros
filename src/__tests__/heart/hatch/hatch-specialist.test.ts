import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getRepoSpecialistIdentitiesDir,
  getSpecialistIdentitySourceDir,
  pickRandomSpecialistIdentity,
  syncSpecialistIdentities,
} from "../../../heart/hatch/hatch-specialist"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("hatch specialist identities", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("syncs pre-authored markdown identities into target directory", () => {
    const source = makeTempDir("specialist-source")
    const target = makeTempDir("specialist-target")
    cleanup.push(source, target)

    fs.writeFileSync(path.join(source, "medusa.md"), "# Medusa\n", "utf-8")
    fs.writeFileSync(path.join(source, "python.md"), "# Python\n", "utf-8")
    fs.writeFileSync(path.join(source, "README.txt"), "ignored", "utf-8")

    const copied = syncSpecialistIdentities({
      sourceDir: source,
      targetDir: target,
    })

    expect(copied).toEqual(["medusa.md", "python.md"])
    expect(fs.existsSync(path.join(target, "medusa.md"))).toBe(true)
    expect(fs.existsSync(path.join(target, "python.md"))).toBe(true)
    expect(fs.existsSync(path.join(target, "README.txt"))).toBe(false)
  })

  it("picks a deterministic identity when random provider is injected", () => {
    const source = makeTempDir("specialist-pick")
    cleanup.push(source)
    fs.writeFileSync(path.join(source, "basilisk.md"), "# Basilisk\n", "utf-8")
    fs.writeFileSync(path.join(source, "medusa.md"), "# Medusa\n", "utf-8")
    fs.writeFileSync(path.join(source, "python.md"), "# Python\n", "utf-8")

    const picked = pickRandomSpecialistIdentity({
      identitiesDir: source,
      random: () => 0.99,
    })

    expect(picked.fileName).toBe("python.md")
    expect(picked.content).toContain("Python")
  })

  it("fails when no identity markdown files are available", () => {
    const source = makeTempDir("specialist-empty")
    cleanup.push(source)

    expect(() =>
      pickRandomSpecialistIdentity({
        identitiesDir: source,
        random: () => 0,
      }),
    ).toThrow("No specialist identities")
  })

  it("returns canonical specialist identity source and repo target directories", () => {
    const source = getSpecialistIdentitySourceDir()
    const target = getRepoSpecialistIdentitiesDir()

    expect(source).toContain(path.join("SerpentGuide.ouro", "psyche", "identities"))
    expect(target).toContain(path.join("SerpentGuide.ouro", "psyche", "identities"))
  })

  it("falls back to __dirname-relative path when ~/AgentBundles/ does not exist", () => {
    const tempHome = makeTempDir("specialist-home")
    cleanup.push(tempHome)
    vi.stubEnv("HOME", tempHome)

    try {
      const source = getSpecialistIdentitySourceDir()
      expect(source.startsWith(path.join(tempHome, "AgentBundles"))).toBe(false)
      expect(source).toContain(path.join("SerpentGuide.ouro", "psyche", "identities"))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns an empty identity list when source directory is missing", () => {
    const root = makeTempDir("specialist-missing-root")
    const source = path.join(root, "does-not-exist")
    const target = makeTempDir("specialist-target-empty")
    cleanup.push(root, target)

    const copied = syncSpecialistIdentities({
      sourceDir: source,
      targetDir: target,
    })

    expect(copied).toEqual([])
    expect(fs.readdirSync(target)).toEqual([])
  })

  it("uses Math.random when no random provider is injected", () => {
    const source = makeTempDir("specialist-random-default")
    cleanup.push(source)
    fs.writeFileSync(path.join(source, "a.md"), "# A\n", "utf-8")
    fs.writeFileSync(path.join(source, "b.md"), "# B\n", "utf-8")

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      const picked = pickRandomSpecialistIdentity({
        identitiesDir: source,
      })
      expect(picked.fileName).toBe("a.md")
    } finally {
      randomSpy.mockRestore()
    }
  })
})
