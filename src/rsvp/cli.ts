import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { OuroCliDeps, RsvpCliCommand } from "../heart/daemon/cli-types"
import { runDoctorChecks } from "../heart/daemon/doctor"
import type { DoctorDeps } from "../heart/daemon/doctor-types"
import { getAgentBundlesRoot } from "../heart/identity"
import { loadOrCreateMachineIdentity } from "../heart/machine-identity"
import { refreshMachineRuntimeCredentialConfig, refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { createBlueBubblesClient } from "../senses/bluebubbles/client"
import type { BlueBubblesChatRef } from "../senses/bluebubbles/model"
import { fetchAislePlannerRsvps } from "./aisleplanner-client"
import { importLegacyRsvpConfig, readRsvpConfig, validateRsvpReadiness } from "./config"
import { runRsvpCutover } from "./cutover"
import { computeRsvpDelta, renderRsvpReport } from "./diff-renderer"
import { buildRsvpIncidentBundle, writeRsvpIncidentBundle, type RsvpIncidentBundle } from "./incident-bundle"
import { importLegacyRsvpState } from "./migration"
import { decideRsvpOutboundReport, recordRsvpOutboundAttempt } from "./outbound-state"
import { queryRsvpSnapshot } from "./query"
import { renderLegacyRsvpSnapshotOffline, replayRsvpFixture } from "./replay"
import { buildRsvpSnapshot, parseRsvpSnapshot, type RsvpSnapshot } from "./snapshot"

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
  migration?: JsonValue
  refresh?: JsonValue
  compare?: JsonValue
  answer?: string
  delivery?: JsonValue
  checks?: Record<string, JsonValue>
  sendAllowed?: boolean
  denialReasons?: string[]
  rollback?: Record<string, JsonValue>
  strict?: boolean
}

type RsvpImportLegacyCommand = Extract<RsvpCliCommand, { kind: "rsvp.config.import-legacy" | "rsvp.import-legacy" }>
type RsvpCutoverCommand = Extract<RsvpCliCommand, { kind: "rsvp.cutover" }>
type RsvpDoctorCommand = Extract<RsvpCliCommand, { kind: "rsvp.doctor" }>
type RsvpIncidentCommand = Extract<RsvpCliCommand, { kind: "rsvp.incident" }>
type RsvpLegacyRenderCommand = Extract<RsvpCliCommand, { kind: "rsvp.legacy-render" }>
type RsvpReplayCommand = Extract<RsvpCliCommand, { kind: "rsvp.replay" }>
type RsvpRefreshCommand = Extract<RsvpCliCommand, { kind: "rsvp.refresh" }>
type RsvpCompareCommand = Extract<RsvpCliCommand, { kind: "rsvp.compare" }>
type RsvpSmokeCommand = Extract<RsvpCliCommand, { kind: "rsvp.smoke" }>
type RsvpExecutedCommand =
  | RsvpImportLegacyCommand
  | RsvpCutoverCommand
  | RsvpDoctorCommand
  | RsvpIncidentCommand
  | RsvpLegacyRenderCommand
  | RsvpReplayCommand
  | RsvpRefreshCommand
  | RsvpCompareCommand
  | RsvpSmokeCommand
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

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
}

function fallbackReadRsvpConfig(agentRoot: string): ReturnType<typeof readRsvpConfig> {
  const configPath = path.join(agentRoot, "rsvp", "config.json")
  if (!fs.existsSync(configPath)) {
    return { ok: false, reason: "missing", path: configPath, message: "missing native RSVP config" }
  }
  try {
    return { ok: true, config: readJsonFile(configPath) as Extract<ReturnType<typeof readRsvpConfig>, { ok: true }>["config"], path: configPath }
  } catch {
    return { ok: false, reason: "malformed", path: configPath, message: "native RSVP config is not valid JSON" }
  }
}

