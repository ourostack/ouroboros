import * as fs from "node:fs"
import * as path from "node:path"

import {
  readSessionTransaction,
  withImmediateSessionTurnLease,
  writeSessionTransaction,
} from "../../mind/session-transaction"

const SCHEMA_VERSION = 1 as const
const TERMINAL_STATES = new Set(["verified", "failed", "ambiguous", "refused"])
const PERMIT_ID = /^permit-[A-Za-z0-9_-]+$/
const NONCE = /^[A-Za-z0-9_-]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

export interface SanctuaryAuthorityReservation {
  permitId: string
  nonce: string
  permitDigest: string
  reservedAt: string
}

export interface SanctuaryAuthorityReservedRecord extends SanctuaryAuthorityReservation {
  schemaVersion: typeof SCHEMA_VERSION
  state: "reserved"
  updatedAt: string
  outcomeDigest: null
}

export interface SanctuaryAuthorityTerminalRecord extends SanctuaryAuthorityReservation {
  schemaVersion: typeof SCHEMA_VERSION
  state: "verified" | "failed" | "ambiguous" | "refused"
  updatedAt: string
  outcomeDigest: string
}

export type SanctuaryAuthorityLedgerRecord =
  | SanctuaryAuthorityReservedRecord
  | SanctuaryAuthorityTerminalRecord

export interface SanctuaryAuthorityTerminalTransition {
  permitId: string
  state: SanctuaryAuthorityTerminalRecord["state"]
  outcomeDigest: string
  updatedAt: string
}

interface SanctuaryAuthorityLedgerState {
  schemaVersion: typeof SCHEMA_VERSION
  records: Record<string, SanctuaryAuthorityLedgerRecord>
  nonces: Record<string, string>
}

export function sanctuaryAuthorityLedgerPath(agentRoot: string): string {
  return path.join(agentRoot, "authority", "replay-ledger.json")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function assertPermitId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PERMIT_ID.test(value)) {
    throw new Error("Sanctuary authority permit id is invalid")
  }
}

function assertNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NONCE.test(value)) {
    throw new Error("Sanctuary authority nonce is invalid")
  }
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error("Sanctuary authority digest is invalid")
  }
}

function assertTime(value: unknown): asserts value is string {
  if (!validTime(value)) {
    throw new Error("Sanctuary authority time is invalid")
  }
}

function validateReservation(value: unknown): asserts value is SanctuaryAuthorityReservation {
  if (!isObject(value) || !hasExactKeys(value, ["permitId", "nonce", "permitDigest", "reservedAt"])) {
    throw new Error("Sanctuary authority ledger reservation is malformed")
  }
  assertPermitId(value.permitId)
  assertNonce(value.nonce)
  assertDigest(value.permitDigest)
  assertTime(value.reservedAt)
}

function validateRecord(value: unknown, permitId: string): asserts value is SanctuaryAuthorityLedgerRecord {
  if (!isObject(value) || !hasExactKeys(value, [
    "schemaVersion",
    "permitId",
    "nonce",
    "permitDigest",
    "reservedAt",
    "state",
    "updatedAt",
    "outcomeDigest",
  ])) {
    throw new Error(`Sanctuary authority ledger record ${permitId} is malformed`)
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.permitId !== permitId) {
    throw new Error(`Sanctuary authority ledger record ${permitId} has invalid identity`)
  }
  assertPermitId(value.permitId)
  assertNonce(value.nonce)
  assertDigest(value.permitDigest)
  assertTime(value.reservedAt)
  assertTime(value.updatedAt)
  if (value.state === "reserved") {
    if (value.outcomeDigest !== null || value.updatedAt !== value.reservedAt) {
      throw new Error(`Sanctuary authority ledger record ${permitId} has ambiguous reserved state`)
    }
    return
  }
  if (!TERMINAL_STATES.has(String(value.state))) {
    throw new Error(`Sanctuary authority ledger record ${permitId} has invalid state`)
  }
  assertDigest(value.outcomeDigest)
}

