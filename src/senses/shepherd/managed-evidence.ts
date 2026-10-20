import { createHash } from "node:crypto"
import type { ShepherdManagedIdentity, ShepherdManagedInputReceipt } from "../../heart/shepherd/custody-types"

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value === value.trim() &&
  Buffer.byteLength(value, "utf8") <= 256 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)

export function validManagedIdentity(value: unknown): value is ShepherdManagedIdentity {
  return record(value) && Object.keys(value).length === 12 && value.kind === "agent_session" &&
    uuid(value.hostInstance) && uuid(value.workspaceId) && uuid(value.surfaceId) &&
    (value.provider === "copilot" || value.provider === "claude" || value.provider === "codex") &&
    text(value.providerSessionId) && counter(value.backendPid) && value.backendPid > 0 && value.backendPid <= 2_147_483_647 &&
    counter(value.backendStartSeconds) && counter(value.backendStartMicroseconds) && value.backendStartMicroseconds < 1_000_000 &&
    counter(value.surfaceGeneration) && digest(value.executableSha256) && digest(value.profileSha256)
}

export function copyManagedIdentity(value: ShepherdManagedIdentity): ShepherdManagedIdentity {
  const { kind, hostInstance, workspaceId, surfaceId, provider, providerSessionId, backendPid, backendStartSeconds,
    backendStartMicroseconds, surfaceGeneration, executableSha256, profileSha256 } = value
  return { kind, hostInstance, workspaceId, surfaceId, provider, providerSessionId, backendPid, backendStartSeconds,
    backendStartMicroseconds, surfaceGeneration, executableSha256, profileSha256 }
}

export function sameManagedIdentity(left: ShepherdManagedIdentity, right: ShepherdManagedIdentity): boolean {
  return JSON.stringify(copyManagedIdentity(left)) === JSON.stringify(copyManagedIdentity(right))
}

export function managedInstanceKey(value: ShepherdManagedIdentity): string {
  return `agent_session:${createHash("sha256").update(JSON.stringify(copyManagedIdentity(value))).digest("hex")}`
}

export function validManagedReceipt(value: unknown): value is ShepherdManagedInputReceipt {
  return record(value) && value.kind === "agent_session" && value.receiptVersion === 1 && text(value.requestId) &&
    uuid(value.nativeRequestId) && validManagedIdentity(value.identity) &&
    typeof value.editorInserted === "boolean" && typeof value.backendWriteAdmitted === "boolean" &&
    typeof value.providerAcknowledged === "boolean" && (value.providerInputId === null || text(value.providerInputId)) &&
    value.providerAcknowledged === (value.providerInputId !== null) &&
    (!value.backendWriteAdmitted || value.editorInserted) && (!value.providerAcknowledged || value.backendWriteAdmitted)
}

export function copyManagedReceipt(value: ShepherdManagedInputReceipt): ShepherdManagedInputReceipt {
  const { kind, receiptVersion, requestId, nativeRequestId, identity, editorInserted, backendWriteAdmitted,
    providerAcknowledged, providerInputId } = value
  return { kind, receiptVersion, requestId, nativeRequestId, identity: copyManagedIdentity(identity), editorInserted,
    backendWriteAdmitted, providerAcknowledged, providerInputId }
}
