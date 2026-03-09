import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "child_process"
import * as fs from "fs"

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

function buildPrompt(request: CodingSessionRequest, deps: Required<Pick<SpawnCodingDeps, "existsSync" | "readFileSync">>): string {
  const sections: string[] = []

  sections.push(
    [
      "Coding session metadata:",
      `sessionId: ${request.sessionId ?? "pending"}`,
      `parentAgent: ${request.parentAgent ?? "unknown"}`,
      `taskRef: ${request.taskRef ?? "unassigned"}`,
    ].join("\n"),
  )

  if (request.stateFile && deps.existsSync(request.stateFile)) {
    const stateContent = deps.readFileSync(request.stateFile, "utf-8").trim()
    if (stateContent.length > 0) {
      sections.push(`State file (${request.stateFile}):\n${stateContent}`)
    }
  }

  sections.push(request.prompt)
  return sections.join("\n\n---\n\n")
}

export function spawnCodingProcess(request: CodingSessionRequest, deps: SpawnCodingDeps = {}): SpawnCodingResult {
  const spawnFn = deps.spawnFn ?? ((command, args, options) => nodeSpawn(command, args, options) as unknown as CodingProcess)
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? fs.readFileSync

  const prompt = buildPrompt(request, { existsSync, readFileSync })
  const { command, args } = buildCommandArgs(request.runner, request.workdir)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_spawn_start",
    message: "spawning coding session process",
    meta: { runner: request.runner, workdir: request.workdir },
  })

  const proc = spawnFn(command, args, {
    cwd: request.workdir,
    stdio: ["pipe", "pipe", "pipe"],
  })

  proc.stdin.write(`${prompt}\n`)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_spawn_end",
    message: "spawned coding session process",
    meta: { runner: request.runner, pid: proc.pid ?? null },
  })

  return { process: proc, command, args, prompt }
}
