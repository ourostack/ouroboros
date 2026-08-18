import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"

export interface ContainerRuntimePolicy { scheduler: "supercronic"; updates: "disabled" }

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
