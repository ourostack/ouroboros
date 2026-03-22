import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { spawnSync } from "child_process"

import { formatLiveWorldStateCheckpoint, type ActiveWorkFrame } from "../../heart/active-work"
import { getAgentName, getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { listSkills } from "../skills"
import type { CodingSession, CodingSessionRequest } from "./types"

const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md"]

export interface CodingContextPack {
  contextKey: string
  scopeFile: string
  stateFile: string
  scopeContent: string
  stateContent: string
}

export interface CodingContextPackInput {
  request: CodingSessionRequest
  existingSessions?: CodingSession[]
  activeWorkFrame?: ActiveWorkFrame
}

interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface CodingContextPackDeps {
  agentRoot?: string
  agentName?: string
  nowIso?: () => string
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: "utf-8") => string
  writeFileSync?: (target: string, content: string, encoding: "utf-8") => void
  mkdirSync?: (target: string, options: { recursive?: boolean }) => void
  listSkills?: () => string[]
  runCommand?: (command: string, args: string[], cwd: string) => CommandResult
}

interface RepoSnapshot {
  available: boolean
  repoRoot: string | null
  branch: string | null
  head: string | null
  statusLines: string[]
}

interface ContextFile {
  path: string
  content: string
}

function defaultRunCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
  })

  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  }
}

function stableContextKey(request: CodingSessionRequest): string {
  const payload = JSON.stringify({
    runner: request.runner,
    workdir: request.workdir,
    taskRef: request.taskRef ?? "",
    parentAgent: request.parentAgent ?? "",
    obligationId: request.obligationId ?? "",
    originSession: request.originSession ?? null,
  })
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 12)
}

function collectProjectContextFiles(
  workdir: string,
  deps: Required<Pick<CodingContextPackDeps, "existsSync" | "readFileSync">>,
): ContextFile[] {
  const files: ContextFile[] = []
  const seen = new Set<string>()

  let current = path.resolve(workdir)
  const root = path.parse(current).root

  while (true) {
    for (const filename of CONTEXT_FILENAMES) {
      const candidate = path.join(current, filename)
      if (!deps.existsSync(candidate) || seen.has(candidate)) continue
      try {
        const content = deps.readFileSync(candidate, "utf-8").trim()
        if (content.length > 0) {
          files.unshift({ path: candidate, content })
          seen.add(candidate)
        }
      } catch {
        // Best-effort loading only.
      }
    }

    if (current === root) break
    current = path.dirname(current)
  }

  return files
}

function captureRepoSnapshot(
  workdir: string,
  runCommand: (command: string, args: string[], cwd: string) => CommandResult,
): RepoSnapshot {
  const repoRoot = runCommand("git", ["rev-parse", "--show-toplevel"], workdir)
  if (repoRoot.status !== 0) {
    return {
      available: false,
      repoRoot: null,
      branch: null,
      head: null,
      statusLines: [],
    }
  }

  const branch = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], workdir)
  const head = runCommand("git", ["rev-parse", "--short", "HEAD"], workdir)
  const status = runCommand("git", ["status", "--short"], workdir)

  return {
    available: true,
    repoRoot: repoRoot.stdout.trim() || null,
    branch: branch.status === 0 ? branch.stdout.trim() || null : null,
    head: head.status === 0 ? head.stdout.trim() || null : null,
    statusLines: status.status === 0
      ? status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
      : [],
  }
}

function formatContextFiles(files: ContextFile[]): string {
  if (files.length === 0) return "(none found)"
  return files.map((file) => `### ${file.path}\n${file.content}`).join("\n\n")
}

function formatSkills(skills: string[]): string {
  return skills.length > 0 ? skills.join(", ") : "(none found)"
}

function formatExistingSessions(sessions: CodingSession[]): string {
  if (sessions.length === 0) return "activeSessions: none"
  return sessions
    .map((session) => {
      return [
        `- ${session.id}`,
        `status=${session.status}`,
        `lastActivityAt=${session.lastActivityAt}`,
        session.taskRef ? `taskRef=${session.taskRef}` : null,
        session.checkpoint ? `checkpoint=${session.checkpoint}` : null,
        session.artifactPath ? `artifact=${session.artifactPath}` : null,
      ].filter(Boolean).join(" ")
    })
    .join("\n")
}

function formatOrigin(request: CodingSessionRequest): string {
  if (!request.originSession) return "originSession: none"
  return `originSession: ${request.originSession.channel}/${request.originSession.key} (${request.originSession.friendId})`
}

