/**
 * The approval relay's request: what the Butler's harness hands Ari's primary agent's harness when it routes an
 * approval prompt with the relay switch on (design v3, flow step 1). It carries the relay token, so no model may ever
 * read it (security review C1c).
 *
 * - The payload is sealed and signed as a friends `message`, so it is confidential and tamper-evident over any
 *   transport, and the receiver opens it with `openChatMessage`, pinned to the Butler's DID.
 * - It travels in a harness-owned DataPart tagged `ouroKind: "approval_request"`. The sealed blob sits under `request`,
 *   not at the top of the part, so a receiver that doesn't know the tag finds no friends part there and refuses the
 *   message as malformed. It never opens it as a chat and shows the token to its model.
 */
import { sealEnvelope, keyAgreementFromDidKey, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { prepareMessage } from "@ouro.bot/friends"

import { emitNervesEvent } from "../nerves/runtime"
import { openChatMessage, type OpenChatMessageInput } from "./sealed-chat"
import type { A2AMessage, A2AMessagePart } from "./types"

export const APPROVAL_REQUEST_KIND = "approval_request"
/** The sealed text the peer's harness answers with once it holds the request. */
export const APPROVAL_REQUEST_ACCEPTED = "approval_request: accepted"
const PAYLOAD_TAG = "ouro.approval-request.v1"

/** Four characters from an alphabet without look-alikes (no 0, O, 1, I or L), so Ari can read and type it. */
export const RELAY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const CODE = new RegExp(`^[${RELAY_CODE_ALPHABET}]{4}$`)
const RELAY_TOKEN = /^[A-Za-z0-9_-]{16,128}$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
/** Shown to Ari as plain text: one line, capped, with no control or bidi characters. */
export const MAX_ACTION_LINE_CHARS = 300
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

export interface ApprovalRequestPayload {
  relayToken: string
  code: string
  actionLine: string
  /** Deny only in v1: Ari can say no from his phone and must tap to say yes. */
  decisions: ["deny"]
  expiresAt: string
}

/** True only for exactly the v1 payload's fields, each well formed. */
export function isApprovalRequestPayload(value: unknown): value is ApprovalRequestPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).sort().join(",") === "actionLine,code,decisions,expiresAt,relayToken"
    && typeof v.relayToken === "string" && RELAY_TOKEN.test(v.relayToken)
    && typeof v.code === "string" && CODE.test(v.code)
    && typeof v.actionLine === "string" && v.actionLine.trim().length > 0 && v.actionLine.length <= MAX_ACTION_LINE_CHARS && !UNSAFE_CHARS.test(v.actionLine)
    && Array.isArray(v.decisions) && v.decisions.length === 1 && v.decisions[0] === "deny"
    && typeof v.expiresAt === "string" && ISO.test(v.expiresAt) && Number.isFinite(Date.parse(v.expiresAt))
}

/** The Butler's prompt as one safe line: control and bidi characters become spaces, then it's trimmed and capped. */
export function approvalActionLine(prompt: string): string {
  const flat = prompt.replace(new RegExp(UNSAFE_CHARS.source, "gu"), " ").replace(/\s+/gu, " ").trim()
  const line = flat.length > 0 ? flat : "Approval request"
  return line.length > MAX_ACTION_LINE_CHARS ? `${line.slice(0, MAX_ACTION_LINE_CHARS - 1)}…` : line
}

/** A fresh code for one routed item. */
export function newRelayCode(randomBytes: (size: number) => Uint8Array): string {
  // 31 symbols: rejection sampling keeps every symbol equally likely.
  let code = ""
  while (code.length < 4) {
    for (const byte of randomBytes(8)) {
      if (code.length === 4) break
      if (byte < 248) code += RELAY_CODE_ALPHABET[byte % RELAY_CODE_ALPHABET.length]
    }
  }
  return code
}

