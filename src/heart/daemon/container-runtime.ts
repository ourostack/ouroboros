import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"

export interface ContainerRuntimePolicy { scheduler: "supercronic"; updates: "disabled"; product?: string }

/**
 * The product module an image may name (`product`): an absolute path to a built .js file inside the image. The image's
 * build chooses it and the file is root-owned, so the agent's own files never choose which code loads.
 */
export function isProductModulePath(value: unknown): value is string {
  return typeof value === "string" && /^\/opt\/[a-z0-9][a-z0-9/_.-]*\.js$/u.test(value) && !value.split("/").includes("..")
}

/** Whether a parsed container runtime policy is exactly the locked policy: scheduler and updates, and optionally product. */
export function isContainerRuntimePolicy(value: unknown): value is ContainerRuntimePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  const keys = Object.keys(policy).sort().join(",")
  if (keys !== "scheduler,updates" && keys !== "product,scheduler,updates") return false
  return policy.scheduler === "supercronic" && policy.updates === "disabled" && (policy.product === undefined || isProductModulePath(policy.product))
}

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
  const value: unknown = JSON.parse(raw)
  if (!isContainerRuntimePolicy(value)) throw new Error("container runtime policy is invalid")
  emitNervesEvent({ component: "daemon", event: "daemon.container_runtime_policy_loaded", message: "container runtime policy loaded", meta: { scheduler: value.scheduler, updates: value.updates, product: value.product ?? null } })
  return value.product === undefined ? { scheduler: "supercronic", updates: "disabled" } : { scheduler: "supercronic", updates: "disabled", product: value.product }
}
