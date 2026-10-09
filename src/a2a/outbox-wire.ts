import type { FriendRecord } from "@ouro.bot/friends"
import { ready } from "@ouro.bot/friends/a2a-client"
import { holdsEscalation } from "./escalation-grants"
import { friendDid, verifyResolution } from "./resolution-proof"
import { FileOutboxStore, OUTBOX_LIST_MAX_LIMIT } from "./outbox-store"
import { resolveFailureReport } from "../heart/failure-reports"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The outbox methods ride the same sealed, signed chat envelope as `a2a message`: the request is a `message` whose
 * signed text is `{"ouro":"a2a-method","method":...,"params":...}`, posted under the JSON-RPC method of the same name.
 * The server verifies the sender exactly as it does for a chat (unseal, pinned key, signature, replay guard, friend
 * record), requires the signed method to equal the JSON-RPC method, and then decides access itself from the verified
 * friend record. A sender can only ever name its own outbox: no parameter selects another peer's.
 *
 *   outbox/list     { since?: string, limit?: number }  -> { entries, nextCursor, more }       any active friend, own outbox
 *   outbox/ack      { ids: string[] }                    -> { acked, unknown }                  any active friend, own outbox
 *   report/resolve  { id, version, note, resolvedAt, proof }             -> { id, status: "resolved" }          escalation holders, own reports
 */
export const OUTBOX_METHODS = ["outbox/list", "outbox/ack", "report/resolve"] as const
export type OutboxMethod = typeof OUTBOX_METHODS[number]

export const OUTBOX_ERROR_REFUSED = -32003
export const OUTBOX_ERROR_INVALID = -32602
const MAX_ACK_IDS = 100

export function isOutboxMethod(method: unknown): method is OutboxMethod {
  return typeof method === "string" && (OUTBOX_METHODS as readonly string[]).includes(method)
}

export function encodeOutboxCommand(method: OutboxMethod, params: Record<string, unknown>): string {
  return JSON.stringify({ ouro: "a2a-method", method, params })
}

export function parseOutboxCommand(text: string): { method: OutboxMethod; params: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const command = parsed as { ouro?: unknown; method?: unknown; params?: unknown }
  if (command.ouro !== "a2a-method" || !isOutboxMethod(command.method)) return null
  const params = command.params === undefined ? {} : command.params
  if (!params || typeof params !== "object" || Array.isArray(params)) return null
  return { method: command.method, params: params as Record<string, unknown> }
}

export type OutboxOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: number; message: string }

const refuse = (message: string): OutboxOutcome => ({ ok: false, code: OUTBOX_ERROR_REFUSED, message })
const invalid = (message: string): OutboxOutcome => ({ ok: false, code: OUTBOX_ERROR_INVALID, message })

/** Runs one verified outbox command for `friend`. `friend` must be the record found by the signed sender DID. */
export async function handleOutboxCommand(input: {
  agentRoot: string
  friend: FriendRecord | undefined
  method: OutboxMethod
  params: Record<string, unknown>
  now?: number
}): Promise<OutboxOutcome> {
  const { agentRoot, friend, method, params } = input
  if (!friend || friend.admissionState !== "active") {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_outbox_refused", message: "refused an outbox call from a peer that is not an active friend", meta: { method, friendId: friend?.id ?? null } })
    return refuse("only an active friend can use its outbox")
  }
  const outbox = new FileOutboxStore(agentRoot)
  if (method === "outbox/list") {
    const { since, limit } = params
    if (since !== undefined && typeof since !== "string") return invalid("since must be a string cursor")
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) return invalid("limit must be a number")
    return { ok: true, result: { ...outbox.list(friend.id, { ...(since !== undefined ? { since } : {}), ...(limit !== undefined ? { limit: Math.min(limit, OUTBOX_LIST_MAX_LIMIT) } : {}) }) } }
  }
  if (method === "outbox/ack") {
    const { ids } = params
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ACK_IDS || ids.some((id) => typeof id !== "string")) return invalid(`ids must be 1 to ${MAX_ACK_IDS} strings`)
    return { ok: true, result: { ...outbox.ack(friend.id, ids as string[]) } }
  }
  if (!holdsEscalation(agentRoot, friend)) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_report_resolve_refused", message: "refused report/resolve from a peer without the escalation grant", meta: { friendId: friend.id } })
    return refuse("report/resolve needs the escalation grant")
  }
  const { id, version, note, resolvedAt, proof } = params
  if (typeof id !== "string" || typeof version !== "string" || typeof note !== "string" || typeof resolvedAt !== "string") return invalid("id, version, note and resolvedAt must be strings")
  const checked = verifyResolution({ sodium: await ready(), claim: { reportId: id, version, note, resolvedAt }, proof, holderDid: friendDid(friend) })
  if (!checked.ok) return refuse(`report not resolved: the resolution is not signed by your key (${checked.reason})`)
  const resolved = await resolveFailureReport(agentRoot, { id, version, note, byFriendId: friend.id, resolvedAt, proof }, input.now)
  return resolved.ok ? { ok: true, result: { id: resolved.id, status: resolved.status } } : refuse(`report not resolved: ${resolved.reason}`)
}