/** Seal a request to the recipient and wrap it in the tagged part. Throws on a malformed payload. */
export function sealApprovalRequest(input: {
  sodium: Sodium
  from: DidKeyIdentity
  recipientDid: string
  recipientEd25519Pub: Uint8Array
  payload: ApprovalRequestPayload
}): { parts: A2AMessagePart[] } {
  if (!isApprovalRequestPayload(input.payload)) throw new Error("approval request payload is malformed")
  const prepared = prepareMessage({ fromAgentId: input.from.did, text: JSON.stringify({ [PAYLOAD_TAG]: input.payload }) })
  /* v8 ignore next -- the text is a short JSON object and the sender DID comes from a real identity @preserve */
  if (!prepared.ok) throw new Error(`cannot prepare approval request: ${prepared.status}`)
  const sealed = sealEnvelope({
    sodium: input.sodium,
    envelope: prepared.envelope as unknown as Record<string, unknown>,
    friendsKind: "message",
    fromIdentity: input.from,
    recipientDid: input.recipientDid,
    recipientX25519Pub: keyAgreementFromDidKey({ sodium: input.sodium, ed25519Pub: input.recipientEd25519Pub }),
  })
  emitNervesEvent({ component: "channels", event: "channel.a2a_approval_request_sealed", message: "sealed an approval request for the owner route", meta: { recipientDid: input.recipientDid } })
  return { parts: [{ kind: "data", data: { ouroKind: APPROVAL_REQUEST_KIND, recipientDid: input.recipientDid, request: { v: sealed.v, sealed: sealed.sealed } } }] as unknown as A2AMessagePart[] }
}

/** Whether a message is exactly one tagged approval-request part. */
export function isApprovalRequestMessage(message: A2AMessage): boolean {
  if (!Array.isArray(message.parts) || message.parts.length !== 1) return false
  const part = message.parts[0] as { kind?: unknown; data?: unknown } | undefined
  return !!part && part.kind === "data" && typeof part.data === "object" && part.data !== null
    && (part.data as { ouroKind?: unknown }).ouroKind === APPROVAL_REQUEST_KIND
}

export type OpenApprovalRequestResult =
  | { ok: true; payload: ApprovalRequestPayload; issuedAt: string }
  | { ok: false; reason: string }

/** Open a tagged request from the expected sender: the same `openChatMessage` path, then a strict payload check. */
export async function openApprovalRequest(input: Omit<OpenChatMessageInput, "message"> & { message: A2AMessage }): Promise<OpenApprovalRequestResult> {
  const refuse = (reason: string): OpenApprovalRequestResult => {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_approval_request_refused", message: "refused an approval request", meta: { senderDid: input.senderDid, reason } })
    return { ok: false, reason }
  }
  if (!isApprovalRequestMessage(input.message)) return refuse("not_an_approval_request")
  const data = (input.message.parts[0] as unknown as { data: { recipientDid?: unknown; request?: { v?: unknown; sealed?: unknown } } }).data
  if (typeof data.recipientDid !== "string" || !data.request || typeof data.request !== "object" || typeof data.request.v !== "number") return refuse("malformed_request")
  const friendsMessage = { ...input.message, parts: [{ kind: "data", data: { v: data.request.v, sealed: data.request.sealed, recipientDid: data.recipientDid } }] } as unknown as A2AMessage
  const opened = await openChatMessage({ ...input, message: friendsMessage })
  if (!opened.ok) return refuse(opened.reason)
  let payload: unknown
  try { payload = (JSON.parse(opened.text) as Record<string, unknown>)[PAYLOAD_TAG] } catch { payload = undefined }
  if (!isApprovalRequestPayload(payload)) return refuse("malformed_request")
  emitNervesEvent({ component: "channels", event: "channel.a2a_approval_request_opened", message: "opened a verified approval request", meta: { senderDid: input.senderDid } })
  return { ok: true, payload, issuedAt: opened.issuedAt }
}
