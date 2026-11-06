import { emitNervesEvent } from "../nerves/runtime"
import { mergeMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import type { RelayConfig, RelayConfigStore, RelayRegistration } from "./relay-inbox"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function registrationFrom(value: unknown): RelayRegistration | undefined {
  const r = record(value)
  const relayUrl = text(r?.relayUrl)
  const handle = text(r?.handle)
  const inboxAuth = text(r?.inboxAuth)
  const sendCredential = text(r?.sendCredential)
  return relayUrl && handle && inboxAuth && sendCredential ? { relayUrl, handle, inboxAuth, sendCredential } : undefined
}

/** The `a2a.relay` settings in a machine runtime config, keeping only well-formed fields. */
export function relayConfigFrom(config: Record<string, unknown>): RelayConfig {
  const relay = record(record(config.a2a)?.relay)
  if (!relay) return {}
  const url = text(relay.url)
  const inviteToken = text(relay.inviteToken)
  const registration = registrationFrom(relay.registration)
  const pending = record(relay.pendingRegistration)
  const pendingRelayUrl = text(pending?.relayUrl)
  const pendingHandle = text(pending?.handle)
  const previousRegistration = registrationFrom(relay.previousRegistration)
  return {
    ...(url ? { url } : {}),
    ...(inviteToken ? { inviteToken } : {}),
    ...(registration ? { registration } : {}),
    ...(pendingRelayUrl && pendingHandle ? { pendingRegistration: { relayUrl: pendingRelayUrl, handle: pendingHandle } } : {}),
    ...(previousRegistration ? { previousRegistration } : {}),
  }
}

/**
 * The relay settings, read from and written to this machine's runtime config in the vault (beside the A2A identity
 * seed). Every read goes to the vault, so a write decided on a fresh read (clearing the invite only if it is unchanged)
 * sees an operator's newer value. A patch merges into `a2a.relay`; a key set to `undefined` is dropped when the merged
 * config is serialized.
 */
export function vaultRelayConfigStore(agentName: string, machineId: string): RelayConfigStore {
  return {
    async read() {
      const result = await refreshMachineRuntimeCredentialConfig(agentName, machineId)
      if (result.ok) return relayConfigFrom(result.config)
      if (result.reason === "missing") return {}
      throw new Error(`cannot read the A2A relay settings at ${result.itemPath}: ${result.error}`)
    },
    async write(patch) {
      await mergeMachineRuntimeCredentialConfig(agentName, machineId, { a2a: { relay: patch } })
      emitNervesEvent({ component: "channels", event: "channel.a2a_relay_config_saved", message: "saved A2A relay settings to the vault", meta: { agentName, keys: Object.keys(patch) } })
    },
  }
}
