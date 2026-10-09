/**
 * What the Butler is told about each container beyond what docker reports: the steward policy's desired state, and which house service a
 * container backs. A container the policy keeps stopped on purpose (the calibre desktop app) is not a fault, and "Books" is the calibre-web
 * container, so a question about Books is answered from calibre-web alone. Pure functions; the runtime wraps the model-facing container list.
 */
import type { StewardPolicyRecord } from "../heart/steward-policy"

/** House service name to the one container that is that service. */
export const SERVICE_CONTAINERS: Readonly<Record<string, string>> = { Books: "calibre-web" }

const WANTED_ON = new Set(["on", "always_on", "expected_on"])
const WANTED_OFF = /^(?:off|disabled|paused|intentionally_off|intentionally_paused)$/u

export const STOPPED_ON_PURPOSE_NOTE = "stopped on purpose by the steward policy; not needed by any running service; do not offer to start"

export type DesiredContainerState = "running" | "stopped"

/** The policy's current desired state for a container, or null when the policy says nothing (or the entry expired). */
export function desiredContainerState(policy: Pick<StewardPolicyRecord, "desiredStates"> | null, name: string, nowMs: number): DesiredContainerState | null {
  const entry = policy?.desiredStates[`container:${name}`]
  if (!entry) return null
  const expires = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN
  if (Number.isFinite(expires) && expires <= nowMs) return null
  const value = entry.value.trim().toLowerCase()
  if (WANTED_ON.has(value)) return "running"
  if (WANTED_OFF.test(value)) return "stopped"
  return null
}

/** Adds `desired`, `note` and `serves` to each container of an ok container-list result; any other result is returned unchanged. */
export function annotateContainers<T>(result: T, policy: Pick<StewardPolicyRecord, "desiredStates"> | null, nowMs: number): T {
  const value = result as { ok?: unknown; data?: { containers?: unknown } } | null
  if (!value || value.ok !== true || !Array.isArray(value.data?.containers)) return result
  const services = Object.entries(SERVICE_CONTAINERS)
  const containers = value.data.containers.map((entry) => {
    const item = entry as { name?: unknown; state?: unknown }
    const name = typeof item.name === "string" ? item.name : ""
    const desired = desiredContainerState(policy, name, nowMs)
    const service = services.find(([, container]) => container === name)?.[0]
    const running = item.state === "running"
    const note = desired === "stopped"
      ? (running ? "the steward policy wants this stopped but it is running; tell the owner, do not stop it yourself" : STOPPED_ON_PURPOSE_NOTE)
      : desired === "running" && !running ? "the steward policy wants this running but it is not" : undefined
    return { ...(entry as object), ...(desired ? { desired } : {}), ...(note ? { note } : {}), ...(service ? { serves: service } : {}) }
  })
  return { ...(result as object), data: { ...value.data, containers } } as T
}
