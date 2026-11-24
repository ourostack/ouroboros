import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MONTH_CAPS, monthLedger } from "../../eval/month-ledger"

let dir: string
let file: string
let now: Date
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "month-ledger-"))
  file = path.join(dir, ".ouro-eval", "ledger-month.json")
  now = new Date("2026-11-30T23:00:00Z")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const ledger = () => monthLedger({ file, now: () => now })

it("caps a month at $40 of credits and 600 premium requests", () => {
  expect(MONTH_CAPS).toEqual({ premium: 600, credits: 4000 })
})

it("starts a month at nothing, adds each run's spend under its UTC month, and keeps other months", async () => {
  const month = ledger()
  expect(await month.current()).toEqual({ month: "2026-11", spent: { premium: 0, credits: 0, runs: 0 } })
  await month.add({ premium: 2, credits: 10.1 })
  await month.add({ premium: 4, credits: 0.2 })
  expect(await month.current()).toEqual({ month: "2026-11", spent: { premium: 6, credits: 10.3, runs: 2 } })
  now = new Date("2026-12-01T00:30:00Z")
  expect(await month.current()).toEqual({ month: "2026-12", spent: { premium: 0, credits: 0, runs: 0 } })
  await month.add({ premium: 1, credits: 1 })
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    schemaVersion: 1,
    months: { "2026-11": { premium: 6, credits: 10.3, runs: 2 }, "2026-12": { premium: 1, credits: 1, runs: 1 } },
  })
})

it("refuses a run whose worst case would pass either cap this month, and allows one that fits exactly", async () => {
  const month = monthLedger({ file, now: () => now, caps: { premium: 10, credits: 100 } })
  await month.add({ premium: 6, credits: 50 })
  expect(await month.refusal("case-1 run 1", { premium: 4, credits: 50 })).toBeUndefined()
  expect(await month.refusal("case-1 run 1", { premium: 5, credits: 0 })).toBe("case-1 run 1 could pass the 2026-11 premium cap 10: 6 spent this month, 5 more at worst")
  expect(await month.refusal("case-1 run 2", { premium: 0, credits: 50.5 })).toMatch(/2026-11 credits cap 100: 50 spent/)
})

it("refuses every run while its file can't be understood, rather than starting the month again", async () => {
  fs.mkdirSync(path.dirname(file))
  for (const bad of ["not json", "{}", JSON.stringify({ schemaVersion: 1, months: { "2026-11": { premium: -1, credits: 0, runs: 0 } } }), JSON.stringify({ schemaVersion: 1, months: [] }), JSON.stringify({ schemaVersion: 1, months: null })]) {
    fs.writeFileSync(file, bad)
    await expect(ledger().refusal("x", { premium: 0, credits: 0 })).rejects.toThrow(/can't be understood/)
    await expect(ledger().add({ premium: 1, credits: 1 })).rejects.toThrow(/can't be understood/)
  }
  expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ schemaVersion: 1, months: null }))
})

it("passes on a read error other than a missing file", async () => {
  fs.mkdirSync(file, { recursive: true })
  await expect(ledger().current()).rejects.toThrow(/EISDIR/)
})

it("keeps its file in ~/.ouro-eval by default, under the real clock", async () => {
  vi.spyOn(os, "homedir").mockReturnValue(dir)
  try {
    await monthLedger().add({ premium: 1, credits: 2 })
  } finally {
    vi.restoreAllMocks()
  }
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as { months: Record<string, unknown> }
  expect(Object.values(written.months)).toEqual([{ premium: 1, credits: 2, runs: 1 }])
  expect(Object.keys(written.months)[0]).toBe(new Date().toISOString().slice(0, 7))
})
