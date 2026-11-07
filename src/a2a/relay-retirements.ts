import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { RelayRegistration, RelayRetirements } from "./relay-inbox"

function markerFile(agentRoot: string, registration: RelayRegistration): string {
  const key = createHash("sha256").update(`${registration.relayUrl}\n${registration.handle}`).digest("hex")
  return path.join(agentRoot, "state", "a2a", "relay-retired", `${key}.json`)
}

/**
 * Retirements of a previous relay registration that are done at the relay but not yet saved to the vault, kept on disk
 * under `state/a2a/relay-retired/` so they survive a restart. A marker holds no credentials, only the relay URL and
 * handle, under a name hashed from both. It is written to a temporary name and renamed into place.
 */
export function fileRelayRetirements(agentRoot: string): RelayRetirements {
  return {
    isPending: (registration) => fs.existsSync(markerFile(agentRoot, registration)),
    markPending: (registration) => {
      const file = markerFile(agentRoot, registration)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify({ relayUrl: registration.relayUrl, handle: registration.handle, retiredAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      fs.renameSync(temp, file)
    },
    clear: (registration) => fs.rmSync(markerFile(agentRoot, registration), { force: true }),
  }
}