function validateState(value: unknown): asserts value is SanctuaryAuthorityLedgerState {
  if (
    !isObject(value)
    || !hasExactKeys(value, ["schemaVersion", "records", "nonces"])
    || value.schemaVersion !== SCHEMA_VERSION
    || !isObject(value.records)
    || !isObject(value.nonces)
  ) {
    throw new Error("Sanctuary authority ledger state is malformed")
  }
  const records: Record<string, SanctuaryAuthorityLedgerRecord> = {}
  for (const [permitId, record] of Object.entries(value.records)) {
    validateRecord(record, permitId)
    records[permitId] = record
    if (value.nonces[record.nonce] !== permitId) {
      throw new Error(`Sanctuary authority ledger nonce index is ambiguous for ${permitId}`)
    }
  }
  for (const [nonce, permitId] of Object.entries(value.nonces)) {
    assertNonce(nonce)
    if (typeof permitId !== "string" || records[permitId]?.nonce !== nonce) {
      throw new Error(`Sanctuary authority ledger nonce index is ambiguous for ${nonce}`)
    }
  }
}

function initialState(): SanctuaryAuthorityLedgerState {
  return { schemaVersion: SCHEMA_VERSION, records: {}, nonces: {} }
}

function transactionState(transaction: ReturnType<typeof readSessionTransaction>): SanctuaryAuthorityLedgerState {
  if (transaction.value === null) {
    if (transaction.bytes) throw new Error("Sanctuary authority ledger state is malformed")
    return initialState()
  }
  validateState(transaction.value)
  return transaction.value
}

export class FileSanctuaryAuthorityLedger {
  readonly #ledgerPath: string

  constructor(agentRoot: string) {
    if (typeof agentRoot !== "string" || agentRoot.length === 0) {
      throw new Error("Sanctuary authority ledger root is invalid")
    }
    this.#ledgerPath = sanctuaryAuthorityLedgerPath(agentRoot)
  }

  reserve(reservation: SanctuaryAuthorityReservation): SanctuaryAuthorityReservedRecord {
    validateReservation(reservation)
    return withImmediateSessionTurnLease(this.#ledgerPath, (lease) => {
      const transaction = readSessionTransaction(this.#ledgerPath, lease)
      const state = transactionState(transaction)
      if (state.records[reservation.permitId]) {
        throw new Error(`Sanctuary authority permit id ${reservation.permitId} already exists`)
      }
      if (state.nonces[reservation.nonce]) {
        throw new Error(`Sanctuary authority nonce ${reservation.nonce} already exists`)
      }
      const record: SanctuaryAuthorityReservedRecord = {
        schemaVersion: SCHEMA_VERSION,
        ...reservation,
        state: "reserved",
        updatedAt: reservation.reservedAt,
        outcomeDigest: null,
      }
      state.records[record.permitId] = record
      state.nonces[record.nonce] = record.permitId
      this.#write(state, transaction.revision, lease)
      return record
    })
  }

  read(permitId: string): SanctuaryAuthorityLedgerRecord | null {
    assertPermitId(permitId)
    return withImmediateSessionTurnLease(this.#ledgerPath, (lease) => {
      const transaction = readSessionTransaction(this.#ledgerPath, lease)
      const state = transactionState(transaction)
      return state.records[permitId] ?? null
    })
  }

  terminalize(transition: SanctuaryAuthorityTerminalTransition): SanctuaryAuthorityTerminalRecord {
    if (!isObject(transition) || !hasExactKeys(transition, ["permitId", "state", "outcomeDigest", "updatedAt"])) {
      throw new Error("Sanctuary authority ledger terminal transition is malformed")
    }
    assertPermitId(transition.permitId)
    if (!TERMINAL_STATES.has(String(transition.state))) {
      throw new Error("Sanctuary authority terminal state is invalid")
    }
    assertDigest(transition.outcomeDigest)
    assertTime(transition.updatedAt)

    return withImmediateSessionTurnLease(this.#ledgerPath, (lease) => {
      const transaction = readSessionTransaction(this.#ledgerPath, lease)
      const state = transactionState(transaction)
      const current = state.records[transition.permitId]
      if (!current) {
        throw new Error(`Sanctuary authority permit ${transition.permitId} is missing`)
      }
      if (current.state !== "reserved") {
        throw new Error(`Sanctuary authority permit ${transition.permitId} state changed`)
      }
      const record: SanctuaryAuthorityTerminalRecord = {
        ...current,
        state: transition.state,
        outcomeDigest: transition.outcomeDigest,
        updatedAt: transition.updatedAt,
      }
      state.records[record.permitId] = record
      this.#write(state, transaction.revision, lease)
      return record
    })
  }

  #write(
    state: SanctuaryAuthorityLedgerState,
    expectedRevision: string,
    lease: Parameters<typeof writeSessionTransaction>[2]["lease"],
  ): void {
    fs.chmodSync(path.dirname(this.#ledgerPath), 0o700)
    writeSessionTransaction(this.#ledgerPath, state, { lease, expectedRevision })
  }
}