function buildScopeContent(
  request: CodingSessionRequest,
  contextFiles: ContextFile[],
  skills: string[],
  agentName: string,
): string {
  return [
    "# Coding Session Scope",
    "",
    "## Request",
    `runner: ${request.runner}`,
    `taskRef: ${request.taskRef ?? "unassigned"}`,
    `parentAgent: ${request.parentAgent ?? agentName}`,
    `workdir: ${request.workdir}`,
    formatOrigin(request),
    `obligationId: ${request.obligationId ?? "none"}`,
    "",
    "## Prompt",
    request.prompt,
    "",
    "## Session Contract",
    "- This is a focused coding lane opened by the parent Ouro agent.",
    "- Execute the concrete prompt in the supplied workdir directly.",
    "- Do not switch into planning/doing workflows or approval gates unless the prompt explicitly asks for them.",
    "- Treat the current prompt, scope file, and live world-state checkpoint in the state file as the authoritative briefing for this lane.",
    "",
    "## Project Context Files",
    formatContextFiles(contextFiles),
    "",
    "## Available Bundle Skills",
    formatSkills(skills),
  ].join("\n")
}

function buildStateContent(
  request: CodingSessionRequest,
  contextKey: string,
  generatedAt: string,
  snapshot: RepoSnapshot,
  existingSessions: CodingSession[],
  agentName: string,
  activeWorkFrame?: ActiveWorkFrame,
): string {
  const gitSection = snapshot.available
    ? [
        `repoRoot: ${snapshot.repoRoot ?? "unknown"}`,
        `branch: ${snapshot.branch ?? "unknown"}`,
        `head: ${snapshot.head ?? "unknown"}`,
        "status:",
        snapshot.statusLines.length > 0 ? snapshot.statusLines.join("\n") : "(clean)",
      ].join("\n")
    : "git: unavailable"

  return [
    "# Coding Session State",
    `generatedAt: ${generatedAt}`,
    `contextKey: ${contextKey}`,
    `agent: ${request.parentAgent ?? agentName}`,
    formatOrigin(request),
    `obligationId: ${request.obligationId ?? "none"}`,
    "",
    "## Workspace Snapshot",
    gitSection,
    ...(activeWorkFrame ? ["", formatLiveWorldStateCheckpoint(activeWorkFrame)] : []),
    "",
    "## Related Coding Sessions",
    formatExistingSessions(existingSessions),
  ].join("\n")
}

function relatedSessions(
  request: CodingSessionRequest,
  existingSessions: CodingSession[],
): CodingSession[] {
  return existingSessions.filter((session) => {
    return session.runner === request.runner
      && session.workdir === request.workdir
      && session.taskRef === request.taskRef
  })
}

export function prepareCodingContextPack(
  input: CodingContextPackInput,
  deps: CodingContextPackDeps = {},
): CodingContextPack {
  const agentRoot = deps.agentRoot ?? getAgentRoot()
  const agentName = deps.agentName ?? getAgentName()
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const existsSync = deps.existsSync ?? fs.existsSync
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const listAvailableSkills = deps.listSkills ?? listSkills
  const runCommand = deps.runCommand ?? defaultRunCommand

  const contextKey = stableContextKey(input.request)
  const contextDir = path.join(agentRoot, "state", "coding", "context")
  const scopeFile = path.join(contextDir, `${contextKey}-scope.md`)
  const stateFile = path.join(contextDir, `${contextKey}-state.md`)

  const contextFiles = collectProjectContextFiles(input.request.workdir, { existsSync, readFileSync })
  const skills = listAvailableSkills()
  const existingSessions = relatedSessions(input.request, input.existingSessions ?? [])
  const snapshot = captureRepoSnapshot(input.request.workdir, runCommand)
  const generatedAt = nowIso()

  const scopeContent = buildScopeContent(input.request, contextFiles, skills, agentName)
  const stateContent = buildStateContent(
    input.request,
    contextKey,
    generatedAt,
    snapshot,
    existingSessions,
    agentName,
    input.activeWorkFrame,
  )

  mkdirSync(contextDir, { recursive: true })
  writeFileSync(scopeFile, `${scopeContent}\n`, "utf-8")
  writeFileSync(stateFile, `${stateContent}\n`, "utf-8")

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_context_pack_written",
    message: "prepared coding session context pack",
    meta: {
      contextKey,
      workdir: input.request.workdir,
      taskRef: input.request.taskRef ?? null,
      contextFiles: contextFiles.length,
      skills: skills.length,
      relatedSessions: existingSessions.length,
      gitAvailable: snapshot.available,
    },
  })

  return {
    contextKey,
    scopeFile,
    stateFile,
    scopeContent,
    stateContent,
  }
}
