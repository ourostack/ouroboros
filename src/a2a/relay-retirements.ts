import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import type { RelayRegistration, RelayRetirementRecord, RelayRetirements } from "./relay-inbox"

function markerKey(registration: RelayRegistration): string {
  return createHash("sha256").update(`${registration.relayUrl}\n${registration.handle}`).digest("hex")
}

function recordFrom(value: unknown): RelayRetirementRecord {
  const raw = value as { firstFailedAt?: unknown; retired?: unknown } | null
  return {
    ...(typeof raw?.firstFailedAt === "number" && Number.isFinite(raw.firstFailedAt) ? { firstFailedAt: raw.firstFailedAt } : {}),
    ...(raw?.retired === true ? { retired: true as const } : {}),
  }
}

/**
 * The retirement record of each previous relay registration (when attempts on it first failed, and whether it is done
 * at the relay), kept on disk under `state/a2a/relay-retired/` so it survives a restart. A record holds no
 * credentials, only the relay URL and handle, under a name hashed from both; it is written 0600 to a temporary name and
 * renamed into place. Records are also kept in memory, so a failed disk write still holds until the process stops.
 */
export function fileRelayRetirements(agentRoot: string): RelayRetirements {
  const dir = path.join(agentRoot, "state", "a2a", "relay-retired")
  const cache = new Map<string, RelayRetirementRecord>()
  const file = (key: string): string => path.join(dir, `${key}.json`)
  return {
    read: (registration) => {
      const key = markerKey(registration)
      const cached = cache.get(key)
      if (cached) return { ...cached }
      try {
        return recordFrom(JSON.parse(fs.readFileSync(file(key), "utf8")))
      } catch {
        return {}
      }
    },
    write: (registration, record) => {
      const key = markerKey(registration)
      cache.set(key, { ...record })
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temp = `${file(key)}.${randomBytes(6).toString("hex")}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify({ relayUrl: registration.relayUrl, handle: registration.handle, ...record, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      fs.renameSync(temp, file(key))
      emitNervesEvent({ component: "channels", event: "channel.a2a_relay_retirement_recorded", message: record.retired ? "an old relay registration is retired" : "an old relay registration is still being retired", meta: { relayUrl: registration.relayUrl, retired: record.retired === true } })
    },
    clear: (registration) => {
      const key = markerKey(registration)
      cache.delete(key)
      fs.rmSync(file(key), { force: true })
    },
  }
}
