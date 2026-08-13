import { emitNervesEvent } from "../../nerves/runtime"

export interface BlueBubblesObservationHints {
  chatGuid?: string | null
  chatIdentifier?: string | null
}

export interface BlueBubblesObservationReservation {
  readonly ordinal: number
  readonly hints: readonly string[]
}

export interface CanonicalBlueBubblesChat {
  chatGuid: string
  chatIdentifier?: string
  sessionKey: string
}

export interface BlueBubblesLatestTurnCapability {
  readonly ordinal: number
  readonly chatKey: string
  readonly canonicalChat: CanonicalBlueBubblesChat
  readonly aliases: readonly string[]
  readonly signal: AbortSignal
}

export type BlueBubblesPromotionResult =
  | { status: "promoted"; capability: BlueBubblesLatestTurnCapability }
  | { status: "unresolved" | "stale" }

interface PendingObservation {
  reservation: BlueBubblesObservationReservation
  hints: Set<string>
  settled: Promise<void>
  settle: () => void
}

interface ChatLane {
  highWater: number
  current: InternalCapability | null
}

interface InternalCapability extends BlueBubblesLatestTurnCapability {
  controller: AbortController
  aliasesSet: Set<string>
}

const AMBIGUOUS_IDENTIFIER = Symbol("ambiguous-bluebubbles-identifier")
const pending = new Map<number, PendingObservation>()
const lanes = new Map<string, ChatLane>()
const identifierBindings = new Map<string, string | typeof AMBIGUOUS_IDENTIFIER>()
let nextOrdinal = 0

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : null
}

function canonicalIdentifier(value: string | null | undefined): string | null {
  const trimmed = clean(value)
  if (!trimmed) return null
  if (trimmed.includes("@")) return trimmed.toLowerCase()
  if (/^[+\d\s().-]+$/.test(trimmed)) {
    const compact = trimmed.replace(/[^\d+]/g, "")
    if (compact) return compact
  }
  return trimmed
}

function guidAlias(guid: string): string {
  return `guid:${guid}`
}

function identifierAlias(identifier: string): string {
  return `identifier:${identifier}`
}

function observationHints(input: BlueBubblesObservationHints): string[] {
  const guid = clean(input.chatGuid)
  const identifier = canonicalIdentifier(input.chatIdentifier)
  return [
    ...(guid ? [guidAlias(guid)] : []),
    ...(identifier ? [identifierAlias(identifier)] : []),
  ]
}

function settlePending(ordinal: number): void {
  const entry = pending.get(ordinal)
  if (!entry) return
  pending.delete(ordinal)
  entry.settle()
}

export function reserveObservation(input: BlueBubblesObservationHints): BlueBubblesObservationReservation {
  const ordinal = ++nextOrdinal
  const hints = Object.freeze(observationHints(input))
  const reservation = Object.freeze({ ordinal, hints })
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  pending.set(ordinal, {
    reservation,
    hints: new Set(hints),
    settled,
    settle,
  })
  return reservation
}

export function clearPending(reservation: BlueBubblesObservationReservation): void {
  settlePending(reservation.ordinal)
}

function bindIdentifier(identifier: string, guid: string): boolean {
  const existing = identifierBindings.get(identifier)
  if (existing === undefined) {
    identifierBindings.set(identifier, guid)
    return true
  }
  if (existing === guid) return true
  identifierBindings.set(identifier, AMBIGUOUS_IDENTIFIER)
  return false
}

function resolveCanonicalChat(input: BlueBubblesObservationHints): CanonicalBlueBubblesChat | null {
  const inputGuid = clean(input.chatGuid)
  const observedIdentifier = clean(input.chatIdentifier)
  const identifier = canonicalIdentifier(input.chatIdentifier)
  let guid = inputGuid
  if (guid && identifier) bindIdentifier(identifier, guid)
  if (!guid && identifier) {
    const binding = identifierBindings.get(identifier)
    if (typeof binding === "string") guid = binding
  }
  if (!guid) return null
  return {
    chatGuid: guid,
    ...(observedIdentifier && identifier && identifierBindings.get(identifier) === guid
      ? { chatIdentifier: observedIdentifier }
      : {}),
    sessionKey: `chat:${guid}`,
  }
}

function aliasesFor(chat: CanonicalBlueBubblesChat): Set<string> {
  const aliases = new Set<string>([guidAlias(chat.chatGuid)])
  for (const [identifier, binding] of identifierBindings) {
    if (binding === chat.chatGuid) aliases.add(identifierAlias(identifier))
  }
  return aliases
}

export function promote(
  reservation: BlueBubblesObservationReservation,
  input: BlueBubblesObservationHints,
): BlueBubblesPromotionResult {
  const canonicalChat = resolveCanonicalChat(input)
  settlePending(reservation.ordinal)
  if (!canonicalChat) return { status: "unresolved" }

  const chatKey = guidAlias(canonicalChat.chatGuid)
  const lane = lanes.get(chatKey) ?? { highWater: 0, current: null }
  if (reservation.ordinal <= lane.highWater) return { status: "stale" }

  lane.current?.controller.abort(new Error("superseded"))
  const controller = new AbortController()
  const aliasesSet = aliasesFor(canonicalChat)
  const capability: InternalCapability = Object.freeze({
    ordinal: reservation.ordinal,
    chatKey,
    canonicalChat: Object.freeze(canonicalChat),
    aliases: Object.freeze([...aliasesSet]),
    signal: controller.signal,
    controller,
    aliasesSet,
  })
  lane.highWater = reservation.ordinal
  lane.current = capability
  lanes.set(chatKey, lane)
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_latest_turn_promoted",
    message: "promoted the latest process-local bluebubbles turn",
    meta: {
      chatKey,
      ordinal: reservation.ordinal,
      aliasCount: aliasesSet.size,
    },
  })
  return { status: "promoted", capability }
}

function internal(capability: BlueBubblesLatestTurnCapability): InternalCapability {
  return capability as InternalCapability
}

export function isCurrent(capability: BlueBubblesLatestTurnCapability): boolean {
  const lane = lanes.get(capability.chatKey)
  return lane?.current === capability && !capability.signal.aborted
}

function pendingIntersects(capability: InternalCapability, entry: PendingObservation): boolean {
  if (entry.reservation.ordinal <= capability.ordinal) return false
  for (const hint of entry.hints) {
    if (capability.aliasesSet.has(hint)) return true
  }
  return false
}

export async function awaitDeliveryAdmission(
  capability: BlueBubblesLatestTurnCapability,
): Promise<boolean> {
  const value = internal(capability)
  while (isCurrent(value)) {
    const blockers = [...pending.values()].filter((entry) => pendingIntersects(value, entry))
    if (blockers.length === 0) return true
    await Promise.all(blockers.map((entry) => entry.settled))
  }
  return false
}

export function cancel(capability: BlueBubblesLatestTurnCapability, reason = "cancelled"): void {
  const lane = lanes.get(capability.chatKey)
  if (lane?.current !== capability) return
  internal(capability).controller.abort(new Error(reason))
  lane.current = null
}

export function finish(capability: BlueBubblesLatestTurnCapability): void {
  const lane = lanes.get(capability.chatKey)
  if (lane?.current === capability) lane.current = null
}

export function __resetBlueBubblesLatestTurnsForTests(): void {
  for (const entry of pending.values()) entry.settle()
  pending.clear()
  lanes.clear()
  identifierBindings.clear()
  nextOrdinal = 0
}
