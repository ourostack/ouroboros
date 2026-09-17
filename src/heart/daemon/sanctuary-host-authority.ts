import { createHash, randomBytes, type KeyLike } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

import {
  readSessionTransaction,
  withImmediateSessionTurnLease,
  writeSessionTransaction,
} from "../../mind/session-transaction"
import {
  authorityArtifactDigest,
  canonicalAuthorityJson,
  signAuthorityPayload,
  verifyAuthorityPayload,
  type SignedAuthorityPayload,
} from "./sanctuary-authority-codec"
import type { TelegramTransportObservationV1 } from "./sanctuary-telegram-authority-gateway"
import type { FileSanctuaryAuthorityLedger } from "./sanctuary-authority-ledger"

const SCHEMA_VERSION = 1 as const
const PROPOSAL_DOMAIN = "ouro.sanctuary.host-proposal.v1"
const REGISTRATION_DOMAIN = "ouro.sanctuary.host-registration.v1"
const DECISION_DOMAIN = "ouro.sanctuary.host-decision.v1"
const PERMIT_DOMAIN = "ouro.sanctuary.host-permit.v1"
const RECEIPT_DOMAIN = "ouro.sanctuary.host-receipt.v1"
const RETIREMENT_DOMAIN = "ouro.sanctuary.host-retirement.v1"
const ROOT_HOST_PREFIX = "<b>OURO ROOT HOST APPROVAL</b>"
const APPROVAL_TTL_MS = 300_000
const MAX_TIMEOUT_MS = 900_000
const MAX_SCRIPT_BYTES = 2_048
const MAX_ARGUMENTS = 64
const MAX_ARGUMENT_BYTES = 512
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u
const SCRIPT_BYTES = /^[\x0a\x20-\x7e]+$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const DECIMAL_ID = /^[1-9][0-9]*$/u
const REGISTRATION_ID = /^hostreg-[A-Za-z0-9_-]{43}$/u
const CALLBACK_ID = /^[\x20-\x7e]{1,256}$/u
const INLINE_CODE_SWITCHES = new Set(["-c", "-e", "--eval", "--evaluate"])

export interface HostExecutableCommandV1 {
  kind: "executable"
  executable: string
  arguments: string[]
}

export interface HostScriptCommandV1 {
  kind: "script"
  interpreter: string
  arguments: string[]
  script: string
}

export type HostCommandV1 = HostExecutableCommandV1 | HostScriptCommandV1

export interface HostProposalRequestV1 {
  targetHost: string
  targetResource: string
  command: HostCommandV1
  workingDirectoryProfile: "host.root.v1"
  environmentProfile: "host.clean.v1"
  timeoutMs: number
  verification: null | {
    profile: string
    expectedStateDigest: string
  }
  ownerObservation: {
    digest: string
    updateId: number
    userId: string
    chatId: string
    messageId: string
  }
}

export interface HostProposalV1 extends HostProposalRequestV1 {
  expiresAt: string
}

export interface PreparedHostApproval {
  registrationId: string
  proposalDigest: string
  prompt: string
  expiresAt: string
  replyMarkup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
}

export interface HostDecisionInput {
  callbackQueryId: string
  callbackData: string
  telegramMessageId: number
  userId: string
  chatId: string
  callbackObservationDigest: string
  decidedAt: string
}

export interface SanctuaryHostAuthorityOptions {
  targetHost: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  keyId: string
  publicKeyDigest: string
  publicKey: KeyLike
  privateKey: KeyLike
  resolveOwnerObservation(input: {
    updateId: number
    observationDigest: string
  }): SignedAuthorityPayload<TelegramTransportObservationV1> | null
  now?: () => string
  nonce?: () => string
  beforeWrite?: () => void
}

interface PreparedRecord {
  schemaVersion: typeof SCHEMA_VERSION
  state: "prepared"
  registrationId: string
  proposal: HostProposalV1
  proposalDigest: string
  prompt: string
  promptDigest: string
  approveHandle: string
  denyHandle: string
  approveHandleDigest: string
  denyHandleDigest: string
  preparedAt: string
  expiresAt: string
  nonce: string
}

interface CommittedRecord extends Omit<PreparedRecord, "state"> {
  state: "committed" | "approved" | "denied" | "expired" | "permitted" | "executed" | "retired"
  telegramMessageId: number
  registration: SignedAuthorityPayload<Record<string, unknown>>
  callbackQueryId: string | null
  callbackObservationDigest: string | null
  decidedAt: string | null
  decision: SignedAuthorityPayload<Record<string, unknown>> | null
  permit: SignedAuthorityPayload<Record<string, unknown>> | null
  receipt: SignedAuthorityPayload<Record<string, unknown>> | null
  cardRevision: "committed" | "approved" | "denied" | "expired" | "executed_verified" | "executed_failed" | "executed_ambiguous" | "retired"
  cardRenderedRevision: "committed" | "approved" | "denied" | "expired" | "executed_verified" | "executed_failed" | "executed_ambiguous" | "retired"
}

interface OrphanedRecord extends Omit<PreparedRecord, "state" | "approveHandle" | "denyHandle"> {
  state: "orphaned"
  orphanedAt: string
}

type HostApprovalRecord = PreparedRecord | CommittedRecord | OrphanedRecord

const CARD_STATUS: Record<CommittedRecord["cardRevision"], string> = {
  committed: "Awaiting owner decision.",
  approved: "Approved. Root execution is pending.",
  denied: "Denied. This approval is consumed and cannot be reused.",
  expired: "Expired. This approval is consumed and cannot be reused.",
  executed_verified: "Execution completed and verification succeeded.",
  executed_failed: "Execution failed or was interrupted.",
  executed_ambiguous: "Execution finished, but verification is ambiguous.",
  retired: "Authority retired before execution. This permit is refused.",
}

