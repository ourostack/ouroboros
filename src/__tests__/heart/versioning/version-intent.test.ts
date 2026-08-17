import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

describe("version intent", () => {
  const homes: string[] = []

  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  })

  function home(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-version-intent-"))
    homes.push(value)
    return value
  }

  it("atomically writes and reads pinned intent", async () => {
    const { readVersionIntent, writeVersionIntent } = await import("../../../heart/versioning/version-intent")
    const homeDir = home()

    writeVersionIntent({ schemaVersion: 1, mode: "pinned", targetVersion: "0.1.0-alpha.700" }, { homeDir })

    expect(readVersionIntent({ homeDir })).toEqual({
      schemaVersion: 1,
      mode: "pinned",
      targetVersion: "0.1.0-alpha.700",
    })
    expect(fs.statSync(path.join(homeDir, ".ouro-cli", "version-intent.json")).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.join(homeDir, ".ouro-cli")).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  it("returns null for missing intent and rejects malformed intent", async () => {
    const { readVersionIntent } = await import("../../../heart/versioning/version-intent")
    const homeDir = home()
    expect(readVersionIntent({ homeDir })).toBeNull()
    fs.mkdirSync(path.join(homeDir, ".ouro-cli"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".ouro-cli", "version-intent.json"), JSON.stringify({ mode: "pinned" }))
    expect(() => readVersionIntent({ homeDir })).toThrow("invalid version intent")
  })

  it("leaves previous intent authoritative when atomic replacement fails", async () => {
    const { readVersionIntent, writeVersionIntent } = await import("../../../heart/versioning/version-intent")
    const homeDir = home()
    writeVersionIntent({ schemaVersion: 1, mode: "pinned", targetVersion: "old" }, { homeDir })

    expect(() => writeVersionIntent(
      { schemaVersion: 1, mode: "latest", targetVersion: "new" },
      { homeDir, renameSync: () => { throw new Error("interrupted") } },
    )).toThrow("interrupted")

    expect(readVersionIntent({ homeDir })?.targetVersion).toBe("old")
  })
})
