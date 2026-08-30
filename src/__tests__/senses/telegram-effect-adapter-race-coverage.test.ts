import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const lstatSync = vi.hoisted(() => vi.fn())

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  lstatSync,
}))

import { FileTelegramEffectJournal } from "../../senses/telegram-effect-adapter"

const roots: string[] = []

afterEach(() => {
  lstatSync.mockReset()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram effect journal construction race defense", () => {
  it("rejects a root whose verified permissions change after descriptor pinning", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effect-root-race-"))
    roots.push(root)
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    lstatSync.mockImplementation((value) => {
      const stat = actual.lstatSync(value)
      return value === root ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: (stat.mode & ~0o777) | 0o755 }) : stat
    })

    expect(() => new FileTelegramEffectJournal(root)).toThrow("root is unsafe")
  })
})