interface HostAuthorityState {
  schemaVersion: typeof SCHEMA_VERSION
  records: Record<string, HostApprovalRecord>
  callbackIds: Record<string, string>
  messageIds: Record<string, string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  const instant = new Date(value)
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value
}

function printable(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && PRINTABLE_ASCII.test(value)
}

function absoluteExecutable(value: unknown): value is string {
  return printable(value, 512)
    && path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && !value.includes("/../")
    && !value.endsWith("/..")
}

function validArguments(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_ARGUMENTS
    && value.every((argument) => printable(argument, MAX_ARGUMENT_BYTES))
}

export function hasHostInlineCodeSwitch(arguments_: readonly string[], program: unknown): boolean {
  const name = typeof program === "string" ? path.posix.basename(program) : ""
  return arguments_.some((argument) => INLINE_CODE_SWITCHES.has(argument)
    || [...INLINE_CODE_SWITCHES].some((flag) => argument.startsWith(`${flag}=`))
    || /^-[A-Za-z]*c/u.test(argument)
    || (/^(node|nodejs)$/u.test(name) && (/^-[A-Za-z]*[ep]/u.test(argument) || /^--print(?:=|$)/u.test(argument)))
    || (name === "perl" && /^-[A-Za-z]*[eE]/u.test(argument))
    || (name === "ruby" && /^-[A-Za-z]*e/u.test(argument)))
}

function validateCommand(value: unknown): asserts value is HostCommandV1 {
  if (!isObject(value) || typeof value.kind !== "string") throw new Error("Sanctuary host command is invalid")
  if (value.kind === "executable") {
    if (
      !exactKeys(value, ["kind", "executable", "arguments"])
      || !absoluteExecutable(value.executable)
      || !validArguments(value.arguments)
      || hasHostInlineCodeSwitch(value.arguments, value.executable)
    ) {
      throw new Error("Sanctuary host executable command is invalid")
    }
    return
  }
  if (
    value.kind !== "script"
    || !exactKeys(value, ["kind", "interpreter", "arguments", "script"])
    || !absoluteExecutable(value.interpreter)
    || !validArguments(value.arguments)
    || hasHostInlineCodeSwitch(value.arguments, value.interpreter)
    || typeof value.script !== "string"
    || Buffer.byteLength(value.script, "utf8") === 0
    || Buffer.byteLength(value.script, "utf8") > MAX_SCRIPT_BYTES
    || !SCRIPT_BYTES.test(value.script)
    || value.script.split("\n").some((line) => line.endsWith(" "))
  ) {
    throw new Error("Sanctuary host script command is invalid")
  }
}

