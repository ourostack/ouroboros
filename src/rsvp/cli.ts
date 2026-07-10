import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { OuroCliDeps, RsvpCliCommand } from "../heart/daemon/cli-types"
import { runDoctorChecks } from "../heart/daemon/doctor"
import type { DoctorDeps } from "../heart/daemon/doctor-types"
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { importLegacyRsvpConfig } from "./config"
import { runRsvpCutover } from "./cutover"
import { buildRsvpIncidentBundle, writeRsvpIncidentBundle, type RsvpIncidentBundle } from "./incident-bundle"
import { renderLegacyRsvpSnapshotOffline, replayRsvpFixture } from "./replay"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface RsvpCliPayload {
  ok: boolean
  command: RsvpCliCommand["kind"]
  sideEffect: boolean
  agent?: string
  mode?: string
  action?: string
  legacyRoot?: string
  allowSend?: boolean
  requires?: string
  message: string
  inputs?: Record<string, JsonValue>
  result?: JsonValue
  doctor?: JsonValue
  incidentBundle?: JsonValue
  replay?: JsonValue
  checks?: Record<string, JsonValue>
  sendAllowed?: boolean
  denialReasons?: string[]
  rollback?: Record<string, JsonValue>
}

type RsvpImportLegacyCommand = Extract<RsvpCliCommand, { kind: "rsvp.config.import-legacy" | "rsvp.import-legacy" }>
type RsvpCutoverCommand = Extract<RsvpCliCommand, { kind: "rsvp.cutover" }>
type RsvpDoctorCommand = Extract<RsvpCliCommand, { kind: "rsvp.doctor" }>
type RsvpIncidentCommand = Extract<RsvpCliCommand, { kind: "rsvp.incident" }>
type RsvpLegacyRenderCommand = Extract<RsvpCliCommand, { kind: "rsvp.legacy-render" }>
type RsvpReplayCommand = Extract<RsvpCliCommand, { kind: "rsvp.replay" }>
type RsvpExecutedCommand =
  | RsvpImportLegacyCommand
  | RsvpCutoverCommand
  | RsvpDoctorCommand
  | RsvpIncidentCommand
  | RsvpLegacyRenderCommand
  | RsvpReplayCommand
type RsvpPlannedCommand = Exclude<RsvpCliCommand, RsvpExecutedCommand>

function commandJson(command: RsvpCliCommand): boolean {
  return "json" in command && command.json === true
}

function commandOutputPath(command: RsvpCliCommand): string | undefined {
  return "outputPath" in command ? command.outputPath : undefined
}

function commandAgent(command: RsvpCliCommand): string | undefined {
  return "agent" in command ? command.agent : undefined
}

function commandMode(command: RsvpCliCommand): string | undefined {
  return "mode" in command ? command.mode : undefined
}

function maybeAgentRoot(command: RsvpCliCommand, deps: OuroCliDeps): string | undefined {
  const agent = commandAgent(command)
  if (!agent) return undefined
  return deps.agentBundleRoot ?? path.join(deps.bundlesRoot ?? getAgentBundlesRoot(), `${agent}.ouro`)
}

function writeJsonFile(filePath: string, payload: RsvpCliPayload): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8")
}

function textSummary(payload: RsvpCliPayload): string {
  const effect = payload.sideEffect ? "explicit side effects enabled" : "dry run"
  const agent = payload.agent ? ` agent=${payload.agent}` : ""
  const requires = payload.requires ? ` requires=${payload.requires}` : ""
  return `${payload.command}: ${effect}${agent}${requires}`
}

function writePayload(command: RsvpCliCommand, deps: OuroCliDeps, payload: RsvpCliPayload): string {
  const outputPath = commandOutputPath(command)
  if (outputPath) writeJsonFile(outputPath, payload)
  const text = commandJson(command) ? JSON.stringify(payload, null, 2) : textSummary(payload)
  deps.writeStdout(text)
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.cli_command_executed",
    message: "executed RSVP CLI command",
    meta: {
      command: payload.command,
      sideEffect: payload.sideEffect,
      outputPath,
      agent: payload.agent,
    },
  })
  return text
}

