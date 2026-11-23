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

import { agentDesks, bundledDeskDir, deskMcpServerConfig, listDeskMcpServers, overrideBundledDeskDirForTests } from "../../repertoire/desk-mcp"

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
})
