import { emitNervesEvent } from "../../nerves/runtime"

export interface BlueBubblesObservationHints {
  chatGuid?: string | null
  chatIdentifier?: string | null
}

export interface BlueBubblesObservationReservation {
  readonly ordinal: number
  readonly hints: readonly string[]
}

export interface BlueBubblesObservationBatch {
  readonly highOrdinal: number
  readonly size: number
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
  readonly signal: AbortSignal
}

export type BlueBubblesPromotionResult =
  | { status: "promoted"; capability: BlueBubblesLatestTurnCapability }
  | { status: "unresolved" | "stale" }

export interface BlueBubblesPromotionOptions {
  allowSameGenerationRetry?: boolean
}

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
}

const AMBIGUOUS_IDENTIFIER = Symbol("ambiguous-bluebubbles-identifier")
const pending = new Map<number, PendingObservation>()
const lanes = new Map<string, ChatLane>()
const identifierBindings = new Map<string, string | typeof AMBIGUOUS_IDENTIFIER>()
const reservationHints = new WeakMap<BlueBubblesObservationReservation, Set<string>>()
const batchReservations = new WeakMap<BlueBubblesObservationBatch, Set<number>>()
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

function createReservation(
  ordinal: number,
  input: BlueBubblesObservationHints,
): BlueBubblesObservationReservation {
  const knownHints = new Set(observationHints(input))
  const reservation = Object.freeze({
    ordinal,
    get hints(): readonly string[] {
      return Object.freeze([...knownHints])
    },
  })
  reservationHints.set(reservation, knownHints)
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  pending.set(ordinal, {
    reservation,
    hints: new Set(knownHints),
    settled,
    settle,
  })
  return reservation
}

export function reserveObservation(input: BlueBubblesObservationHints): BlueBubblesObservationReservation {
  return createReservation(++nextOrdinal, input)
}

export function beginObservationBatch(size: number): BlueBubblesObservationBatch {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("bluebubbles_observation_batch_size_invalid")
  const batch = Object.freeze({ highOrdinal: nextOrdinal + size, size })
  nextOrdinal = batch.highOrdinal
  batchReservations.set(batch, new Set())
  return batch
}

export function reserveObservationFromBatch(
  batch: BlueBubblesObservationBatch,
  newestOffset: number,
  input: BlueBubblesObservationHints,
): BlueBubblesObservationReservation {
  const used = batchReservations.get(batch)
  if (!used || !Number.isSafeInteger(newestOffset) || newestOffset < 0 || newestOffset >= batch.size) {
    throw new Error("bluebubbles_observation_batch_offset_invalid")
  }
  const ordinal = batch.highOrdinal - newestOffset
  if (used.has(ordinal)) throw new Error("bluebubbles_observation_batch_offset_reused")
  used.add(ordinal)
  return createReservation(ordinal, input)
}

export function clearPending(reservation: BlueBubblesObservationReservation): void {
  settlePending(reservation.ordinal)
}

export function reactivateObservation(reservation: BlueBubblesObservationReservation): void {
  if (pending.has(reservation.ordinal)) return
  const knownHints = reservationHints.get(reservation)
  if (!knownHints) throw new Error("bluebubbles_observation_reservation_unknown")
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  pending.set(reservation.ordinal, {
    reservation,
    hints: new Set(knownHints),
    settled,
    settle,
  })
}

export function mergeObservationReservations(
  primary: BlueBubblesObservationReservation,
  duplicate: BlueBubblesObservationReservation,
): BlueBubblesObservationReservation {
  if (primary === duplicate) return primary
  const primaryHints = reservationHints.get(primary)
  const duplicateHints = reservationHints.get(duplicate)
  if (!primaryHints || !duplicateHints) throw new Error("bluebubbles_observation_reservation_unknown")
  for (const hint of duplicateHints) primaryHints.add(hint)
  const primaryPending = pending.get(primary.ordinal)
  if (primaryPending) {
    for (const hint of duplicateHints) primaryPending.hints.add(hint)
  }
  settlePending(duplicate.ordinal)
  return primary
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

export function promote(
  reservation: BlueBubblesObservationReservation,
  input: BlueBubblesObservationHints,
  options: BlueBubblesPromotionOptions = {},
): BlueBubblesPromotionResult {
  const canonicalChat = resolveCanonicalChat(input)
  settlePending(reservation.ordinal)
  if (!canonicalChat) return { status: "unresolved" }

  const chatKey = guidAlias(canonicalChat.chatGuid)
  const lane = lanes.get(chatKey) ?? { highWater: 0, current: null }
  const sameGenerationRetry = reservation.ordinal === lane.highWater
    && options.allowSameGenerationRetry === true
    && lane.current === null
  if (reservation.ordinal < lane.highWater || (reservation.ordinal === lane.highWater && !sameGenerationRetry)) {
    return { status: "stale" }
  }

  lane.current?.controller.abort(new Error("superseded"))
  const controller = new AbortController()
  const capability: InternalCapability = Object.freeze({
    ordinal: reservation.ordinal,
    chatKey,
    canonicalChat: Object.freeze(canonicalChat),
    signal: controller.signal,
    controller,
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
      aliasCount: 1 + [...identifierBindings.values()].filter((binding) => binding === canonicalChat.chatGuid).length,
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
    if (hint === capability.chatKey) return true
    if (hint.startsWith("identifier:")) {
      const identifier = hint.slice("identifier:".length)
      if (identifierBindings.get(identifier) === capability.canonicalChat.chatGuid) return true
    }
  }
  return false
}

export function observationSchedulingKeys(
  reservation: BlueBubblesObservationReservation,
): readonly string[] {
  const hints = reservationHints.get(reservation)
  if (!hints) throw new Error("bluebubbles_observation_reservation_unknown")
  const keys = new Set<string>()
  for (const hint of hints) {
    if (hint.startsWith("identifier:")) {
      const identifier = hint.slice("identifier:".length)
      const binding = identifierBindings.get(identifier)
      keys.add(typeof binding === "string" ? guidAlias(binding) : hint)
    } else {
      keys.add(hint)
    }
  }
  return Object.freeze([...keys])
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
