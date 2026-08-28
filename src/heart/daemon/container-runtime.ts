import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"

export interface ContainerRuntimePolicy { scheduler: "supercronic"; updates: "disabled" }

export function hasManagedAgentProcess(processArguments: string, agent: string): boolean {
  const wanted = agent.trim()
  if (!wanted) return false
  const matches = processArguments.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/u)
    const entryIndex = fields.findIndex((field) => field === "/opt/ouro/dist/heart/agent-entry.js")
    const agentIndex = fields.findIndex((field) => field === "--agent")
    return entryIndex >= 0 && agentIndex >= 0 && fields[agentIndex + 1] === wanted
  })
  return matches.length === 1
}

export function hasManagedTelegramProcess(processArguments: string, agent: string): boolean {
  const wanted = agent.trim()
  if (!wanted) return false
  const matches = processArguments.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/u)
    const entryIndex = fields.findIndex((field) => field === "/opt/ouro/dist/senses/telegram-entry.js")
    const agentIndex = fields.findIndex((field) => field === "--agent")
    return entryIndex >= 0 && agentIndex >= 0 && fields[agentIndex + 1] === wanted
  })
  return matches.length === 1
}

export function hasManagedSupercronicProcess(processArguments: string, agent: string): boolean {
  const expected = [
    "/usr/local/bin/supercronic",
    "-split-logs",
    "-inotify",
    `/home/ouro/.ouro-cli/scheduler/${agent}.crontab`,
  ]
  const matches = processArguments.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/u)
    return fields.length === expected.length && fields.every((field, index) => field === expected[index])
  })
  return matches.length === 1
}

export function readContainerRuntimePolicy(options: { path?: string; readFile?: (path: string) => string } = {}): ContainerRuntimePolicy | null {
  const filePath = options.path ?? "/opt/ouro/container-runtime.json"
  const readFile = options.readFile ?? ((target: string) => fs.readFileSync(target, "utf8"))
  let raw: string
  try { raw = readFile(filePath) }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  const value = JSON.parse(raw) as Record<string, unknown>
  if (value.scheduler !== "supercronic" || value.updates !== "disabled" || Object.keys(value).sort().join(",") !== "scheduler,updates") {
    throw new Error("container runtime policy is invalid")
  }
  emitNervesEvent({ component: "daemon", event: "daemon.container_runtime_policy_loaded", message: "container runtime policy loaded", meta: { scheduler: value.scheduler, updates: value.updates } })
  return { scheduler: "supercronic", updates: "disabled" }
}