function writeIncidentText(deps: OuroCliDeps, command: RsvpIncidentCommand, bundle: RsvpIncidentBundle, outputPath?: string): string {
  const text = command.json === true
    ? JSON.stringify({
        ok: bundle.doctor.summary.failed === 0,
        command: command.kind,
        agent: command.agent,
        sideEffect: false,
        incidentBundle: bundle as unknown as JsonValue,
      }, null, 2)
    : `rsvp.incident: wrote side-effect-free bundle${command.agent ? ` agent=${command.agent}` : ""}${outputPath ? ` output=${outputPath}` : ""}`
  deps.writeStdout(text)
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.cli_command_executed",
    message: "executed RSVP CLI command",
    meta: {
      command: command.kind,
      sideEffect: false,
      outputPath,
      agent: command.agent,
    },
  })
  return text
}

function basePayload(
  command: RsvpCliCommand,
  sideEffect: boolean,
  message: string,
  extra: Omit<Partial<RsvpCliPayload>, "ok" | "command" | "sideEffect" | "message"> = {},
): RsvpCliPayload {
  return {
    ok: true,
    command: command.kind,
    sideEffect,
    ...(commandAgent(command) ? { agent: commandAgent(command) } : {}),
    ...(commandMode(command) ? { mode: commandMode(command) } : {}),
    message,
    ...extra,
  }
}

async function executeImportLegacy(command: RsvpImportLegacyCommand, deps: OuroCliDeps): Promise<RsvpCliPayload> {
  if (!command.yes) {
    return basePayload(command, false, "legacy RSVP import preview only; pass --yes to write native config and runtime/config", {
      requires: "--yes",
      inputs: {
        legacyRoot: command.legacyRoot,
        mode: command.mode,
      },
    })
  }

  const agentRoot = maybeAgentRoot(command, deps)
  if (!command.agent || !agentRoot) {
    return {
      ok: false,
      command: command.kind,
      sideEffect: false,
      message: "legacy RSVP import requires --agent <name>",
      requires: "--agent",
    }
  }

  const result = await importLegacyRsvpConfig({
    agent: command.agent,
    agentRoot,
    legacyRoot: command.legacyRoot,
    mode: command.mode,
    confirm: true,
  })

  return basePayload(command, true, result.ok ? "legacy RSVP config imported" : result.message, {
    result: result as unknown as JsonValue,
  })
}

async function executeCutover(command: RsvpCutoverCommand, deps: OuroCliDeps): Promise<RsvpCliPayload> {
  const result = await runRsvpCutover({
    ...(command.agent ? { agent: command.agent } : {}),
    legacyRoot: command.legacyRoot,
    action: command.action,
    yes: command.yes === true,
    ...(deps.rsvpCutoverDeps ? { deps: deps.rsvpCutoverDeps } : {}),
  })

  return {
    ok: result.ok,
    command: command.kind,
    sideEffect: result.sideEffect,
    ...(command.agent ? { agent: command.agent } : {}),
    action: result.action,
    legacyRoot: result.legacyRoot,
    message: result.message,
    ...(result.requires ? { requires: result.requires } : {}),
    checks: result.checks as unknown as Record<string, JsonValue>,
    sendAllowed: result.sendAllowed,
    denialReasons: result.denialReasons,
    rollback: result.rollback as unknown as Record<string, JsonValue>,
  }
}

function doctorDepsFor(deps: OuroCliDeps): DoctorDeps {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  return {
    existsSync: (filePath: string) => fs.existsSync(filePath),
    readFileSync: (filePath: string) => fs.readFileSync(filePath, "utf-8"),
    readdirSync: (dirPath: string) => fs.readdirSync(dirPath),
    statSync: (filePath: string) => fs.statSync(filePath),
    checkSocketAlive: deps.checkSocketAlive,
    fetchImpl: deps.fetchImpl ?? fetch,
    socketPath: deps.socketPath,
    bundlesRoot,
    daemonLogsDir: path.join(deps.homeDir ?? os.homedir(), ".ouro-cli", "daemon", "logs"),
    homedir: deps.homeDir ?? os.homedir(),
    envPath: process.env.PATH ?? "",
    platform: process.platform,
    ...(deps.rsvpCutoverDeps ? { rsvpCutoverDeps: deps.rsvpCutoverDeps } : {}),
  }
}

async function executeDoctor(command: RsvpDoctorCommand, deps: OuroCliDeps): Promise<RsvpCliPayload> {
  const doctor = await runDoctorChecks(doctorDepsFor(deps), { category: "RSVP" })
  const ok = doctor.summary.warnings === 0 && doctor.summary.failed === 0
  if (command.strict && !ok) deps.setExitCode?.(1)
  return basePayload(command, false, ok ? "RSVP doctor checks passed" : "RSVP doctor checks found issues", {
    ok,
    inputs: { strict: command.strict === true },
    doctor: doctor as unknown as JsonValue,
    strict: command.strict === true,
  } as Omit<Partial<RsvpCliPayload>, "ok" | "command" | "sideEffect" | "message">)
}