function resolveRsvpConfig(agentRoot: string): ReturnType<typeof readRsvpConfig> {
  return readRsvpConfig(agentRoot) ?? fallbackReadRsvpConfig(agentRoot)
}

function rsvpStateRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "rsvp")
}

function latestSnapshotPath(agentRoot: string): string {
  return path.join(rsvpStateRoot(agentRoot), "snapshots", "latest.json")
}

function snapshotFilePath(agentRoot: string, snapshotId: string): string {
  return path.join(rsvpStateRoot(agentRoot), "snapshots", `${snapshotId}.json`)
}

function writeSnapshotFiles(agentRoot: string, snapshot: RsvpSnapshot): void {
  fs.mkdirSync(path.join(rsvpStateRoot(agentRoot), "snapshots"), { recursive: true })
  fs.writeFileSync(snapshotFilePath(agentRoot, snapshot.snapshotId), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8")
  fs.writeFileSync(latestSnapshotPath(agentRoot), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8")
}

function parseSnapshotFromFile(filePath: string): RsvpSnapshot {
  const result = parseRsvpSnapshot(readJsonFile(filePath))
  if (!result.ok) throw new Error(`invalid RSVP snapshot at ${filePath}: ${result.reason}`)
  return result.snapshot
}

function readBaselineSnapshot(agentRoot: string): RsvpSnapshot | null {
  const baselinePath = path.join(rsvpStateRoot(agentRoot), "baseline.json")
  if (!fs.existsSync(baselinePath)) return null
  const baseline = readJsonFile(baselinePath)
  const snapshotId = baseline && typeof baseline === "object" && !Array.isArray(baseline)
    ? (baseline as Record<string, unknown>).nativeSnapshotId
    : null
  return typeof snapshotId === "string" && fs.existsSync(snapshotFilePath(agentRoot, snapshotId))
    ? parseSnapshotFromFile(snapshotFilePath(agentRoot, snapshotId))
    : null
}

function readLatestSnapshot(agentRoot: string): RsvpSnapshot {
  return parseSnapshotFromFile(latestSnapshotPath(agentRoot))
}

function machineIdForCli(deps: OuroCliDeps): string {
  if (deps.homeDir || deps.bundlesRoot || deps.agentBundleRoot) {
    return "cli-test-machine"
  }
  return loadOrCreateMachineIdentity().machineId
}

function blueBubblesChatFor(config: { bluebubblesRoute: { chatGuid: string; chatIdentifier?: string } }): BlueBubblesChatRef {
  const sendTarget = config.bluebubblesRoute.chatIdentifier
    ? { kind: "chat_identifier" as const, value: config.bluebubblesRoute.chatIdentifier }
    : { kind: "chat_guid" as const, value: config.bluebubblesRoute.chatGuid }
  return {
    chatGuid: config.bluebubblesRoute.chatGuid,
    ...(config.bluebubblesRoute.chatIdentifier ? { chatIdentifier: config.bluebubblesRoute.chatIdentifier } : {}),
    displayName: "RSVP",
    isGroup: true,
    sessionKey: `bluebubbles:rsvp:${config.bluebubblesRoute.chatIdentifier ?? config.bluebubblesRoute.chatGuid}`,
    sendTarget,
    participantHandles: [],
  }
}

function normalizeDelivery(value: unknown): JsonValue {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    ...(typeof record.guid === "string" ? { guid: record.guid } : {}),
    ...(typeof record.messageGuid === "string" ? { guid: record.messageGuid, messageGuid: record.messageGuid } : {}),
  }
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

  if (command.kind === "rsvp.import-legacy") {
    const configResult = resolveRsvpConfig(agentRoot)
    if (!configResult.ok) {
      return {
        ok: false,
        command: command.kind,
        sideEffect: false,
        agent: command.agent,
        message: configResult.message,
        requires: "native RSVP config",
      }
    }
    const result = importLegacyRsvpState({
      agent: command.agent,
      agentRoot,
      legacyRoot: command.legacyRoot,
      weddingId: configResult.config.source.weddingId,
      eventId: configResult.config.source.eventId,
      importedAt: new Date().toISOString(),
    })
    return basePayload(command, true, result.ok ? "legacy RSVP state imported" : result.message, {
      migration: result as unknown as JsonValue,
    })
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

async function executeRefresh(command: RsvpRefreshCommand, deps: OuroCliDeps): Promise<RsvpCliPayload> {
  const agentRoot = maybeAgentRoot(command, deps)
  if (!command.agent || !agentRoot) {
    return {
      ok: false,
      command: command.kind,
      sideEffect: false,
      message: "RSVP refresh requires --agent <name>",
      requires: "--agent",
    }
  }
  const configResult = resolveRsvpConfig(agentRoot)
  if (!configResult.ok) {
    return basePayload(command, false, "RSVP refresh requires native RSVP config before live work can run", {
      requires: "native RSVP config",
      result: configResult as unknown as JsonValue,
    })
  }
  const runtimeConfig = await refreshRuntimeCredentialConfig(command.agent, { preserveCachedOnFailure: true })
  const machineRuntimeConfig = await refreshMachineRuntimeCredentialConfig(command.agent, machineIdForCli(deps), { preserveCachedOnFailure: true })
  const readiness = validateRsvpReadiness({
    agent: command.agent,
    agentRoot,
    config: configResult,
    runtimeConfig,
    machineRuntimeConfig,
  })
  const readinessOk = (readiness as { ok?: boolean }).ok === true || readiness.status === "ready"
  if (!readinessOk) {
    return {
      ok: false,
      command: command.kind,
      sideEffect: false,
      agent: command.agent,
      mode: command.mode,
      message: "RSVP refresh blocked by readiness checks",
      checks: { readiness: readiness as unknown as JsonValue },
    }
  }
  const credentials = "credentials" in readiness
    ? readiness.credentials
    : { username: "", password: "" }
  const fetched = await fetchAislePlannerRsvps({
    agent: command.agent,
    weddingId: configResult.config.source.weddingId,
    eventId: configResult.config.source.eventId,
    credentials,
    ...(deps.fetchImpl ? { fetchFn: deps.fetchImpl } : {}),
  })
  if (!fetched.ok) {
    return {
      ok: false,
      command: command.kind,
      sideEffect: false,
      agent: command.agent,
      mode: command.mode,
      message: fetched.message,
      result: fetched as unknown as JsonValue,
    }
  }

  const previousSnapshot = readBaselineSnapshot(agentRoot)
  const currentSnapshot = buildRsvpSnapshot({
    agent: command.agent,
    fetchedAt: fetched.fetchedAt,
    source: {
      kind: "aisleplanner",
      weddingId: configResult.config.source.weddingId,
      eventId: configResult.config.source.eventId,
      adapter: "aisleplanner-api-v1",
    },
    guests: fetched.guests,
    allGuests: fetched.allGuests,
    provenance: { kind: "live-fetch", fetchedBy: "ouro rsvp refresh" },
  })
  writeSnapshotFiles(agentRoot, currentSnapshot)
  const delta = computeRsvpDelta(previousSnapshot, currentSnapshot)
  const reportText = renderRsvpReport(delta)
  const outboundDecision = decideRsvpOutboundReport({ agentRoot, currentSnapshot, reportText })
  const sendAllowed = command.allowSend === true && outboundDecision.action === "send"
  let delivery: JsonValue | undefined
  if (sendAllowed) {
    const sent = await createBlueBubblesClient().sendText({
      chat: blueBubblesChatFor(configResult.config),
      text: reportText,
      tempGuid: outboundDecision.idempotencyKey,
    })
    delivery = normalizeDelivery(sent)
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot,
      reportText,
      bluebubblesRecord: {
        recordId: outboundDecision.idempotencyKey,
        status: "accepted",
        tempGuid: outboundDecision.idempotencyKey,
        ...((delivery as Record<string, unknown>).guid ? { messageGuid: String((delivery as Record<string, unknown>).guid) } : {}),
      },
      recordedAt: new Date().toISOString(),
    })
  }

  return basePayload(command, sendAllowed, "RSVP refresh completed", {
    allowSend: sendAllowed,
    sendAllowed,
    refresh: {
      snapshotId: currentSnapshot.snapshotId,
      reportText,
      outboundDecision: outboundDecision as unknown as JsonValue,
      ...(delivery ? { delivery } : {}),
    },
  })
}

async function executeCompare(command: RsvpCompareCommand): Promise<RsvpCliPayload> {
  if (!fs.existsSync(command.nativePath) || !fs.existsSync(command.legacyPath)) {
    return basePayload(command, false, "RSVP compare requires readable native and legacy snapshot files", {
      requires: "readable snapshots",
      inputs: { nativePath: command.nativePath, legacyPath: command.legacyPath },
    })
  }
  const nativeSnapshot = parseSnapshotFromFile(command.nativePath)
  const legacySnapshot = parseSnapshotFromFile(command.legacyPath)
  const delta = computeRsvpDelta(legacySnapshot, nativeSnapshot)
  const reportText = renderRsvpReport(delta)
  return basePayload(command, false, "RSVP native/legacy comparison completed", {
    compare: {
      nativeSnapshotId: nativeSnapshot.snapshotId,
      legacySnapshotId: legacySnapshot.snapshotId,
      reportText,
      delta: delta as unknown as JsonValue,
    },
  })
}

async function executeSmoke(command: RsvpSmokeCommand, deps: OuroCliDeps): Promise<RsvpCliPayload> {
  const agentRoot = maybeAgentRoot(command, deps)
  if (!command.agent || !agentRoot) {
    return {
      ok: false,
      command: command.kind,
      sideEffect: false,
      message: "RSVP smoke requires --agent <name>",
      requires: "--agent",
    }
  }
  const configResult = resolveRsvpConfig(agentRoot)
  if (!configResult.ok) {
    return basePayload(command, command.allowSend === true, "RSVP smoke requires native RSVP config before follow-up can run", {
      allowSend: command.allowSend === true,
      sendAllowed: false,
      requires: "native RSVP config",
      result: configResult as unknown as JsonValue,
    })
  }
  const snapshot = readLatestSnapshot(agentRoot)
  const question = command.question ?? "who is pending?"
  const answer = queryRsvpSnapshot(snapshot, { query: question })
  const sendAllowed = command.mode === "live" && command.allowSend === true
  let delivery: JsonValue | undefined
  if (sendAllowed) {
    const sent = await createBlueBubblesClient().sendText({
      chat: blueBubblesChatFor(configResult.config),
      text: answer.text,
    })
    delivery = normalizeDelivery(sent)
  }
  const payload = basePayload(command, sendAllowed, sendAllowed ? "RSVP live smoke completed" : "RSVP smoke preflight completed", {
    allowSend: sendAllowed,
    sendAllowed,
    answer: answer.text,
    result: answer as unknown as JsonValue,
    ...(delivery ? { delivery } : {}),
  })
  if (command.replayOutputPath) writeJsonFile(command.replayOutputPath, payload)
  return payload
}

function plannedPayload(command: RsvpPlannedCommand): RsvpCliPayload {
  switch (command.kind) {
    case "rsvp.habit.stage":
      return basePayload(command, false, "RSVP habit stage command registered; full habit write runs in the native habit unit", {
        inputs: { cadence: command.cadence, mode: command.mode },
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
          : command.kind === "rsvp.refresh"
            ? await executeRefresh(command, deps)
            : command.kind === "rsvp.compare"
              ? await executeCompare(command)
              : command.kind === "rsvp.smoke"
                ? await executeSmoke(command, deps)
                : plannedPayload(command)
  return writePayload(command, deps, payload)
}
