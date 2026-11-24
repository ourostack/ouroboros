import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { evalHome, stopFile, stopRequested } from "../../eval/kill-switch"

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "kill-switch-")) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

it("lives at ~/.ouro-eval/STOP", () => {
  expect(evalHome(home)).toBe(path.join(home, ".ouro-eval"))
  expect(stopFile(home)).toBe(path.join(home, ".ouro-eval", "STOP"))
  expect(stopFile()).toBe(path.join(os.homedir(), ".ouro-eval", "STOP"))
})

it("is set by any entry at that path, a broken link included, and clear without one", () => {
  const file = stopFile(home)
  expect(stopRequested(file)).toBeUndefined()
  fs.mkdirSync(path.dirname(file))
  fs.symlinkSync(path.join(home, "missing"), file)
  expect(stopRequested(file)).toBe("the kill switch ~/.ouro-eval/STOP is set")
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  expect(stopRequested(file)).toMatch(/is set$/)
})
