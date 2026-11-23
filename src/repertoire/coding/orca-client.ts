import { execFile } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"

// Orca's CLI (https://github.com/stablyai/orca) is how Ouro starts and drives coding agents that a
// person can see: each one gets an Orca worktree and a terminal tab. Every call here runs
// `orca <command> --json` and reads the `{ ok, result | error }` reply Orca prints.

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown

export interface OrcaCliOptions {
  executablePath?: string
  homeDir?: string
  existsSync?: (target: string) => boolean
  execFileFn?: ExecFileFn
  timeoutMs?: number
  launchTimeoutMs?: number
}

export interface OrcaWorktree {
  id: string
  path: string
  branch?: string
  isMainWorktree?: boolean
}

export interface OrcaLaunch {
  worktree: OrcaWorktree
  terminalHandle: string
  promptDelivered: boolean | null
  detail: string | null
}

export interface OrcaTerminal {
  handle: string
  tabId?: string
  leafId?: string
  agentIdentity?: string
  connected?: boolean
  lastOutputAt?: number
}

export interface OrcaTerminalRead {
  status: "running" | "exited" | "unknown"
  tail: string
}

export interface OrcaAgent {
  agent?: string
  state?: string
  paneKey?: string
  lastAssistantMessage?: string
  updatedAt?: number
}

export class OrcaCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "OrcaCliError"
  }
}

const APP_BINARY = path.join("Orca.app", "Contents", "Resources", "bin", "orca")

/** The orca binary: the app bundle's copy when installed (a daemon's PATH often lacks it), else `orca` on PATH. */
export function resolveOrcaExecutable(options: Pick<OrcaCliOptions, "homeDir" | "existsSync"> = {}): string {
  const existsSync = options.existsSync ?? fs.existsSync
  const homeDir = options.homeDir ?? os.homedir()
  const candidates = [path.join("/Applications", APP_BINARY), path.join(homeDir, "Applications", APP_BINARY)]
  return candidates.find((candidate) => existsSync(candidate)) ?? "orca"
}

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseReply(command: string, stdout: string, execError: Error | null, stderr: string): Json {
  let reply: Json | null = null
  try {
    reply = asRecord(JSON.parse(stdout))
  } catch {
    reply = null
  }
  if (reply && reply.ok === true) return asRecord(reply.result)
  const error = asRecord(reply?.error)
  const code = asString(error.code) ?? (execError ? "orca-cli-failed" : "orca-bad-reply")
  const message = asString(error.message) ?? (stderr.trim() || execError?.message || `orca ${command} printed no JSON reply`)
  throw new OrcaCliError(`orca ${command}: ${message}`, code)
}

