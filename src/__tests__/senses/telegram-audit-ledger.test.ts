import { createHmac } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  createTelegramAuditLedger,
  verifyTelegramAuditLedger,
} from "../../senses/telegram-audit-ledger"
import type { LogEvent } from "../../nerves"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-ledger-"))
const identityKey = Buffer.alloc(32, 7).toString("base64url")
const privateValues = ["12345:private-token", "123456789", "987654321"]

function event(name: string, ts: string): LogEvent {
  return {
    ts,
    level: "info",
    component: "senses",
    event: name,
    trace_id: "trace-1",
    message: "Telegram acceptance event",
    meta: { scenarioHandleDigest: "a".repeat(64), subject: `tg_${"b".repeat(43)}` },
  }
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
})

describe("Telegram acceptance audit ledger", () => {
  it("appends canonical MAC-chained rows and authenticates its persisted head", () => {
    const ledger = createTelegramAuditLedger({ root, identityKey, privateValues })
    ledger.append(event("senses.telegram_turn_start", "2026-08-20T20:00:00.000Z"))
    ledger.append(event("senses.telegram_turn_end", "2026-08-20T20:00:01.000Z"))
    ledger.assertHealthy()

    const verified = verifyTelegramAuditLedger({
      ledgerRaw: fs.readFileSync(ledger.ledgerPath, "utf8"),
      headRaw: fs.readFileSync(ledger.headPath, "utf8"),
      identityKey,
      privateValues,
    })
    expect(verified).toHaveLength(2)
    expect(verified.map((entry) => entry.event)).toEqual(["senses.telegram_turn_start", "senses.telegram_turn_end"])
    const rows = fs.readFileSync(ledger.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows[0]?.sequence).toBe(1)
    expect(rows[1]?.sequence).toBe(2)
    expect(rows[1]?.previousMac).toBe(rows[0]?.rowMac)
    const head = JSON.parse(fs.readFileSync(ledger.headPath, "utf8")) as Record<string, unknown>
    expect(head).toMatchObject({ recordCount: 2, lastMac: rows[1]?.rowMac })
    expect(head.headMac).toBe(createHmac("sha256", identityKey).update(`ouroboros.telegram.audit-head.v1\0${head.recordCount}\0${head.lastMac}`).digest("hex"))
  })

  it.each(["timestamp", "reorder", "tail deletion", "partial truncation", "head MAC"])("rejects %s tampering against the authenticated head", (tamper) => {
    const ledger = createTelegramAuditLedger({ root, identityKey, privateValues })
    ledger.append(event("one", "2026-08-20T20:00:00.000Z"))
    ledger.append(event("two", "2026-08-20T20:00:01.000Z"))
    const original = fs.readFileSync(ledger.ledgerPath, "utf8")
    const lines = original.trim().split("\n")
    if (tamper === "timestamp") {
      const row = JSON.parse(lines[0]!) as Record<string, unknown>
      row.ts = "2026-08-20T19:59:59.000Z"
      lines[0] = JSON.stringify(row)
      fs.writeFileSync(ledger.ledgerPath, `${lines.join("\n")}\n`)
    } else if (tamper === "reorder") fs.writeFileSync(ledger.ledgerPath, `${lines.reverse().join("\n")}\n`)
    else if (tamper === "tail deletion") fs.writeFileSync(ledger.ledgerPath, `${lines[0]}\n`)
    else if (tamper === "partial truncation") fs.writeFileSync(ledger.ledgerPath, original.slice(0, -9))
    else {
      const head = JSON.parse(fs.readFileSync(ledger.headPath, "utf8")) as Record<string, unknown>
      fs.writeFileSync(ledger.headPath, JSON.stringify({ ...head, headMac: "f".repeat(64) }))
    }

    expect(() => verifyTelegramAuditLedger({
      ledgerRaw: fs.readFileSync(ledger.ledgerPath, "utf8"),
      headRaw: fs.readFileSync(ledger.headPath, "utf8"),
      identityKey,
      privateValues,
    })).toThrow(/audit ledger|audit head/iu)
  })

  it("fails closed before persisting a row containing raw Telegram identity", () => {
    const ledger = createTelegramAuditLedger({ root, identityKey, privateValues })
    expect(() => ledger.append({ ...event("telegram.update_dropped", "2026-08-20T20:00:00.000Z"), meta: { userId: privateValues[1] } })).toThrow("private material")
    expect(fs.readFileSync(ledger.ledgerPath, "utf8")).toBe("")
  })

  it("fails closed when an append would exceed the aggregate ledger bound", () => {
    const ledger = createTelegramAuditLedger({ root, identityKey, privateValues, _maxBytes: 800 })
    ledger.append(event("one", "2026-08-20T20:00:00.000Z"))
    expect(() => ledger.append(event("two", "2026-08-20T20:00:01.000Z"))).toThrow("exceeds its bound")
    expect(() => ledger.assertHealthy()).toThrow("exceeds its bound")
  })
})
