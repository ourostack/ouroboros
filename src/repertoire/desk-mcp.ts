import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { getAgentRoot, loadAgentConfig, type AgentConfig, type McpServerConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Desk is built into every Ouro agent.
 *
 * The package ships the Desk release that `desk.lock.json` pins at `vendor/desk` (`scripts/desk-vendor.cjs`), and the
 * daemon runs Desk's own MCP server from it: the same server Claude Code, Codex and Copilot run from the Desk plugin.
 * There is no second Desk. The server binds one desk with `--root`, Desk's documented contract for host programs
 * (`vendor/desk/mcp/index.js`), so it can never fall back to another desk on the machine.
 *
 * Every agent gets a server named `desk` for its own desk, `<bundle>/desk`, and one named `desk-<name>` for each other
 * desk it looks after (agent.json `desks`). Its tools surface as `mcp__desk__task_create`,
 * `mcp__desk-ari__task_update` and so on, the names Claude Code gives a plugin's tools.
 */

export const OWN_DESK_SERVER = "desk"

export interface AgentDesk {
  /** The MCP server that serves this desk. */
  server: string
  /** The agent.json `desks` name, or null for the agent's own desk. */
  name: string | null
  /** The desk's folder on this machine. */
  root: string
  /** Whether that folder exists here. */
  present: boolean
}

type Owner = Readonly<{ agentName: string; agentRoot: string }>

/** The package's copy of Desk: `<package root>/vendor/desk`. This file is `src|dist/repertoire/desk-mcp`. */
export function bundledDeskDir(packageRoot = path.resolve(__dirname, "..", "..")): string {
  return path.join(packageRoot, "vendor", "desk")
}

// Unit tests run agent turns on synthetic bundles and must not start a real Desk; the integration lane runs it. Their
// setup sets this before any module loads, so it lives on the global object rather than in this module.
const TEST_DESK_DIR = Symbol.for("ouro.test.bundledDeskDir")
type TestDeskGlobal = { [TEST_DESK_DIR]?: string | null }

/** Tests: serve desks from this Desk copy, or from none with `null`; `undefined` restores the package's copy. */
export function overrideBundledDeskDirForTests(deskDir: string | null | undefined): void {
  (globalThis as TestDeskGlobal)[TEST_DESK_DIR] = deskDir
}

/** The Desk copy this process serves desks from, or null for none. */
function servingDeskDir(): string | null {
  const override = (globalThis as TestDeskGlobal)[TEST_DESK_DIR]
  return override === undefined ? bundledDeskDir() : override
}

function expandHome(folder: string, home: string): string {
  if (folder === "~") return home
  return folder.startsWith("~/") ? path.join(home, folder.slice(2)) : path.resolve(folder)
}

function isFolder(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}

/** The desks this agent works on: its own, then each one agent.json `desks` names. */
export function agentDesks(
  owner?: Owner,
  config: Pick<AgentConfig, "desks"> = owner === undefined ? loadAgentConfig() : loadAgentConfig(owner),
  home = os.homedir(),
): AgentDesk[] {
  const agentRoot = owner?.agentRoot ?? getAgentRoot()
  const own = path.join(agentRoot, "desk")
  const desks: AgentDesk[] = [{ server: OWN_DESK_SERVER, name: null, root: own, present: isFolder(own) }]
  for (const [name, folder] of Object.entries(config.desks ?? {})) {
    const root = expandHome(folder, home)
    desks.push({ server: `${OWN_DESK_SERVER}-${name}`, name, root, present: isFolder(root) })
  }
  return desks
}

const DESK_STAMP = ".ouro-desk.json"
const TREE = /^[0-9a-f]{40}$/

function stampedTree(dir: string): string | null {
  try {
    const tree: unknown = JSON.parse(fs.readFileSync(path.join(dir, DESK_STAMP), "utf8")).tree
    return typeof tree === "string" && TREE.test(tree) ? tree : null
  } catch {
    return null
  }
}

/**
 * The folder to run the Desk copy at `deskDir` from. Desk's server imports TypeScript files, and Node refuses to strip
 * types under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING): from an installed package's vendor/desk, the
 * server exits before it answers. So an installed Desk runs from a copy at `<cacheRoot>/<tree>`, named by the tree its
 * stamp records (the cache `scripts/desk-vendor.cjs` keeps), made once and moved into place whole. A copy outside
 * node_modules, or one that can't be stamped or copied, runs where it is.
 */
export function runnableDeskDir(
  deskDir: string,
  cacheRoot = path.join(os.homedir(), ".cache", "ouroboros", "desk"),
  rename: (from: string, to: string) => void = fs.renameSync,
): string {
  if (!path.resolve(deskDir).split(path.sep).includes("node_modules")) return deskDir
  const tree = stampedTree(deskDir)
  const target = tree === null ? null : path.join(cacheRoot, tree)
  const partial = `${target}.partial-${process.pid}`
  try {
    if (target === null) throw new Error(`${path.join(deskDir, DESK_STAMP)} names no Desk tree`)
    if (stampedTree(target) === tree) return target
    fs.rmSync(partial, { recursive: true, force: true })
    fs.mkdirSync(cacheRoot, { recursive: true })
    fs.cpSync(deskDir, partial, { recursive: true })
    fs.rmSync(target, { recursive: true, force: true })
    rename(partial, target)
    emitNervesEvent({
      event: "desk.copied_out_of_node_modules",
      component: "repertoire",
      message: "copied the installed Desk outside node_modules, where Node runs its TypeScript",
      meta: { deskDir, target },
    })
    return target
  } catch (error) {
    try {
      fs.rmSync(partial, { recursive: true, force: true })
    } catch {
      // A cache root that isn't a folder holds no partial copy.
    }
    // Another daemon process may have moved its own copy into place first.
    if (target !== null && stampedTree(target) === tree) return target
    emitNervesEvent({
      level: "error",
      event: "desk.copy_failed",
      component: "repertoire",
      message: "couldn't copy the installed Desk outside node_modules; its server may not start",
      meta: { deskDir, target, reason: error instanceof Error ? error.message : String(error) },
    })
    return deskDir
  }
}

/** The MCP server that serves the desk at `root` from the Desk copy at `deskDir`. */
export function deskMcpServerConfig(root: string, deskDir = bundledDeskDir()): McpServerConfig {
  return {
    // The daemon's own Node; Desk's bootstrap moves to a better one itself when this one has no runtime pack.
    command: process.execPath,
    args: [path.join(deskDir, "mcp", "bootstrap.cjs"), "--root", root],
    cwd: deskDir,
  }
}

/** One Desk MCP server per desk this agent works on and that is on this machine, keyed by server name. */
export function listDeskMcpServers(
  owner: Owner,
  config: Pick<AgentConfig, "desks">,
  deskDir: string | null = servingDeskDir(),
  home = os.homedir(),
): Record<string, McpServerConfig> {
  const agentName = owner.agentName
  if (deskDir === null) return {}
  if (!fs.existsSync(path.join(deskDir, "mcp", "bootstrap.cjs"))) {
    emitNervesEvent({
      level: "error",
      event: "desk.bundle_missing",
      component: "repertoire",
      message: "this Ouro install has no Desk; run `node scripts/desk-vendor.cjs` in a source checkout, or reinstall Ouro",
      meta: { agentName, deskDir },
    })
    return {}
  }
  const servers: Record<string, McpServerConfig> = {}
  const missing: string[] = []
  const runFrom = runnableDeskDir(deskDir, path.join(home, ".cache", "ouroboros", "desk"))
  for (const desk of agentDesks(owner, config, home)) {
    if (desk.present) servers[desk.server] = deskMcpServerConfig(desk.root, runFrom)
    else missing.push(desk.server)
  }
  emitNervesEvent({
    level: missing.length > 0 ? "warn" : "info",
    event: "desk.servers_listed",
    component: "repertoire",
    message: missing.length > 0 ? "some desks this agent looks after are not on this machine" : "listed the agent's Desk servers",
    meta: { agentName, servers: Object.keys(servers), missing },
  })
  return servers
}
