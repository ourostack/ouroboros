import * as fs from "node:fs"
import * as path from "node:path"

import type { OuroCliDeps, RsvpCliCommand } from "../heart/daemon/cli-types"
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { importLegacyRsvpConfig } from "./config"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface RsvpCliPayload {
  ok: boolean
  command: RsvpCliCommand["kind"]
  sideEffect: boolean
  agent?: string
  mode?: string
  allowSend?: boolean
  requires?: string
  message: string
  inputs?: Record<string, JsonValue>
  result?: JsonValue
}

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

async function executeImportLegacy(command: Extract<RsvpCliCommand, { kind: "rsvp.config.import-legacy" | "rsvp.import-legacy" }>, deps: OuroCliDeps): Promise<RsvpCliPayload> {
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

function plannedPayload(command: RsvpCliCommand): RsvpCliPayload {
  switch (command.kind) {
    case "rsvp.doctor":
      return basePayload(command, false, "RSVP doctor command registered; full readiness checks run in the RSVP doctor unit", {
        inputs: { strict: command.strict === true },
      })
    case "rsvp.incident":
      return basePayload(command, false, "RSVP incident command registered; full incident bundle capture runs in the health unit")
    case "rsvp.cutover":
      return basePayload(command, false, "RSVP cutover command registered; full cutover orchestration runs in the cutover unit", {
        inputs: { legacyRoot: command.legacyRoot, action: command.action },
      })
    case "rsvp.legacy-render":
      return basePayload(command, false, "RSVP legacy render command registered; full legacy renderer runs in the parity unit", {
        inputs: { legacyRoot: command.legacyRoot },
      })
    case "rsvp.replay":
      return basePayload(command, false, "RSVP replay command registered; full deterministic replay runs in the replay unit", {
        inputs: { fixturePath: command.fixturePath },
      })
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
    case "rsvp.config.import-legacy":
    case "rsvp.import-legacy":
      throw new Error("import legacy is handled separately")
  }
}

export async function runRsvpCliCommand(command: RsvpCliCommand, deps: OuroCliDeps): Promise<string> {
  const payload = command.kind === "rsvp.config.import-legacy" || command.kind === "rsvp.import-legacy"
    ? await executeImportLegacy(command, deps)
    : plannedPayload(command)
  return writePayload(command, deps, payload)
}
