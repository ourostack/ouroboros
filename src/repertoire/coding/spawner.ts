import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { CodingRunner, CodingSessionRequest } from "./types"

export type CodingProcess = Pick<ChildProcessWithoutNullStreams, "pid" | "stdin" | "stdout" | "stderr" | "on" | "kill">

export interface SpawnCodingResult {
  process: CodingProcess
  command: string
  args: string[]
  prompt: string
}

export interface SpawnCodingDeps {
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => CodingProcess
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: "utf-8") => string
  homeDir?: string
  baseEnv?: NodeJS.ProcessEnv
}

function buildCommandArgs(runner: CodingRunner, workdir: string): { command: string; args: string[] } {
  if (runner === "claude") {
    return {
      command: "claude",
      args: [
        "-p",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--add-dir",
        workdir,
        "--output-format",
        "stream-json",
      ],
    }
  }

  return {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "--cd", workdir],
  }
}

function buildSpawnEnv(baseEnv: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  const binDir = path.join(homeDir, ".ouro-cli", "bin")
  const existingPath = baseEnv.PATH ?? ""
  const pathEntries = existingPath.split(path.delimiter).filter((entry) => entry.length > 0)
  if (!pathEntries.includes(binDir)) {
    pathEntries.unshift(binDir)
  }
  return {
    ...baseEnv,
    PATH: pathEntries.join(path.delimiter),
  }
}

function appendFileSection(
  sections: string[],
  label: string,
  filePath: string | undefined,
  deps: Required<Pick<SpawnCodingDeps, "existsSync" | "readFileSync">>,
): void {
  if (!filePath || !deps.existsSync(filePath)) return
  const content = deps.readFileSync(filePath, "utf-8").trim()
  if (content.length === 0) return
  sections.push(`${label} (${filePath}):\n${content}`)
}

function buildPrompt(request: CodingSessionRequest, deps: Required<Pick<SpawnCodingDeps, "existsSync" | "readFileSync">>): string {
  const sections: string[] = []

  sections.push(
    [
      "Execution contract:",
      "- You are a subordinate coding session launched by a parent Ouro agent.",
      "- Execute the concrete request in the supplied workdir directly.",
      "- Do not switch into planning/doing workflows, approval gates, or repo-management rituals unless the request explicitly asks for them.",
      "- Treat the request, scope file, and state file as the authoritative briefing for this session.",
      "- Prefer direct execution and verification over narration.",
    ].join("\n"),
  )

  sections.push(
    [
      "Coding session metadata:",
      `sessionId: ${request.sessionId ?? "pending"}`,
      `parentAgent: ${request.parentAgent ?? "unknown"}`,
      `taskRef: ${request.taskRef ?? "unassigned"}`,
    ].join("\n"),
  )

  appendFileSection(sections, "Scope file", request.scopeFile, deps)
  appendFileSection(sections, "State file", request.stateFile, deps)

  sections.push(request.prompt)
  return sections.join("\n\n---\n\n")
}

export function spawnCodingProcess(request: CodingSessionRequest, deps: SpawnCodingDeps = {}): SpawnCodingResult {
  const spawnFn = deps.spawnFn ?? ((command: string, args: string[], options: Record<string, unknown>) => nodeSpawn(command, args, options) as CodingProcess)
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  const homeDir = deps.homeDir ?? os.homedir()
  const baseEnv = deps.baseEnv ?? process.env

  const prompt = buildPrompt(request, { existsSync, readFileSync })
  const { command, args } = buildCommandArgs(request.runner, request.workdir)
  const env = buildSpawnEnv(baseEnv, homeDir)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_spawn_start",
    message: "spawning coding session process",
    meta: { runner: request.runner, workdir: request.workdir },
  })

  const proc = spawnFn(command, args, {
    cwd: request.workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  proc.stdin.end(`${prompt}\n`)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_spawn_end",
    message: "spawned coding session process",
    meta: { runner: request.runner, pid: proc.pid ?? null },
  })

  return { process: proc, command, args, prompt }
}