export function validateHostProposalRequest(value: unknown, expectedHost: string): asserts value is HostProposalRequestV1 {
  if (!isObject(value) || !exactKeys(value, [
    "targetHost",
    "targetResource",
    "command",
    "workingDirectoryProfile",
    "environmentProfile",
    "timeoutMs",
    "verification",
    "ownerObservation",
  ])) {
    throw new Error("Sanctuary host proposal is malformed")
  }
  if (
    value.targetHost !== expectedHost
    || !printable(value.targetResource, 256)
    || value.workingDirectoryProfile !== "host.root.v1"
    || value.environmentProfile !== "host.clean.v1"
    || !Number.isSafeInteger(value.timeoutMs)
    || (value.timeoutMs as number) < 1_000
    || (value.timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error("Sanctuary host proposal fields are invalid")
  }
  validateCommand(value.command)
  if (value.verification !== null) {
    if (
      !isObject(value.verification)
      || !exactKeys(value.verification, ["profile", "expectedStateDigest"])
      || value.verification.profile !== "file.digest.v1"
      || typeof value.verification.expectedStateDigest !== "string"
      || !DIGEST.test(value.verification.expectedStateDigest)
      || !absoluteExecutable(value.targetResource)
    ) {
      throw new Error("Sanctuary host verification is invalid")
    }
  }
  if (
    !isObject(value.ownerObservation)
    || !exactKeys(value.ownerObservation, ["digest", "updateId", "userId", "chatId", "messageId"])
    || typeof value.ownerObservation.digest !== "string"
    || !DIGEST.test(value.ownerObservation.digest)
    || !Number.isSafeInteger(value.ownerObservation.updateId)
    || (value.ownerObservation.updateId as number) < 0
    || typeof value.ownerObservation.userId !== "string"
    || !DECIMAL_ID.test(value.ownerObservation.userId)
    || typeof value.ownerObservation.chatId !== "string"
    || !DECIMAL_ID.test(value.ownerObservation.chatId)
    || typeof value.ownerObservation.messageId !== "string"
    || !DECIMAL_ID.test(value.ownerObservation.messageId)
  ) {
    throw new Error("Sanctuary host owner observation is invalid")
  }
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

export function hostProposalCommitment(proposal: HostProposalV1): string {
  return authorityArtifactDigest(PROPOSAL_DOMAIN, proposal)
}

function renderProposal(proposal: HostProposalV1, proposalDigest: string): string {
  const command = proposal.command.kind === "executable"
    ? [
        `<b>Executable:</b> <code>${html(proposal.command.executable)}</code>`,
        `<b>Arguments:</b> <code>${html(canonicalAuthorityJson(proposal.command.arguments))}</code>`,
      ]
    : [
        `<b>Interpreter:</b> <code>${html(proposal.command.interpreter)}</code>`,
        `<b>Arguments:</b> <code>${html(canonicalAuthorityJson(proposal.command.arguments))}</code>`,
        `<b>Complete script bytes:</b>\n<pre>${html(proposal.command.script)}</pre>`,
      ]
  return [
    ROOT_HOST_PREFIX,
    "",
    "<b>Effect:</b> unrestricted root, potentially destructive and persistent",
    "<b>Namespaces:</b> real Sanctuary host namespaces",
    `<b>Target:</b> ${html(proposal.targetHost)} / ${html(proposal.targetResource)}`,
    ...command,
    `<b>Working directory profile:</b> ${html(proposal.workingDirectoryProfile)} (resolved path <code>/</code>)`,
    `<b>Environment profile:</b> ${html(proposal.environmentProfile)}`,
    `<b>Timeout:</b> ${proposal.timeoutMs} ms`,
    `<b>Verification:</b> ${proposal.verification ? `${html(proposal.verification.profile)} / ${proposal.verification.expectedStateDigest}` : "none"}`,
    `<b>Proposal commitment:</b> <code>${proposalDigest}</code>`,
    "",
    "Approved uid-0 code can read or change this gateway, its token and signing key; escape process controls; survive the receipt; install persistence; and invalidate future authority. Approval prevents an unapproved start. It cannot contain malicious code after approval.",
  ].join("\n")
}

function initialState(): HostAuthorityState {
  return { schemaVersion: SCHEMA_VERSION, records: {}, callbackIds: {}, messageIds: {} }
}

function requireState(condition: boolean): void {
  if (!condition) throw new Error("Sanctuary host authority state is malformed")
}

function validateStoredProposal(value: unknown, expectedHost: string): asserts value is HostProposalV1 {
  requireState(isObject(value))
  const proposal = value as Record<string, unknown>
  requireState(exactKeys(proposal, [
    "targetHost",
    "targetResource",
    "command",
    "workingDirectoryProfile",
    "environmentProfile",
    "timeoutMs",
    "verification",
    "ownerObservation",
    "expiresAt",
  ]))
  const { expiresAt, ...request } = proposal
  validateHostProposalRequest(request, expectedHost)
  requireState(validTime(expiresAt))
}

function validateStoredArtifact(
  value: unknown,
  domain: string,
  options: SanctuaryHostAuthorityOptions,
): Record<string, unknown> {
  return verifyAuthorityPayload<Record<string, unknown>>({
    artifact: value,
    expectedDomain: domain,
    expectedKeyId: options.keyId,
    publicKey: options.publicKey,
  })
}

function validateStoredRecord(
  registrationId: string,
  value: unknown,
  options: SanctuaryHostAuthorityOptions,
): asserts value is HostApprovalRecord {
  requireState(REGISTRATION_ID.test(registrationId))
  requireState(isObject(value))
  const record = value as Record<string, unknown>
  requireState(typeof record.state === "string")
  const preparedKeys = [
    "schemaVersion",
    "state",
    "registrationId",
    "proposal",
    "proposalDigest",
    "prompt",
    "promptDigest",
    "approveHandle",
    "denyHandle",
    "approveHandleDigest",
    "denyHandleDigest",
    "preparedAt",
    "expiresAt",
    "nonce",
  ]
  const committedKeys = [
    ...preparedKeys,
    "telegramMessageId",
    "registration",
    "callbackQueryId",
    "callbackObservationDigest",
    "decidedAt",
    "decision",
    "permit",
    "receipt",
    "cardRevision",
    "cardRenderedRevision",
  ]
  if (record.state === "orphaned") {
    requireState(exactKeys(record, [...preparedKeys.filter((key) => key !== "approveHandle" && key !== "denyHandle"), "orphanedAt"]))
  } else if (record.state === "prepared") {
    requireState(exactKeys(record, preparedKeys))
  } else {
    requireState(["committed", "approved", "denied", "expired", "permitted", "executed", "retired"].includes(record.state as string))
    requireState(exactKeys(record, committedKeys))
  }
  requireState(record.schemaVersion === SCHEMA_VERSION)
  requireState(record.registrationId === registrationId)
  validateStoredProposal(record.proposal, options.targetHost)
  const proposal = record.proposal as HostProposalV1
  requireState(record.proposalDigest === hostProposalCommitment(proposal))
  requireState(record.prompt === renderProposal(proposal, record.proposalDigest as string))
  requireState(record.promptDigest === digestText(record.prompt as string))
  requireState(validTime(record.preparedAt))
  requireState(record.expiresAt === proposal.expiresAt)
  requireState(Date.parse(record.expiresAt as string) === Date.parse(record.preparedAt as string) + APPROVAL_TTL_MS)
  requireState(typeof record.nonce === "string")
  requireState(/^[A-Za-z0-9_-]{43}$/u.test(record.nonce as string))
  requireState(typeof record.approveHandleDigest === "string")
  requireState(typeof record.denyHandleDigest === "string")

  if (record.state === "orphaned") {
    requireState(validTime(record.orphanedAt))
    return
  }

  requireState(printable(record.approveHandle, 256))
  requireState(printable(record.denyHandle, 256))
  requireState(record.approveHandleDigest === digestText(record.approveHandle as string))
  requireState(record.denyHandleDigest === digestText(record.denyHandle as string))
  if (record.state === "prepared") return

  requireState(Number.isSafeInteger(record.telegramMessageId))
  requireState((record.telegramMessageId as number) > 0)
  const registration = validateStoredArtifact(record.registration, REGISTRATION_DOMAIN, options)
  requireState(registration.registrationId === registrationId)
  requireState(registration.proposalDigest === record.proposalDigest)
  requireState(registration.telegramMessageId === record.telegramMessageId)
  requireState(registration.targetHost === options.targetHost)
  requireState(registration.publicKeyDigest === options.publicKeyDigest)
  const validCardRevisions = Object.keys(CARD_STATUS)
  requireState(validCardRevisions.includes(record.cardRevision as string))
  requireState(validCardRevisions.includes(record.cardRenderedRevision as string))

  if (record.state === "committed") {
    requireState(record.callbackQueryId === null)
    requireState(record.callbackObservationDigest === null)
    requireState(record.decidedAt === null)
    requireState(record.decision === null)
    requireState(record.permit === null)
    requireState(record.receipt === null)
    requireState(record.cardRevision === record.state)
    return
  }

  if (record.state === "expired" && record.callbackQueryId === null) {
    requireState(record.callbackObservationDigest === null)
    requireState(record.decidedAt === null)
    requireState(record.decision === null)
    requireState(record.permit === null)
    requireState(record.receipt === null)
    requireState(record.cardRevision === "expired")
    return
  }

  requireState(printable(record.callbackQueryId, 256))
  requireState(typeof record.callbackObservationDigest === "string")
  requireState(DIGEST.test(record.callbackObservationDigest as string))
  requireState(validTime(record.decidedAt))
  const decision = validateStoredArtifact(record.decision, DECISION_DOMAIN, options)
  requireState(decision.registrationId === registrationId)
  requireState(decision.callbackQueryId === record.callbackQueryId)
  requireState(decision.callbackObservationDigest === record.callbackObservationDigest)
  requireState(decision.decidedAt === record.decidedAt)
  requireState(decision.decision === (record.state === "denied" ? "deny" : "approve"))

  if (record.state === "approved" || record.state === "denied" || record.state === "expired") {
    requireState(record.permit === null)
    requireState(record.receipt === null)
    requireState(record.cardRevision === (record.state === "expired" ? "expired" : record.state))
    return
  }

  const permit = validateStoredArtifact(record.permit, PERMIT_DOMAIN, options)
  requireState(permit.registrationId === registrationId)
  requireState(permit.targetHost === options.targetHost)
  requireState(permit.publicKeyDigest === options.publicKeyDigest)
  if (record.state === "permitted") {
    requireState(record.receipt === null)
    requireState(record.cardRevision === "approved")
    return
  }

  const receipt = validateStoredArtifact(record.receipt, record.state === "retired" ? RETIREMENT_DOMAIN : RECEIPT_DOMAIN, options)
  requireState(receipt.registrationId === registrationId)
  requireState(receipt.permitId === permit.permitId)
  requireState(receipt.permitDigest === authorityArtifactDigest(PERMIT_DOMAIN, permit))
  requireState(receipt.targetHost === options.targetHost)
  requireState(receipt.publicKeyDigest === options.publicKeyDigest)
  requireState(record.cardRevision === (record.state === "retired" ? "retired" : `executed_${String(receipt.state)}`))
}

function validateHostAuthorityState(value: unknown, options: SanctuaryHostAuthorityOptions): HostAuthorityState {
  requireState(isObject(value))
  const state = value as Record<string, unknown>
  requireState(exactKeys(state, ["schemaVersion", "records", "callbackIds", "messageIds"]))
  requireState(state.schemaVersion === SCHEMA_VERSION)
  requireState(isObject(state.records))
  requireState(isObject(state.callbackIds))
  requireState(isObject(state.messageIds))
  const records = state.records as Record<string, unknown>
  for (const [registrationId, record] of Object.entries(records)) {
    validateStoredRecord(registrationId, record, options)
  }
  const expectedCallbackIds: Record<string, string> = {}
  const expectedMessageIds: Record<string, string> = {}
  for (const [registrationId, record] of Object.entries(records as Record<string, HostApprovalRecord>)) {
    if ("telegramMessageId" in record) expectedMessageIds[String(record.telegramMessageId)] = registrationId
    if ("callbackQueryId" in record && record.callbackQueryId) expectedCallbackIds[record.callbackQueryId] = registrationId
  }
  requireState(canonicalAuthorityJson(state.callbackIds) === canonicalAuthorityJson(expectedCallbackIds))
  requireState(canonicalAuthorityJson(state.messageIds) === canonicalAuthorityJson(expectedMessageIds))
  return state as unknown as HostAuthorityState
}

export function sanctuaryHostAuthorityStatePath(agentRoot: string): string {
  return path.join(agentRoot, "authority", "host-authority.json")
}

export class FileSanctuaryHostAuthority {
  readonly #statePath: string
  readonly #options: SanctuaryHostAuthorityOptions

  constructor(agentRoot: string, options: SanctuaryHostAuthorityOptions) {
    if (!path.isAbsolute(agentRoot)) throw new Error("Sanctuary host authority root must be absolute")
    this.#statePath = sanctuaryHostAuthorityStatePath(agentRoot)
    this.#options = options
  }

  prepare(request: HostProposalRequestV1): PreparedHostApproval {
    const now = this.#now()
    validateHostProposalRequest(request, this.#options.targetHost)
    const proposal: HostProposalV1 = {
      ...request,
      expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
    }
    const observation = this.#options.resolveOwnerObservation({
      updateId: proposal.ownerObservation.updateId,
      observationDigest: proposal.ownerObservation.digest,
    })
    if (
      !observation
      || authorityArtifactDigest(observation.domain, observation.payload) !== proposal.ownerObservation.digest
      || observation.payload.targetHost !== this.#options.targetHost
      || observation.payload.botId !== this.#options.botId
      || observation.payload.publicKeyDigest !== this.#options.publicKeyDigest
      || !observation.payload.ownerEligible
      || observation.payload.userId !== this.#options.ownerUserId
      || observation.payload.chatId !== this.#options.ownerChatId
      || observation.payload.updateId !== proposal.ownerObservation.updateId
      || observation.payload.userId !== proposal.ownerObservation.userId
      || observation.payload.chatId !== proposal.ownerObservation.chatId
      || observation.payload.messageId !== proposal.ownerObservation.messageId
    ) {
      throw new Error("Sanctuary host owner observation is not root-authorized")
    }
    const proposalDigest = hostProposalCommitment(proposal)
    const registrationNonce = this.#nonce()
    const registrationId = `hostreg-${registrationNonce}`
    const approveHandle = `ouh:a:${this.#nonce()}`
    const denyHandle = `ouh:d:${this.#nonce()}`
    const prompt = renderProposal(proposal, proposalDigest)
    if (prompt.length > 4_096) throw new Error("Sanctuary host approval prompt is too large")
    const record: PreparedRecord = {
      schemaVersion: SCHEMA_VERSION,
      state: "prepared",
      registrationId,
      proposal,
      proposalDigest,
      prompt,
      promptDigest: digestText(prompt),
      approveHandle,
      denyHandle,
      approveHandleDigest: digestText(approveHandle),
      denyHandleDigest: digestText(denyHandle),
      preparedAt: now,
      expiresAt: proposal.expiresAt,
      nonce: registrationNonce,
    }
    this.#transaction((state) => {
      if (Object.values(state.records).some((record) =>
        record.state === "prepared" || record.state === "committed" || record.state === "approved" || record.state === "permitted")) {
        throw new Error("Sanctuary host approval is already active")
      }
      if (state.records[registrationId]) throw new Error("Sanctuary host registration id already exists")
      state.records[registrationId] = record
    })
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_host_approval_prepared", message: "Sanctuary host approval intent durably prepared", meta: { proposalDigest } })
    return {
      registrationId,
      proposalDigest,
      prompt,
      expiresAt: proposal.expiresAt,
      replyMarkup: {
        inline_keyboard: [[
          { text: "Approve root execution", callback_data: approveHandle },
          { text: "Deny", callback_data: denyHandle },
        ]],
      },
    }
  }

  commit(input: {
    registrationId: string
    telegramMessageId: number
  }): SignedAuthorityPayload<Record<string, unknown>> {
    if (
      !REGISTRATION_ID.test(input.registrationId)
      || !Number.isSafeInteger(input.telegramMessageId)
      || input.telegramMessageId <= 0
    ) {
      throw new Error("Sanctuary host registration commit is invalid")
    }
    let registration!: SignedAuthorityPayload<Record<string, unknown>>
    this.#transaction((state) => {
      const current = state.records[input.registrationId]
      if (!current || current.state !== "prepared") throw new Error("Sanctuary host registration is not prepared")
      if (state.messageIds[String(input.telegramMessageId)]) throw new Error("Sanctuary host approval message already exists")
      registration = signAuthorityPayload({
        domain: REGISTRATION_DOMAIN,
        keyId: this.#options.keyId,
        privateKey: this.#options.privateKey,
        payload: {
          targetHost: this.#options.targetHost,
          botId: this.#options.botId,
          targetResource: current.proposal.targetResource,
          registrationId: current.registrationId,
          proposalDigest: current.proposalDigest,
          ownerObservationDigest: current.proposal.ownerObservation.digest,
          ownerUpdateId: current.proposal.ownerObservation.updateId,
          ownerUserId: current.proposal.ownerObservation.userId,
          ownerChatId: current.proposal.ownerObservation.chatId,
          ownerMessageId: current.proposal.ownerObservation.messageId,
          command: current.proposal.command,
          workingDirectoryProfile: current.proposal.workingDirectoryProfile,
          environmentProfile: current.proposal.environmentProfile,
          timeoutMs: current.proposal.timeoutMs,
          verification: current.proposal.verification,
          prompt: current.prompt,
          promptDigest: current.promptDigest,
          displayedProposalDigest: current.proposalDigest,
          marker: ROOT_HOST_PREFIX,
          telegramMessageId: input.telegramMessageId,
          approveHandleDigest: current.approveHandleDigest,
          denyHandleDigest: current.denyHandleDigest,
          registeredAt: this.#now(),
          expiresAt: current.expiresAt,
          nonce: current.nonce,
          publicKeyDigest: this.#options.publicKeyDigest,
        },
      })
      const committed: CommittedRecord = {
        ...current,
        state: "committed",
        telegramMessageId: input.telegramMessageId,
        registration,
        callbackQueryId: null,
        callbackObservationDigest: null,
        decidedAt: null,
        decision: null,
        permit: null,
        receipt: null,
        cardRevision: "committed",
        cardRenderedRevision: "committed",
      }
      state.records[current.registrationId] = committed
      state.messageIds[String(input.telegramMessageId)] = current.registrationId
    })
    return registration
  }

  decide(input: HostDecisionInput): SignedAuthorityPayload<Record<string, unknown>> | null {
    if (
      !CALLBACK_ID.test(input.callbackQueryId)
      || !printable(input.callbackData, 256)
      || !Number.isSafeInteger(input.telegramMessageId)
      || input.telegramMessageId <= 0
      || input.userId !== this.#options.ownerUserId
      || input.chatId !== this.#options.ownerChatId
      || !DIGEST.test(input.callbackObservationDigest)
      || !validTime(input.decidedAt)
    ) {
      throw new Error("Sanctuary host decision is invalid")
    }
    let decision: SignedAuthorityPayload<Record<string, unknown>> | null = null
    this.#transaction((state) => {
      if (state.callbackIds[input.callbackQueryId]) throw new Error("Sanctuary host callback is already consumed")
      const registrationId = state.messageIds[String(input.telegramMessageId)]
      const current = registrationId ? state.records[registrationId] : null
      if (!current || !("approveHandle" in current)) throw new Error("Sanctuary host registration state changed")
      const approved = input.callbackData === current.approveHandle
      const denied = input.callbackData === current.denyHandle
      if (!approved && !denied) throw new Error("Sanctuary host callback handle is invalid")
      if (current.state !== "committed") return false
      if (Date.parse(input.decidedAt) > Date.parse(current.expiresAt)) throw new Error("Sanctuary host approval expired")
      const outcome = approved ? "approve" : "deny"
      decision = signAuthorityPayload({
        domain: DECISION_DOMAIN,
        keyId: this.#options.keyId,
        privateKey: this.#options.privateKey,
        payload: {
          targetHost: this.#options.targetHost,
          registrationId: current.registrationId,
          registrationDigest: authorityArtifactDigest(current.registration.domain, current.registration.payload),
          decision: outcome,
          callbackQueryId: input.callbackQueryId,
          callbackObservationDigest: input.callbackObservationDigest,
          decidedAt: input.decidedAt,
          nonce: this.#nonce(),
          publicKeyDigest: this.#options.publicKeyDigest,
        },
      })
      state.records[current.registrationId] = {
        ...current,
        state: approved ? "approved" : "denied",
        callbackQueryId: input.callbackQueryId,
        callbackObservationDigest: input.callbackObservationDigest,
        decidedAt: input.decidedAt,
        decision,
        cardRevision: approved ? "approved" : "denied",
      }
      state.callbackIds[input.callbackQueryId] = current.registrationId
    })
    return decision
  }

  reconcilePrepared(): string[] {
    const orphaned: string[] = []
    this.#transaction((state) => {
      const now = this.#now()
      for (const [registrationId, record] of Object.entries(state.records)) {
        if (record.state !== "prepared") continue
        const { approveHandle: _approveHandle, denyHandle: _denyHandle, ...safe } = record
        state.records[registrationId] = { ...safe, state: "orphaned", orphanedAt: now }
        orphaned.push(registrationId)
      }
    })
    return orphaned
  }

  // Caller has fenced ingress. Journal refusal intent in the registration before
  // reserving its replay tombstone, so interruption cannot turn it into execution.
  retireRegistrations(ledger: FileSanctuaryAuthorityLedger): string[] {
    this.reconcilePrepared()
    const pending: string[] = []
    this.#transaction((state) => {
      for (const [id, record] of Object.entries(state.records)) {
        if (record.state === "committed" || record.state === "approved") {
          state.records[id] = { ...record, state: "expired", cardRevision: "expired" }
        } else if (record.state === "permitted") {
          const permit = record.permit!
          if (ledger.read(String(permit.payload.permitId))) {
            pending.push(id)
            continue
          }
          const receipt = signAuthorityPayload({
            domain: RETIREMENT_DOMAIN, keyId: this.#options.keyId, privateKey: this.#options.privateKey,
            payload: {
              registrationId: id, permitId: permit.payload.permitId,
              permitDigest: authorityArtifactDigest(permit.domain, permit.payload),
              targetHost: this.#options.targetHost, publicKeyDigest: this.#options.publicKeyDigest,
              state: "refused", reason: "epoch_retired_before_reservation", retiredAt: this.#now(),
            },
          })
          state.records[id] = { ...record, state: "retired", cardRevision: "retired", receipt }
        }
      }
    })
    for (const record of Object.values(this.#read().records)) {
      if (record.state !== "retired") continue
      const permit = record.permit!
      const permitId = String(permit.payload.permitId)
      const permitDigest = authorityArtifactDigest(permit.domain, permit.payload)
      const outcomeDigest = authorityArtifactDigest(record.receipt!.domain, record.receipt!.payload)
      const retiredAt = String(record.receipt!.payload.retiredAt)
      const current = ledger.read(permitId)
      if (current && (current.permitDigest !== permitDigest || (current.state !== "reserved" && (current.state !== "refused" || current.outcomeDigest !== outcomeDigest)))) throw new Error("Sanctuary retired permit ledger changed")
      if (!current) ledger.reserve({ permitId, nonce: String(permit.payload.nonce), permitDigest, reservedAt: retiredAt })
      if (!current || current.state === "reserved") ledger.terminalize({ permitId, state: "refused", outcomeDigest, updatedAt: retiredAt })
    }
    return pending
  }

  issuePermit(input: {
    registrationId: string
    residentFriendId: string
    relationshipProfileId: string
    relationshipProfileVersion: number
    requestId: string
    sessionKey: string
    sessionEventId: string
    residentApprovalId: string
    stewardPolicy: null | {
      key: string
      version: number
      digest: string
    }
  }): SignedAuthorityPayload<Record<string, unknown>> {
    if (
      !isObject(input)
      || !exactKeys(input, [
        "registrationId",
        "residentFriendId",
        "relationshipProfileId",
        "relationshipProfileVersion",
        "requestId",
        "sessionKey",
        "sessionEventId",
        "residentApprovalId",
        "stewardPolicy",
      ])
      || !REGISTRATION_ID.test(input.registrationId)
      || !printable(input.residentFriendId, 512)
      || !printable(input.relationshipProfileId, 256)
      || !Number.isSafeInteger(input.relationshipProfileVersion)
      || input.relationshipProfileVersion < 1
      || !printable(input.requestId, 512)
      || !printable(input.sessionKey, 1_024)
      || !printable(input.sessionEventId, 512)
      || !printable(input.residentApprovalId, 512)
    ) {
      throw new Error("Sanctuary host permit correlation is invalid")
    }
    if (input.stewardPolicy !== null && (
      !isObject(input.stewardPolicy)
      || !exactKeys(input.stewardPolicy, ["key", "version", "digest"])
      || !printable(input.stewardPolicy.key, 256)
      || !Number.isSafeInteger(input.stewardPolicy.version)
      || input.stewardPolicy.version < 1
      || typeof input.stewardPolicy.digest !== "string"
      || !DIGEST.test(input.stewardPolicy.digest)
    )) {
      throw new Error("Sanctuary host permit steward policy is invalid")
    }
    let permit!: SignedAuthorityPayload<Record<string, unknown>>
    let issueWindowExpired = false
    this.#transaction((state) => {
      const current = state.records[input.registrationId]
      if (!current || current.state !== "approved" || !current.decision || !current.decidedAt || !current.callbackObservationDigest) {
        throw new Error("Sanctuary host approval state cannot issue a permit")
      }
      const issuedAt = this.#now()
      if (Date.parse(issuedAt) < Date.parse(current.decidedAt)) {
        throw new Error("Sanctuary host permit issue window expired")
      }
      if (Date.parse(issuedAt) > Date.parse(current.decidedAt) + 120_000) {
        state.records[current.registrationId] = { ...current, state: "expired", cardRevision: "expired" }
        issueWindowExpired = true
        return
      }
      const permitSeed = this.#nonce()
      const permitId = `permit-${permitSeed}`
      const permitNonce = createHash("sha256").update(`permit-nonce\0${permitSeed}`, "utf8").digest("hex")
      permit = signAuthorityPayload({
        domain: PERMIT_DOMAIN,
        keyId: this.#options.keyId,
        privateKey: this.#options.privateKey,
        payload: {
          targetHost: this.#options.targetHost,
          permitId,
          registrationId: current.registrationId,
          registrationDigest: authorityArtifactDigest(current.registration.domain, current.registration.payload),
          ownerUserId: this.#options.ownerUserId,
          ownerChatId: this.#options.ownerChatId,
          ownerObservationDigest: current.proposal.ownerObservation.digest,
          callbackObservationDigest: current.callbackObservationDigest,
          residentFriendId: input.residentFriendId,
          relationshipProfileId: input.relationshipProfileId,
          relationshipProfileVersion: input.relationshipProfileVersion,
          requestId: input.requestId,
          sessionKey: input.sessionKey,
          sessionEventId: input.sessionEventId,
          residentApprovalId: input.residentApprovalId,
          effectClass: "owner_approved_arbitrary_host",
          executionProfile: "host.owner_approved.v1",
          targetResource: current.proposal.targetResource,
          command: current.proposal.command,
          scriptDigest: current.proposal.command.kind === "script" ? digestText(current.proposal.command.script) : null,
          workingDirectoryProfile: current.proposal.workingDirectoryProfile,
          environmentProfile: current.proposal.environmentProfile,
          environmentProfileDigest: digestText(current.proposal.environmentProfile),
          timeoutMs: current.proposal.timeoutMs,
          stewardPolicy: input.stewardPolicy,
          verification: current.proposal.verification,
          issuedAt,
          expiresAt: new Date(Date.parse(issuedAt) + 120_000).toISOString(),
          nonce: permitNonce,
          publicKeyDigest: this.#options.publicKeyDigest,
        },
      })
      state.records[current.registrationId] = { ...current, state: "permitted", permit }
    })
    if (issueWindowExpired) throw new Error("Sanctuary host permit issue window expired")
    return permit
  }

  completeExecution(
    registrationId: string,
    receipt: SignedAuthorityPayload<Record<string, unknown>>,
  ): void {
    if (!REGISTRATION_ID.test(registrationId)) {
      throw new Error("Sanctuary host execution receipt is invalid")
    }

    const receiptPayload = verifyAuthorityPayload<Record<string, unknown>>({
      artifact: receipt,
      expectedDomain: RECEIPT_DOMAIN,
      expectedKeyId: this.#options.keyId,
      publicKey: this.#options.publicKey,
    })
    const receiptState = receiptPayload.state
    if (!["verified", "failed", "ambiguous"].includes(String(receiptState))) {
      throw new Error("Sanctuary host execution receipt state is invalid")
    }
    this.#transaction((state) => {
      const current = state.records[registrationId]
      if (!current || current.state !== "permitted" || !current.permit) {
        throw new Error("Sanctuary host execution state changed")
      }
      if (
        receiptPayload.targetHost !== this.#options.targetHost
        || receiptPayload.registrationId !== registrationId
        || receiptPayload.permitId !== current.permit.payload.permitId
        || receiptPayload.permitDigest !== authorityArtifactDigest(current.permit.domain, current.permit.payload)
        || receiptPayload.publicKeyDigest !== this.#options.publicKeyDigest
        || !validTime(receiptPayload.startedAt)
        || !validTime(receiptPayload.completedAt)
        || Date.parse(receiptPayload.completedAt) < Date.parse(receiptPayload.startedAt)
      ) {
        throw new Error("Sanctuary host execution receipt permit changed")
      }
      state.records[registrationId] = {
        ...current,
        state: "executed",
        receipt,
        cardRevision: `executed_${receiptState}` as CommittedRecord["cardRevision"],
      }
    })
  }

  expireRegistrations(): string[] {
    const now = Date.parse(this.#now())
    const expired: string[] = []
    this.#transaction((state) => {
      for (const [registrationId, record] of Object.entries(state.records)) {
        const committedExpired = record.state === "committed" && Date.parse(record.expiresAt) < now
        const approvedExpired = record.state === "approved"
          && record.decidedAt !== null
          && Date.parse(record.decidedAt) + 120_000 < now
        if (!committedExpired && !approvedExpired) continue
        state.records[registrationId] = {
          ...record,
          state: "expired",
          cardRevision: "expired",
        }
        expired.push(registrationId)
      }
      return expired.length > 0
    })
    return expired
  }

  pendingCardEdit(registrationId: string): {
    telegramMessageId: number
    text: string
    revision: CommittedRecord["cardRevision"]
  } | null {
    if (!REGISTRATION_ID.test(registrationId)) throw new Error("Sanctuary host registration id is invalid")
    const record = this.#read().records[registrationId]
    if (!record || !("telegramMessageId" in record) || record.cardRevision === record.cardRenderedRevision) return null
    return {
      telegramMessageId: record.telegramMessageId,
      text: `${ROOT_HOST_PREFIX}\n\n<b>Status:</b> ${CARD_STATUS[record.cardRevision]}\n<b>Proposal commitment:</b> <code>${record.proposalDigest}</code>`,
      revision: record.cardRevision,
    }
  }

  markCardEdited(registrationId: string, revision: CommittedRecord["cardRevision"]): void {
    this.#transaction((state) => {
      const record = state.records[registrationId]
      if (!record || !("cardRevision" in record) || record.cardRevision !== revision) {
        throw new Error("Sanctuary host approval card revision changed")
      }
      state.records[registrationId] = { ...record, cardRenderedRevision: revision }
    })
  }

  ownsMessage(telegramMessageId: number): boolean {
    if (!Number.isSafeInteger(telegramMessageId) || telegramMessageId <= 0) return false
    return this.#read().messageIds[String(telegramMessageId)] !== undefined
  }

  ownsPrompt(text: string): boolean {
    return typeof text === "string"
      && (text.startsWith(ROOT_HOST_PREFIX) || text.startsWith("OURO ROOT HOST APPROVAL"))
  }

  ownsHandle(callbackData: string): boolean {
    if (typeof callbackData !== "string") return false
    return Object.values(this.#read().records).some((record) =>
      "approveHandle" in record && (record.approveHandle === callbackData || record.denyHandle === callbackData))
  }

  ownerMutationFrozen(): boolean {
    return Object.values(this.#read().records).some((record) => record.state === "prepared")
  }

  decisionForCallback(callbackQueryId: string): SignedAuthorityPayload<Record<string, unknown>> | null {
    if (!CALLBACK_ID.test(callbackQueryId)) return null
    const state = this.#read()
    const registrationId = state.callbackIds[callbackQueryId]
    if (!registrationId) return null
    return (state.records[registrationId] as CommittedRecord).decision
  }

  claimCallback(input: HostDecisionInput): SignedAuthorityPayload<Record<string, unknown>> | null {
    const callbackDigest = digestText(input.callbackData)
    const record = Object.values(this.#read().records).find((record) =>
      record.approveHandleDigest === callbackDigest || record.denyHandleDigest === callbackDigest
      || ("telegramMessageId" in record && record.telegramMessageId === input.telegramMessageId && input.chatId === this.#options.ownerChatId))
    if (!record) return null
    let decision: SignedAuthorityPayload<Record<string, unknown>> | null = null
    const previous = this.decisionForCallback(input.callbackQueryId)
    if (previous) {
      if (previous.payload.callbackObservationDigest === input.callbackObservationDigest) decision = previous
    } else if (
      record.state === "committed"
      && record.telegramMessageId === input.telegramMessageId
      && (record.approveHandle === input.callbackData || record.denyHandle === input.callbackData)
      && input.userId === this.#options.ownerUserId
      && input.chatId === this.#options.ownerChatId
      && Date.parse(input.decidedAt) <= Date.parse(record.expiresAt)
    ) {
      decision = this.decide(input)
    }
    return signAuthorityPayload({
      domain: "ouro.sanctuary.host-callback.v1",
      keyId: this.#options.keyId,
      privateKey: this.#options.privateKey,
      payload: {
        ...this.#identity(),
        handled: true,
        registrationId: record.registrationId,
        callbackQueryId: input.callbackQueryId,
        observationDigest: input.callbackObservationDigest,
        decision,
      },
    })
  }

  attestStatus(status: Record<string, unknown> | boolean): SignedAuthorityPayload<Record<string, unknown>> {
    return signAuthorityPayload({
      domain: `ouro.sanctuary.host-${typeof status === "boolean" ? "health" : "status"}.v1`,
      keyId: this.#options.keyId,
      privateKey: this.#options.privateKey,
      payload: {
        ...this.#identity(),
        observedAt: this.#now(),
        ...(typeof status === "boolean" ? { healthy: status } : { status }),
      },
    })
  }

  #identity(): Record<string, unknown> {
    return {
      targetHost: this.#options.targetHost,
      botId: this.#options.botId,
      ownerUserId: this.#options.ownerUserId,
      ownerChatId: this.#options.ownerChatId,
      publicKeyDigest: this.#options.publicKeyDigest,
    }
  }

  status(registrationId: string): Record<string, unknown> | null {
    if (!REGISTRATION_ID.test(registrationId)) throw new Error("Sanctuary host registration id is invalid")
    const record = this.#read().records[registrationId]
    if (!record) return null
    return {
      registrationId: record.registrationId,
      state: record.state,
      proposalDigest: record.proposalDigest,
      expiresAt: record.expiresAt,
      ...("telegramMessageId" in record ? { telegramMessageId: record.telegramMessageId } : {}),
      ...("decision" in record && record.decision ? { decision: record.decision } : {}),
      ...("permit" in record && record.permit ? {
        permit: signAuthorityPayload({
          domain: "ouro.sanctuary.host-attempt.v1",
          keyId: this.#options.keyId,
          privateKey: this.#options.privateKey,
          payload: { ...record.permit.payload, permitDigest: authorityArtifactDigest(record.permit.domain, record.permit.payload) },
        }),
      } : {}),
      ...("receipt" in record && record.receipt ? { receipt: record.receipt } : {}),
      ...("cardRevision" in record ? { cardPending: record.cardRevision !== record.cardRenderedRevision } : {}),
    }
  }

  #now(): string {
    const value = this.#options.now?.() ?? new Date().toISOString()
    if (!validTime(value)) throw new Error("Sanctuary host authority time is invalid")
    return value
  }

  #nonce(): string {
    const value = this.#options.nonce?.() ?? randomBytes(32).toString("base64url")
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Sanctuary host authority nonce is invalid")
    return value
  }

  #read(): HostAuthorityState {
    return withImmediateSessionTurnLease(this.#statePath, (lease) => {
      const transaction = readSessionTransaction(this.#statePath, lease)
      if (transaction.value === null) {
        if (transaction.bytes) throw new Error("Sanctuary host authority state is malformed")
        return initialState()
      }
      return validateHostAuthorityState(transaction.value, this.#options)
    })
  }

  #transaction(mutate: (state: HostAuthorityState) => boolean | void): void {
    withImmediateSessionTurnLease(this.#statePath, (lease) => {
      const transaction = readSessionTransaction(this.#statePath, lease)
      let state: HostAuthorityState
      if (transaction.value === null) {
        if (transaction.bytes) throw new Error("Sanctuary host authority state is malformed")
        state = initialState()
      } else {
        state = validateHostAuthorityState(transaction.value, this.#options)
      }
      if (mutate(state) === false) return
      this.#options.beforeWrite?.()
      fs.chmodSync(path.dirname(this.#statePath), 0o700)
      writeSessionTransaction(this.#statePath, state, { lease, expectedRevision: transaction.revision })
    })
  }
}
