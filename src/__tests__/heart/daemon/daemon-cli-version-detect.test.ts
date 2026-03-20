import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { readFirstBundleMetaVersion } from "../../../heart/daemon/daemon-cli"

const createdDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("readFirstBundleMetaVersion", () => {
  it("reads runtimeVersion from the first .ouro bundle", () => {
    const bundlesRoot = createTempDir("version-detect-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.1.0-alpha.74", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    expect(readFirstBundleMetaVersion(bundlesRoot)).toBe("0.1.0-alpha.74")
  })

  it("returns undefined for non-existent directory", () => {
    expect(readFirstBundleMetaVersion("/nonexistent/path")).toBeUndefined()
  })

  it("returns undefined for empty directory", () => {
    const bundlesRoot = createTempDir("version-detect-empty-")
    expect(readFirstBundleMetaVersion(bundlesRoot)).toBeUndefined()
  })

  it("returns undefined when bundle-meta.json is missing", () => {
    const bundlesRoot = createTempDir("version-detect-no-meta-")
    fs.mkdirSync(path.join(bundlesRoot, "test.ouro"), { recursive: true })
    expect(readFirstBundleMetaVersion(bundlesRoot)).toBeUndefined()
  })

  it("returns undefined when bundle-meta.json is malformed", () => {
    const bundlesRoot = createTempDir("version-detect-malformed-")
    const agentDir = path.join(bundlesRoot, "test.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "bundle-meta.json"), "not-json")
    expect(readFirstBundleMetaVersion(bundlesRoot)).toBeUndefined()
  })

  it("skips non-.ouro directories", () => {
    const bundlesRoot = createTempDir("version-detect-skip-")
    fs.mkdirSync(path.join(bundlesRoot, "notes"), { recursive: true })
    const agentDir = path.join(bundlesRoot, "agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.1.0-alpha.70" }),
    )
    expect(readFirstBundleMetaVersion(bundlesRoot)).toBe("0.1.0-alpha.70")
  })
})
