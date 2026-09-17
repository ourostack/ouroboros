import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import {
  FileSanctuaryAuthorityLedger,
  sanctuaryAuthorityLedgerPath,
} from "../../../heart/daemon/sanctuary-authority-ledger"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-authority-ledger-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

const reservation = {
  permitId: "permit-0123456789abcdef",
  nonce: "a".repeat(64),
  permitDigest: `sha256:${"b".repeat(64)}`,
  reservedAt: "2026-09-16T21:00:00.000Z",
}

describe("Sanctuary authority execution ledger", () => {
  it("durably reserves a permit and reloads it after restart", () => {
    const agentRoot = root()
    const ledger = new FileSanctuaryAuthorityLedger(agentRoot)
    expect(ledger.reserve(reservation)).toEqual({
      schemaVersion: 1,
      ...reservation,
      state: "reserved",
      updatedAt: reservation.reservedAt,
      outcomeDigest: null,
    })

    expect(new FileSanctuaryAuthorityLedger(agentRoot).read(reservation.permitId)).toEqual(ledger.read(reservation.permitId))
    expect(fs.statSync(sanctuaryAuthorityLedgerPath(agentRoot)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sanctuaryAuthorityLedgerPath(agentRoot))).mode & 0o777).toBe(0o700)
  })

  it("atomically rejects duplicate permit ids and nonces without changing bytes", () => {
    const agentRoot = root()
    const ledger = new FileSanctuaryAuthorityLedger(agentRoot)
    ledger.reserve(reservation)
    const file = sanctuaryAuthorityLedgerPath(agentRoot)
    const before = fs.readFileSync(file, "utf8")

    expect(() => ledger.reserve({ ...reservation, nonce: "c".repeat(64) })).toThrow(/permit id/u)
    expect(() => ledger.reserve({ ...reservation, permitId: "permit-fedcba9876543210" })).toThrow(/nonce/u)
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  it("transitions a reserved permit exactly once and persists the terminal receipt", () => {
    const agentRoot = root()
    const ledger = new FileSanctuaryAuthorityLedger(agentRoot)
    ledger.reserve(reservation)
    const terminal = ledger.terminalize({
      permitId: reservation.permitId,
      state: "verified",
      outcomeDigest: `sha256:${"d".repeat(64)}`,
      updatedAt: "2026-09-16T21:00:10.000Z",
    })

    expect(terminal).toMatchObject({ state: "verified", outcomeDigest: `sha256:${"d".repeat(64)}` })
    expect(() => ledger.terminalize({
      permitId: reservation.permitId,
      state: "failed",
      outcomeDigest: `sha256:${"e".repeat(64)}`,
      updatedAt: "2026-09-16T21:00:11.000Z",
    })).toThrow(/state changed/u)
    expect(new FileSanctuaryAuthorityLedger(agentRoot).read(reservation.permitId)).toEqual(terminal)
  })

  it.each(["verified", "failed", "ambiguous", "refused"] as const)("accepts the %s terminal state", (state) => {
    const ledger = new FileSanctuaryAuthorityLedger(root())
    const permitId = `permit-${state.padEnd(16, "0")}`
    ledger.reserve({ ...reservation, permitId, nonce: state.padEnd(64, "0") })
    expect(ledger.terminalize({
      permitId,
      state,
      outcomeDigest: `sha256:${"f".repeat(64)}`,
      updatedAt: "2026-09-16T21:01:00.000Z",
    }).state).toBe(state)
  })

  it("refuses a missing permit and malformed reservation or terminal input", () => {
    const ledger = new FileSanctuaryAuthorityLedger(root())
    expect(ledger.read("permit-missing0000000")).toBeNull()
    expect(() => ledger.terminalize({
      permitId: "permit-missing0000000",
      state: "failed",
      outcomeDigest: `sha256:${"f".repeat(64)}`,
      updatedAt: "2026-09-16T21:01:00.000Z",
    })).toThrow(/missing/u)
    expect(() => ledger.reserve({ ...reservation, permitId: "" })).toThrow(/permit id/u)
    expect(() => ledger.reserve({ ...reservation, nonce: "short" })).toThrow(/nonce/u)
    expect(() => ledger.reserve({ ...reservation, permitDigest: "sha256:nope" })).toThrow(/digest/u)
    expect(() => ledger.reserve({ ...reservation, reservedAt: "not-time" })).toThrow(/time/u)
    expect(() => ledger.reserve(null as never)).toThrow(/ledger/u)
    expect(() => ledger.reserve({ ...reservation, extra: true } as never)).toThrow(/ledger/u)
    expect(() => ledger.reserve({ ...reservation, permitId: 1 } as never)).toThrow(/permit id/u)
    expect(() => ledger.reserve({ ...reservation, nonce: 1 } as never)).toThrow(/nonce/u)
    expect(() => ledger.reserve({ ...reservation, permitDigest: 1 } as never)).toThrow(/digest/u)
    expect(() => ledger.reserve({ ...reservation, reservedAt: 1 } as never)).toThrow(/time/u)
    expect(() => new FileSanctuaryAuthorityLedger("" as never)).toThrow(/root/u)
    expect(() => new FileSanctuaryAuthorityLedger(1 as never)).toThrow(/root/u)
    ledger.reserve(reservation)
    expect(() => ledger.terminalize({ permitId: reservation.permitId, state: "verified", outcomeDigest: "bad", updatedAt: reservation.reservedAt })).toThrow(/digest/u)
    expect(() => ledger.terminalize({ permitId: reservation.permitId, state: "verified", outcomeDigest: `sha256:${"f".repeat(64)}`, updatedAt: "bad" })).toThrow(/time/u)
    expect(() => ledger.terminalize(null as never)).toThrow(/ledger/u)
    expect(() => ledger.terminalize({ ...reservation } as never)).toThrow(/ledger/u)
    expect(() => ledger.terminalize({ permitId: 1, state: "verified", outcomeDigest: `sha256:${"f".repeat(64)}`, updatedAt: reservation.reservedAt } as never)).toThrow(/permit id/u)
    expect(() => ledger.terminalize({ permitId: reservation.permitId, state: "pending", outcomeDigest: `sha256:${"f".repeat(64)}`, updatedAt: reservation.reservedAt } as never)).toThrow(/state/u)
  })

  it("refuses malformed or ambiguous persisted state", () => {
    const agentRoot = root()
    const file = sanctuaryAuthorityLedgerPath(agentRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const reserved = { schemaVersion: 1, ...reservation, state: "reserved", updatedAt: reservation.reservedAt, outcomeDigest: null }
    const valid = {
      schemaVersion: 1,
      records: { [reservation.permitId]: reserved },
      nonces: { [reservation.nonce]: reservation.permitId },
    }
    const malformed = [
      null,
      { schemaVersion: 1, records: [], nonces: {} },
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, nonces: [] },
      { ...valid, records: { [reservation.permitId]: null } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, extra: true } } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, schemaVersion: 2 } } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, permitId: "permit-other" } } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, outcomeDigest: "sha256:" + "a".repeat(64) } } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, updatedAt: "2026-09-16T21:00:01.000Z" } } },
      { ...valid, records: { [reservation.permitId]: { ...reserved, state: "pending" } } },
      { ...valid, nonces: { [reservation.nonce]: "permit-other" } },
      { ...valid, nonces: { ...valid.nonces, ["z".repeat(64)]: reservation.permitId } },
      { ...valid, nonces: { ...valid.nonces, short: reservation.permitId } },
      { ...valid, nonces: { ...valid.nonces, ["z".repeat(64)]: 1 } },
    ]
    for (const state of malformed) {
      fs.writeFileSync(file, JSON.stringify(state), "utf8")
      expect(() => new FileSanctuaryAuthorityLedger(agentRoot).read(reservation.permitId), JSON.stringify(state)).toThrow(/ledger|identity|state|nonce/u)
    }
  })

  it("fails closed while another process owner holds the ledger lease", () => {
    const agentRoot = root()
    const file = sanctuaryAuthorityLedgerPath(agentRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const database = new Database(`${file}.turn.lock`)
    database.exec(`
      CREATE TABLE session_turn_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pid INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        boot_identity TEXT,
        process_started_at TEXT
      )
    `)
    database.prepare(`
      INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token, boot_identity, process_started_at)
      VALUES (1, ?, 'other-owner', 'other-token', NULL, NULL)
    `).run(process.pid)
    database.close()
    expect(() => new FileSanctuaryAuthorityLedger(agentRoot).reserve(reservation)).toThrow(/busy/u)
  })
})
