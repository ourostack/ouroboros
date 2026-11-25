import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const identity = vi.hoisted(() => ({
  root: "",
  config: {} as { desks?: Record<string, string> },
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => identity.root,
  loadAgentConfig: () => identity.config,
}))

import {
  agentDesks,
  bundledDeskDir,
  deskMcpServerConfig,
  listDeskMcpServers,
  overrideBundledDeskDirForTests,
  runnableDeskDir,
} from "../../repertoire/desk-mcp"

const temps: string[] = []
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  identity.config = {}
})

/** A synthetic Desk copy: all the daemon checks for is its bootstrap. */
function fakeDeskCopy(): string {
  const dir = temp("desk-copy-")
  fs.mkdirSync(path.join(dir, "mcp"))
  fs.writeFileSync(path.join(dir, "mcp", "bootstrap.cjs"), "")
  return dir
}

describe("desk-mcp", () => {
  it("finds the package's Desk at vendor/desk", () => {
    expect(bundledDeskDir("/pkg")).toBe(path.join("/pkg", "vendor", "desk"))
    expect(bundledDeskDir()).toBe(path.resolve(__dirname, "..", "..", "..", "vendor", "desk"))
  })

  it("runs Desk's bootstrap on the daemon's Node, bound to one desk", () => {
    expect(deskMcpServerConfig("/b/desk", "/pkg/vendor/desk")).toEqual({
      command: process.execPath,
      args: [path.join("/pkg/vendor/desk", "mcp", "bootstrap.cjs"), "--root", "/b/desk"],
      cwd: "/pkg/vendor/desk",
    })
  })

  it("lists the agent's own desk, then the desks agent.json names, expanding ~", () => {
    const bundle = temp("bundle-")
    const home = temp("home-")
    fs.mkdirSync(path.join(bundle, "desk"))
    fs.mkdirSync(path.join(home, "desk"))
    const owner = { agentName: "a", agentRoot: bundle }
    const config = { desks: { ari: "~/desk", home: "~", gone: path.join(home, "nowhere"), rel: "relative" } }
    expect(agentDesks(owner, config, home)).toEqual([
      { server: "desk", name: null, root: path.join(bundle, "desk"), present: true },
      { server: "desk-ari", name: "ari", root: path.join(home, "desk"), present: true },
      { server: "desk-home", name: "home", root: home, present: true },
      { server: "desk-gone", name: "gone", root: path.join(home, "nowhere"), present: false },
      { server: "desk-rel", name: "rel", root: path.resolve("relative"), present: false },
    ])
  })

  it("reads the current agent's root and config when not given an owner", () => {
    identity.root = temp("bundle-")
    identity.config = { desks: { team: "/nowhere" } }
    expect(agentDesks().map((desk) => [desk.server, desk.root])).toEqual([
      ["desk", path.join(identity.root, "desk")],
      ["desk-team", "/nowhere"],
    ])
    expect(agentDesks({ agentName: "b", agentRoot: "/b" }).map((desk) => desk.root)).toEqual([path.join("/b", "desk"), "/nowhere"])
  })

  it("serves each desk that is on this machine, and leaves out the ones that are not", () => {
    const bundle = temp("bundle-")
    fs.mkdirSync(path.join(bundle, "desk"))
    const shared = temp("shared-desk-")
    const deskDir = fakeDeskCopy()
    const servers = listDeskMcpServers(
      { agentName: "a", agentRoot: bundle },
      { desks: { team: shared, gone: "/nowhere" } },
      deskDir,
    )
    expect(Object.keys(servers)).toEqual(["desk", "desk-team"])
    expect(servers["desk-team"].args).toEqual([path.join(deskDir, "mcp", "bootstrap.cjs"), "--root", shared])
    expect(Object.keys(listDeskMcpServers({ agentName: "a", agentRoot: bundle }, {}, deskDir))).toEqual(["desk"])
  })

  it("serves nothing when this install has no Desk", () => {
    const bundle = temp("bundle-")
    fs.mkdirSync(path.join(bundle, "desk"))
    expect(listDeskMcpServers({ agentName: "a", agentRoot: bundle }, {}, temp("empty-"))).toEqual({})
  })

  it("starts no Desk in unit tests unless one is given, and serves the given copy", () => {
    const bundle = temp("bundle-")
    fs.mkdirSync(path.join(bundle, "desk"))
    const owner = { agentName: "a", agentRoot: bundle }
    expect(listDeskMcpServers(owner, {})).toEqual({})
    const deskDir = fakeDeskCopy()
    try {
      overrideBundledDeskDirForTests(deskDir)
      expect(listDeskMcpServers(owner, {}).desk.cwd).toBe(deskDir)
      overrideBundledDeskDirForTests(undefined)
      expect(listDeskMcpServers(owner, {}, undefined).desk?.cwd ?? bundledDeskDir()).toBe(bundledDeskDir())
    } finally {
      overrideBundledDeskDirForTests(null)
    }
  })

  // Node won't strip TypeScript types under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and Desk's
  // server imports .ts files. Run from an installed package's vendor/desk on 0.1.0-alpha.1536 (2026-11-24), every
  // agent's Desk server exited with code 1 before it answered. So the daemon serves an installed Desk from a copy
  // outside node_modules, one per Desk tree, in the cache scripts/desk-vendor.cjs already uses.
  describe("an installed package's Desk", () => {
    const TREE = "de1293126e7d0c885bc0f66067abb144b0c42152"

    function installedDesk(stamp: object | null = { tree: TREE }): string {
      const dir = path.join(temp("pkg-"), "node_modules", "@ouro.bot", "cli", "vendor", "desk")
      fs.mkdirSync(path.join(dir, "mcp"), { recursive: true })
      fs.writeFileSync(path.join(dir, "mcp", "bootstrap.cjs"), "// bootstrap")
      fs.writeFileSync(path.join(dir, "mcp", "problem.ts"), "export class AxError extends Error {}")
      if (stamp !== null) fs.writeFileSync(path.join(dir, ".ouro-desk.json"), JSON.stringify(stamp))
      return dir
    }

    function serve(deskDir: string, home: string) {
      const bundle = temp("bundle-")
      fs.mkdirSync(path.join(bundle, "desk"))
      return listDeskMcpServers({ agentName: "a", agentRoot: bundle }, {}, deskDir, home).desk
    }

    it("is served from a copy outside node_modules, named by its tree", () => {
      const home = temp("home-")
      const copy = path.join(home, ".cache", "ouroboros", "desk", TREE)
      const server = serve(installedDesk(), home)
      expect(server.args[0]).toBe(path.join(copy, "mcp", "bootstrap.cjs"))
      expect(server.cwd).toBe(copy)
      expect(fs.readFileSync(path.join(copy, "mcp", "problem.ts"), "utf8")).toContain("AxError")
      expect(JSON.parse(fs.readFileSync(path.join(copy, ".ouro-desk.json"), "utf8")).tree).toBe(TREE)
      expect(fs.readdirSync(path.dirname(copy))).toEqual([TREE])
    })

    it("reuses a copy that holds its tree, and replaces one that doesn't", () => {
      const home = temp("home-")
      const deskDir = installedDesk()
      const copy = path.join(home, ".cache", "ouroboros", "desk", TREE)
      serve(deskDir, home)
      fs.writeFileSync(path.join(copy, "kept"), "")
      serve(deskDir, home)
      expect(fs.existsSync(path.join(copy, "kept"))).toBe(true)
      fs.writeFileSync(path.join(copy, ".ouro-desk.json"), "{")
      expect(serve(deskDir, home).cwd).toBe(copy)
      expect(fs.existsSync(path.join(copy, "kept"))).toBe(false)
    })

    it("is served in place when it has no stamp or can't be copied", () => {
      const home = temp("home-")
      const unstamped = installedDesk(null)
      expect(serve(unstamped, home).cwd).toBe(unstamped)
      expect(serve(installedDesk({ tree: "not-a-tree" }), home).cwd).not.toContain(".cache")
      fs.mkdirSync(path.join(home, ".cache", "ouroboros"), { recursive: true })
      fs.writeFileSync(path.join(home, ".cache", "ouroboros", "desk"), "a file where the cache folder goes")
      const deskDir = installedDesk()
      expect(serve(deskDir, home).cwd).toBe(deskDir)
      expect(fs.readdirSync(path.join(home, ".cache", "ouroboros"))).toEqual(["desk"])
    })

    it("uses the copy another process finished first", () => {
      const home = temp("home-")
      const deskDir = installedDesk()
      const copy = path.join(home, ".cache", "ouroboros", "desk", TREE)
      const lose = (from: string, to: string): void => {
        fs.cpSync(deskDir, copy, { recursive: true })
        fs.renameSync(from, `${to}-lost`)
        throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" })
      }
      expect(runnableDeskDir(deskDir, path.dirname(copy), lose)).toBe(copy)
      expect(fs.readdirSync(path.dirname(copy)).sort()).toEqual([TREE, `${TREE}-lost`])
    })

    it("runs in place when the copy can't be moved into place, leaving no partial copy", () => {
      const cacheRoot = path.join(temp("home-"), "desk")
      const deskDir = installedDesk()
      expect(runnableDeskDir(deskDir, cacheRoot, () => { throw "busy" })).toBe(deskDir)
      expect(fs.readdirSync(cacheRoot)).toEqual([])
    })
  })
})
