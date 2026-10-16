import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

export function normalizeShepherdCheckInMinutes(value: unknown): number {
  if (value === undefined) return 60
  if (typeof value === "number" && Number.isInteger(value) && (value === 0 || value >= 30 && value <= 1440)) return value
  emitNervesEvent({
    level: "error", component: "config/identity", event: "config_identity.error",
    message: "agent config has invalid Shepherd check-in cadence", meta: { field: "senses.shepherd.checkInMinutes" },
  })
  throw new Error("senses.shepherd.checkInMinutes must be 0 or an integer from 30 through 1440")
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readShepherdCheckInMinutes(agentRoot: string): number {
  try {
    let value: unknown = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf8"))
    for (const key of ["senses", "shepherd"]) {
      if (!object(value)) throw new Error("agent.json has invalid Shepherd check-in config")
      value = value[key]
      if (value === undefined) return normalizeShepherdCheckInMinutes(undefined)
    }
    if (!object(value)) throw new Error("agent.json has invalid Shepherd check-in config")
    return normalizeShepherdCheckInMinutes(value.checkInMinutes)
  } catch (error) {
    emitNervesEvent({
      level: "error", component: "config/identity", event: "config_identity.error",
      message: "could not read Shepherd check-in configuration", meta: { operation: "read_check_in_config" },
    })
    throw error
  }
}
