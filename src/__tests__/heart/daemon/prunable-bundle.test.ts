import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  isSafePrunableAgentName,
  listPrunableAgentBundles,
  resolvePrunableAgentBundle,
  type PrunableBundleFs,
} from "../../../heart/daemon/prunable-bundle"

describe("prunable bundle resolution", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "prunable-bundle-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function bundle(name: string, agentJson: string | null = "{}", kind: "directory" | "file" = "directory"): string {
    const bundlePath = path.join(root, `${name}.ouro`)
    if (kind === "file") {
      fs.writeFileSync(bundlePath, "not a bundle", "utf8")
      return bundlePath
    }
    fs.mkdirSync(bundlePath)
    if (agentJson !== null) fs.writeFileSync(path.join(bundlePath, "agent.json"), agentJson, "utf8")
    return bundlePath
  }

  it.each([
    "Slugger",
    "slugger.dev",
    "slugger_dev",
    "slugger-dev",
    "A",
    `a${"b".repeat(127)}`,
  ])("accepts the canonical safe-name grammar: %s", (name) => {
    expect(isSafePrunableAgentName(name)).toBe(true)
  })

  it.each([
    "",
    ".",
    "..",
    "-slugger",
    "_slugger",
    ".slugger",
    "slugger rach",
    "slugger/rach",
    "slugger\\rach",
    "slugger'",
    "slugger\"",
    "slugger`id`",
    "slugger$(id)",
    "slugger\nrach",
    `a${"b".repeat(128)}`,
  ])("rejects unsafe agent names: %j", (name) => {
    expect(isSafePrunableAgentName(name)).toBe(false)
  })

  it("resolves a direct real bundle with a present agent.json", () => {
    const bundlePath = bundle("Slugger")
    const bundleReal = fs.realpathSync(bundlePath)

    expect(resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "Slugger" })).toEqual({
      agentName: "Slugger",
      bundleDir: bundleReal,
      logsDir: path.join(bundleReal, "state", "daemon", "logs"),
    })
  })

  it.each([
    ["valid", "{}"],
    ["malformed", "{"],
    ["disabled", JSON.stringify({ enabled: false })],
    ["library-kind", JSON.stringify({ kind: "library" })],
  ])("lists %s bundles because config presence, not manageability, defines pruning", (_label, agentJson) => {
    bundle("Slugger", agentJson)
    expect(listPrunableAgentBundles({ bundlesRoot: root })).toEqual(["Slugger"])
  })

  it("lists an unreadable agent.json because it only needs to be present", () => {
    const bundlePath = bundle("Slugger")
    fs.chmodSync(path.join(bundlePath, "agent.json"), 0o000)
    try {
      expect(listPrunableAgentBundles({ bundlesRoot: root })).toEqual(["Slugger"])
    } finally {
      fs.chmodSync(path.join(bundlePath, "agent.json"), 0o600)
    }
  })

  it("rejects task-only directories with no agent.json", () => {
    bundle("Slugger", null)
    expect(listPrunableAgentBundles({ bundlesRoot: root })).toEqual([])
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "Slugger" }))
      .toThrow("agent.json")
  })

  it("rejects unsafe names and a missing bundles root during resolution", () => {
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "../Slugger" }))
      .toThrow("name must match")
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: path.join(root, "missing"), agentName: "Slugger" }))
      .toThrow("bundles root does not exist")
    expect(listPrunableAgentBundles({ bundlesRoot: path.join(root, "missing") })).toEqual([])
  })

  it("rejects unresolvable and non-direct canonical bundle paths", () => {
    const bundlePath = bundle("Slugger")
    const rootReal = fs.realpathSync(root)
    const actualFs: PrunableBundleFs = {
      existsSync: fs.existsSync,
      lstatSync: fs.lstatSync,
      readdirSync: fs.readdirSync,
      realpathSync: fs.realpathSync,
    }

    expect(() => resolvePrunableAgentBundle({
      bundlesRoot: root,
      agentName: "Slugger",
      fs: {
        ...actualFs,
        realpathSync: (filePath) => {
          if (filePath === bundlePath) throw new Error("unresolvable")
          return fs.realpathSync(filePath)
        },
      },
    })).toThrow("bundle cannot be resolved")

    expect(() => resolvePrunableAgentBundle({
      bundlesRoot: root,
      agentName: "Slugger",
      fs: {
        ...actualFs,
        realpathSync: (filePath) => filePath === bundlePath
          ? path.join(rootReal, "nested", "Slugger.ouro")
          : fs.realpathSync(filePath),
      },
    })).toThrow("direct child")

    expect(() => resolvePrunableAgentBundle({
      bundlesRoot: root,
      agentName: "Slugger",
      fs: {
        ...actualFs,
        realpathSync: (filePath) => filePath === bundlePath
          ? path.join(rootReal, "Other.ouro")
          : fs.realpathSync(filePath),
      },
    })).toThrow("direct child")
  })

  it("rejects unknown bundles, non-directories, and symlinked bundles", () => {
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "Missing" }))
      .toThrow("not a prunable agent bundle")

    bundle("File", "{}", "file")
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "File" }))
      .toThrow("real directory")

    const real = bundle("Real")
    fs.symlinkSync(real, path.join(root, "Alias.ouro"))
    expect(() => resolvePrunableAgentBundle({ bundlesRoot: root, agentName: "Alias" }))
      .toThrow("real directory")
  })

  it("ignores unsafe, non-directory, task-only, and symlink entries while listing", () => {
    bundle("Good")
    bundle("TaskOnly", null)
    bundle("NotDirectory", "{}", "file")
    const real = bundle("Real")
    fs.symlinkSync(real, path.join(root, "Alias.ouro"))
    fs.mkdirSync(path.join(root, "bad name.ouro"))
    fs.writeFileSync(path.join(root, "bad name.ouro", "agent.json"), "{}", "utf8")
    fs.writeFileSync(path.join(root, "README.txt"), "ignore me", "utf8")

    expect(listPrunableAgentBundles({ bundlesRoot: root })).toEqual(["Good", "Real"])
  })
})