function worktreeFrom(value: unknown): OrcaWorktree {
  const record = asRecord(value)
  const id = asString(record.id)
  const worktreePath = asString(record.path)
  if (!id || !worktreePath) throw new OrcaCliError("orca reply carried no worktree id and path", "orca-bad-reply")
  return {
    id,
    path: worktreePath,
    branch: asString(record.branch)?.replace(/^refs\/heads\//, ""),
    isMainWorktree: record.isMainWorktree === true,
  }
}

function launchFrom(result: Json, worktree: OrcaWorktree): OrcaLaunch {
  const launch = asRecord(result.launch ?? result)
  const outcome = asRecord(launch.outcome)
  const handle = asString(outcome.handle) ?? asString(result.agentTerminalHandle)
  if (!handle) throw new OrcaCliError("orca started no terminal agent (no launch.outcome.handle in its reply)", "orca-no-terminal")
  const promptOutcome = asString(asRecord(launch.prompt).outcome)
  return {
    worktree,
    terminalHandle: handle,
    // Orca's AgentLaunchPromptReceipt: journaled | handed-to-terminal | not-delivered | unconfirmed.
    promptDelivered: promptOutcome === "not-delivered"
      ? false
      : promptOutcome === "journaled" || promptOutcome === "handed-to-terminal" ? true : null,
    detail: asString(asRecord(launch.receipt).detail) ?? null,
  }
}

export class OrcaCli {
  readonly executablePath: string
  private readonly execFileFn: ExecFileFn
  private readonly timeoutMs: number
  private readonly launchTimeoutMs: number

  constructor(options: OrcaCliOptions = {}) {
    this.executablePath = options.executablePath ?? resolveOrcaExecutable(options)
    this.execFileFn = options.execFileFn ?? (execFile as unknown as ExecFileFn)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.launchTimeoutMs = options.launchTimeoutMs ?? 180_000
  }

  run(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<Json> {
    const command = args.slice(0, 2).join(" ")
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.orca_cli_call",
      message: "running orca CLI command",
      meta: { command },
    })
    return new Promise((resolve, reject) => {
      this.execFileFn(
        this.executablePath,
        [...args, "--json"],
        { cwd: options.cwd, timeout: options.timeoutMs ?? this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          try {
            resolve(parseReply(command, String(stdout ?? ""), error, String(stderr ?? "")))
          } catch (parseError) {
            reject(parseError)
          }
        },
      )
    })
  }

  /** The Orca worktree at `dir`, or null when Orca manages none there. */
  async showWorktree(dir: string): Promise<OrcaWorktree | null> {
    try {
      return worktreeFrom((await this.run(["worktree", "show", "--worktree", `path:${dir}`])).worktree)
    } catch {
      return null
    }
  }

  /** The id of the Orca repo checked out at `dir`, registering it with Orca first when Orca doesn't know it yet. */
  async ensureRepo(dir: string): Promise<string> {
    const listed = await this.run(["repo", "list"])
    const known = (Array.isArray(listed.repos) ? listed.repos : []).map(asRecord).find((repo) => repo.path === dir)
    const knownId = asString(known?.id)
    if (knownId) return knownId
    const added = await this.run(["repo", "add", "--path", dir])
    const addedId = asString(asRecord(added.repo).id) ?? asString(added.id)
    if (!addedId) throw new OrcaCliError(`orca repo add --path ${dir} named no repo id`, "orca-bad-reply")
    return addedId
  }

  /** A new Orca worktree off the repo at `repoDir`, with a terminal agent already given the prompt. */
  async createWorktreeWithAgent(input: { repoDir: string; repoId: string; name: string; agent: string; prompt: string }): Promise<OrcaLaunch> {
    const result = await this.run(
      ["worktree", "create", "--repo", `id:${input.repoId}`, "--name", input.name, "--no-parent", "--agent", input.agent, "--surface", "terminal", "--prompt", input.prompt],
      { cwd: input.repoDir, timeoutMs: this.launchTimeoutMs },
    )
    return launchFrom(result, worktreeFrom(result.worktree))
  }

  /** A terminal agent in an existing Orca worktree, already given the prompt. */
  async launchAgent(input: { worktree: OrcaWorktree; agent: string; prompt: string }): Promise<OrcaLaunch> {
    const result = await this.run(
      ["agent", "launch", "--worktree", `id:${input.worktree.id}`, "--agent", input.agent, "--surface", "terminal", "--prompt", input.prompt],
      { cwd: input.worktree.path, timeoutMs: this.launchTimeoutMs },
    )
    return launchFrom(result, input.worktree)
  }

  async listTerminals(worktreeId: string): Promise<OrcaTerminal[]> {
    const result = await this.run(["terminal", "list", "--worktree", `id:${worktreeId}`])
    return (Array.isArray(result.terminals) ? result.terminals : []).map((item) => asRecord(item) as unknown as OrcaTerminal)
  }

  async listAgents(worktreeId: string): Promise<OrcaAgent[]> {
    const result = await this.run(["agent", "list", "--worktree", `id:${worktreeId}`])
    return (Array.isArray(result.agents) ? result.agents : []).map((item) => asRecord(item) as OrcaAgent)
  }

  async readTerminal(handle: string, limit = 120): Promise<OrcaTerminalRead> {
    const terminal = asRecord((await this.run(["terminal", "read", "--terminal", handle, "--screen", "--limit", String(limit)])).terminal)
    const status = terminal.status === "running" || terminal.status === "exited" ? terminal.status : "unknown"
    const tail = Array.isArray(terminal.tail) ? terminal.tail.map(String).join("\n") : ""
    return { status, tail }
  }

  async sendText(handle: string, text: string): Promise<void> {
    await this.run(["terminal", "send", "--terminal", handle, "--text", text, "--enter"])
  }

  async closeTerminal(handle: string): Promise<void> {
    await this.run(["terminal", "close", "--terminal", handle, "--tab"])
  }
}
