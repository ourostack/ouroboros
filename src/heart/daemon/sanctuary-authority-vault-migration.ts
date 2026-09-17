import {
  refreshMachineRuntimeCredentialConfig, refreshRuntimeCredentialConfig,
  upsertMachineRuntimeCredentialConfig, upsertRuntimeCredentialConfig,
} from "../runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"

interface TokenIdentity { token: string; botId: string; ownerUserId: string; ownerChatId: string }

function identity(value: unknown): TokenIdentity {
  const candidate = value as TokenIdentity | null
  if (!candidate || typeof candidate.token !== "string" || !/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/u.test(candidate.token)
    || candidate.token.split(":")[0] !== candidate.botId || !/^[1-9][0-9]*$/u.test(candidate.ownerUserId)
    || candidate.ownerUserId !== candidate.ownerChatId) throw new Error("Sanctuary vault token identity is invalid")
  return candidate
}

async function readOwners(): Promise<Record<string, unknown>[]> {
  const results = [
    await refreshRuntimeCredentialConfig("sanctuary"),
    await refreshMachineRuntimeCredentialConfig("sanctuary", "sanctuary"),
  ]
  return results.map((result) => {
    if (result.ok) return result.config
    if (result.reason === "missing") return {}
    throw new Error("Sanctuary vault owner is unavailable")
  })
}

function absent(owners: Record<string, unknown>[]): { tokenAbsent: true } {
  if (owners.some((owner) => Object.hasOwn(owner, "telegramBotToken"))) throw new Error("Sanctuary resident token residue")
  return { tokenAbsent: true }
}

// Invoked only by the fixed root migration process, never by the resident daemon.
// Snapshot output travels through a private pipe to the root transaction, not logs.
export async function migrateSanctuaryAuthorityVault(operation: string, input?: unknown): Promise<unknown> {
  if (process.getuid!() !== 0 || process.getgid!() !== 0) throw new Error("Sanctuary vault migration requires root")
  if (!["snapshot", "presence", "absent", "remove", "restore"].includes(operation)) throw new Error("Sanctuary vault migration operation is invalid")
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_vault_handoff_requested", message: "Sanctuary vault handoff requested", meta: { operation } })
  const supplied = operation === "restore" ? identity(input) : null
  const owners = await readOwners()
  if (operation === "presence") return { tokenPresent: owners.some((owner) => Object.hasOwn(owner, "telegramBotToken")) }
  if (operation === "absent") return absent(owners)
  if (operation === "snapshot") {
    const merged = Object.assign({}, ...owners)
    const selected = identity({ token: merged.telegramBotToken, botId: String(merged.telegramBotToken).split(":")[0], ownerUserId: merged.telegramAuthorizedUserId, ownerChatId: merged.telegramAuthorizedChatId })
    for (const owner of owners) {
      for (const [field, expected] of [["telegramBotToken", selected.token], ["telegramAuthorizedUserId", selected.ownerUserId], ["telegramAuthorizedChatId", selected.ownerChatId]]) {
        if (Object.hasOwn(owner, field!) && owner[field!] !== expected) throw new Error("Sanctuary vault owner identity disagrees")
      }
    }
    return selected
  }
  const next = owners.map((owner) => {
    const copy = { ...owner }
    delete copy.telegramBotToken
    return copy
  })
  if (supplied) {
    next[0]!.telegramBotToken = supplied.token
    next[0]!.telegramAuthorizedUserId = supplied.ownerUserId
    next[0]!.telegramAuthorizedChatId = supplied.ownerChatId
  }
  // Full replacement is intentional here: merge cannot remove a credential.
  // Each replacement starts from a fresh read of its own canonical owner.
  await upsertRuntimeCredentialConfig("sanctuary", next[0]!)
  await upsertMachineRuntimeCredentialConfig("sanctuary", "sanctuary", next[1]!)
  const readback = await readOwners()
  if (!supplied) return absent(readback)
  absent([readback[1]!])
  if (readback[0]!.telegramBotToken !== supplied.token || readback[0]!.telegramAuthorizedUserId !== supplied.ownerUserId
    || readback[0]!.telegramAuthorizedChatId !== supplied.ownerChatId) throw new Error("Sanctuary vault token restoration readback failed")
  return { restored: true }
}
