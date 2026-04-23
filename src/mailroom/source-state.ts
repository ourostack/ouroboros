import { emitNervesEvent } from "../nerves/runtime"
import { normalizeMailAddress } from "./core"

export type DelegatedMailSourceSetupStatus =
  | "not_started"
  | "blocked_by_human"
  | "pending_propagation"
  | "ready"
  | "failed_recoverable"
  | "failed_manual_repair"

export type DelegatedMailHumanGate =
  | "browser_auth"
  | "mfa_or_captcha"
  | "export_download"
  | "forwarding_confirmation"

export interface DelegatedMailSourceBackfillState {
  status: DelegatedMailSourceSetupStatus
  scanned?: number
  imported?: number
  duplicates?: number
  sourceFreshThrough?: string | null
  completedAt?: string
}

export interface DelegatedMailSourceForwardingState {
  status: DelegatedMailSourceSetupStatus
  targetAlias: string
  browserAutomationOwner: "agent"
  humanRequired: DelegatedMailHumanGate[]
  verifiedAt?: string
  lastProbeMessageId?: string
  observedRecipient?: string | null
  expectedRecipient?: string
  recoveryAction?: string
}

export interface DelegatedMailSourceState {
  schemaVersion: 1
  agentId: string
  ownerEmail: string
  source: string
  aliasAddress: string
  backfill: DelegatedMailSourceBackfillState
  forwarding: DelegatedMailSourceForwardingState
}

export interface DelegatedMailSourceIdentityInput {
  agentId: string
  ownerEmail: string
  source: string
  aliasAddress: string
}

export interface MboxBackfillCompleteInput {
  scanned: number
  imported: number
  duplicates: number
  sourceFreshThrough: string | null
  completedAt: string
}

export interface ForwardingProbeInput {
  observedRecipient: string | null
  checkedAt: string
  messageId?: string
}

const HUMAN_REQUIRED: DelegatedMailHumanGate[] = [
  "browser_auth",
  "mfa_or_captcha",
  "export_download",
  "forwarding_confirmation",
]

function normalizedSource(source: string): string {
  const value = source.trim().toLowerCase()
  return value || "hey"
}

function normalizedAgentId(agentId: string): string {
  return agentId.trim().toLowerCase()
}

export function createDelegatedMailSourceState(input: DelegatedMailSourceIdentityInput): DelegatedMailSourceState {
  const aliasAddress = normalizeMailAddress(input.aliasAddress)
  const state: DelegatedMailSourceState = {
    schemaVersion: 1,
    agentId: normalizedAgentId(input.agentId),
    ownerEmail: normalizeMailAddress(input.ownerEmail),
    source: normalizedSource(input.source),
    aliasAddress,
    backfill: {
      status: "not_started",
    },
    forwarding: {
      status: "blocked_by_human",
      targetAlias: aliasAddress,
      browserAutomationOwner: "agent",
      humanRequired: [...HUMAN_REQUIRED],
    },
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_delegated_source_state_created",
    message: "delegated mail source setup state created",
    meta: {
      agentId: state.agentId,
      source: state.source,
      forwardingStatus: state.forwarding.status,
      backfillStatus: state.backfill.status,
    },
  })
  return state
}

export function markMboxBackfillComplete(
  state: DelegatedMailSourceState,
  input: MboxBackfillCompleteInput,
): DelegatedMailSourceState {
  const nextState: DelegatedMailSourceState = {
    ...state,
    backfill: {
      status: "ready",
      scanned: input.scanned,
      imported: input.imported,
      duplicates: input.duplicates,
      sourceFreshThrough: input.sourceFreshThrough,
      completedAt: input.completedAt,
    },
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_delegated_source_backfill_ready",
    message: "delegated mail source archive backfill marked ready",
    meta: {
      agentId: nextState.agentId,
      source: nextState.source,
      scanned: input.scanned,
      imported: input.imported,
      duplicates: input.duplicates,
      sourceFreshThroughKnown: input.sourceFreshThrough !== null,
    },
  })
  return nextState
}

export function markForwardingProbeResult(
  state: DelegatedMailSourceState,
  input: ForwardingProbeInput,
): DelegatedMailSourceState {
  const expectedRecipient = normalizeMailAddress(state.forwarding.targetAlias)
  if (!input.observedRecipient) {
    const nextState: DelegatedMailSourceState = {
      ...state,
      forwarding: {
        ...state.forwarding,
        status: "pending_propagation",
        observedRecipient: null,
        expectedRecipient,
        recoveryAction: "Wait briefly, then have Slugger re-check the delegated source alias before asking the human to change HEY again.",
      },
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_delegated_source_forwarding_probe",
      message: "delegated mail source forwarding probe checked",
      meta: {
        agentId: nextState.agentId,
        source: nextState.source,
        status: nextState.forwarding.status,
        observedRecipientPresent: false,
        expectedRecipientDomain: expectedRecipient.split("@")[1],
        messageIdPresent: Boolean(input.messageId),
      },
    })
    return nextState
  }

  const observedRecipient = normalizeMailAddress(input.observedRecipient)
  if (observedRecipient !== expectedRecipient) {
    const nextState: DelegatedMailSourceState = {
      ...state,
      forwarding: {
        ...state.forwarding,
        status: "failed_recoverable",
        observedRecipient,
        expectedRecipient,
        ...(input.messageId ? { lastProbeMessageId: input.messageId } : {}),
        recoveryAction: `HEY is forwarding to ${observedRecipient}. Slugger must correct the HEY forwarding target to ${expectedRecipient}; do not import or label that probe as delegated Ari HEY mail.`,
      },
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_delegated_source_forwarding_probe",
      message: "delegated mail source forwarding probe checked",
      meta: {
        agentId: nextState.agentId,
        source: nextState.source,
        status: nextState.forwarding.status,
        observedRecipientPresent: true,
        observedRecipientMatches: false,
        expectedRecipientDomain: expectedRecipient.split("@")[1],
        observedRecipientDomain: observedRecipient.split("@")[1],
        messageIdPresent: Boolean(input.messageId),
      },
    })
    return nextState
  }

  const nextState: DelegatedMailSourceState = {
    ...state,
    forwarding: {
      ...state.forwarding,
      status: "ready",
      observedRecipient,
      expectedRecipient,
      verifiedAt: input.checkedAt,
      ...(input.messageId ? { lastProbeMessageId: input.messageId } : {}),
    },
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_delegated_source_forwarding_probe",
    message: "delegated mail source forwarding probe checked",
    meta: {
      agentId: nextState.agentId,
      source: nextState.source,
      status: nextState.forwarding.status,
      observedRecipientPresent: true,
      observedRecipientMatches: true,
      expectedRecipientDomain: expectedRecipient.split("@")[1],
      observedRecipientDomain: observedRecipient.split("@")[1],
      messageIdPresent: Boolean(input.messageId),
    },
  })
  return nextState
}

export function renderDelegatedMailSourceNextStep(state: DelegatedMailSourceState): string {
  if (state.forwarding.status === "ready") {
    return `${state.source} forwarding is verified for ${state.aliasAddress}.`
  }
  return [
    `Slugger should continue ${state.source.toUpperCase()} setup with browser automation where it is safe.`,
    "The human remains at the keyboard for login, MFA/CAPTCHA, export download, and final forwarding confirmation.",
    `Forward ${state.ownerEmail}'s ${state.source} mailbox to ${state.aliasAddress}.`,
    "Do not use the native agent mailbox as the forwarding target.",
  ].join(" ")
}