async function executeIncident(command: RsvpIncidentCommand, deps: OuroCliDeps): Promise<string> {
  const agentRoot = maybeAgentRoot(command, deps)
  if (!command.agent || !agentRoot) {
    return writePayload(command, deps, {
      ok: false,
      command: command.kind,
      sideEffect: false,
      message: "RSVP incident bundle requires --agent <name>",
      requires: "--agent",
    })
  }
  const diagnosticsDeps = {
    existsSync: (filePath: string) => fs.existsSync(filePath),
    readFileSync: (filePath: string) => fs.readFileSync(filePath, "utf-8"),
    readdirSync: (dirPath: string) => fs.readdirSync(dirPath),
    statSync: (filePath: string) => fs.statSync(filePath),
    checkSocketAlive: deps.checkSocketAlive,
    runDoctorChecks: () => runDoctorChecks(doctorDepsFor(deps), { category: "RSVP" }),
  }
  const outputPath = commandOutputPath(command)
  const bundle = outputPath
    ? (await writeRsvpIncidentBundle({ agent: command.agent, agentRoot, outputPath, deps: diagnosticsDeps })).bundle
    : await buildRsvpIncidentBundle({ agent: command.agent, agentRoot, deps: diagnosticsDeps })
  return writeIncidentText(deps, command, bundle, outputPath)
}

async function executeLegacyRender(command: RsvpLegacyRenderCommand, deps: OuroCliDeps): Promise<string> {
  const outputPath = command.outputPath ?? path.join(os.tmpdir(), `ouro-rsvp-legacy-render-${process.pid}-${Date.now()}.json`)
  const result = await renderLegacyRsvpSnapshotOffline({ legacyRoot: command.legacyRoot, outputPath })
  const text = command.json
    ? JSON.stringify({ ok: true, command: command.kind, sideEffect: false, result }, null, 2)
    : `rsvp.legacy-render: wrote side-effect-free render output=${outputPath}`
  deps.writeStdout(text)
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.cli_command_executed",
    message: "executed RSVP CLI command",
    meta: { command: command.kind, sideEffect: false, outputPath, agent: command.agent },
  })
  return text
}

async function executeReplay(command: RsvpReplayCommand): Promise<RsvpCliPayload> {
  const replay = await replayRsvpFixture({ fixturePath: command.fixturePath })
  return basePayload(command, false, "RSVP replay fixture executed offline", {
    replay: replay as unknown as JsonValue,
  })
}

function plannedPayload(command: RsvpPlannedCommand): RsvpCliPayload {
  switch (command.kind) {
    case "rsvp.habit.stage":
      return basePayload(command, false, "RSVP habit stage command registered; full habit write runs in the native habit unit", {
        inputs: { cadence: command.cadence, mode: command.mode },
      })
    case "rsvp.refresh":
      return basePayload(command, command.allowSend === true, "RSVP refresh command registered; full refresh/send path runs in the refresh unit", {
        allowSend: command.allowSend === true,
        inputs: { mode: command.mode, noSend: command.noSend === true },
      })
    case "rsvp.compare":
      return basePayload(command, false, "RSVP compare command registered; full parity comparison runs in the compare unit", {
        inputs: { nativePath: command.nativePath, legacyPath: command.legacyPath },
      })
    case "rsvp.smoke":
      return basePayload(command, command.allowSend === true, "RSVP smoke command registered; full smoke path runs in the smoke unit", {
        allowSend: command.allowSend === true,
        inputs: {
          mode: command.mode,
          surface: command.surface,
          question: command.question ?? null,
          replayOutputPath: command.replayOutputPath ?? null,
        },
      })
  }
}

export async function runRsvpCliCommand(command: RsvpCliCommand, deps: OuroCliDeps): Promise<string> {
  if (command.kind === "rsvp.incident") return executeIncident(command, deps)
  if (command.kind === "rsvp.legacy-render") return executeLegacyRender(command, deps)
  const payload = command.kind === "rsvp.config.import-legacy" || command.kind === "rsvp.import-legacy"
    ? await executeImportLegacy(command, deps)
    : command.kind === "rsvp.cutover"
      ? await executeCutover(command, deps)
      : command.kind === "rsvp.doctor"
        ? await executeDoctor(command, deps)
        : command.kind === "rsvp.replay"
          ? await executeReplay(command)
        : plannedPayload(command)
  return writePayload(command, deps, payload)
}
