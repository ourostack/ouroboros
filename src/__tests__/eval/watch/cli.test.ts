import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { lowerPriority, watchCli } from "../../../eval/watch/cli"
import { summaryLine } from "./fixtures"

const CANARY = "zebracanary7731"

describe("Watch's command line", () => {
  let home: string
  let root: string
  let out: string[]
  let err: string[]
  const io = () => ({ stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text), homedir: home })

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-cli-")))
    root = path.join(home, "AgentBundles", "agent.ouro")
    fs.mkdirSync(path.join(root, "state", "daemon", "logs"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "daemon", "logs", "bluebubbles.ndjson"), `${summaryLine({}, { message: CANARY })}\n`)
    out = []
    err = []
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("prints counts only, and keeps rows in the agent's private folder under the home folder", () => {
    expect(watchCli(["--agent-root", root], io())).toBe(0)
    expect(JSON.parse(out.join(""))).toMatchObject({ newTurns: 1 })
    expect(fs.existsSync(path.join(home, ".ouro-eval", "watch", "agent", "rows.ndjson"))).toBe(true)
    expect([...out, ...err].join("")).not.toContain(CANARY)
  })

  it("exits before reading anything while the kill switch is set", () => {
    fs.mkdirSync(path.join(home, ".ouro-eval"))
    fs.writeFileSync(path.join(home, ".ouro-eval", "STOP"), "")
    expect(watchCli(["--agent-root", root], io())).toBe(3)
    expect(err.join("")).toMatch(/kill switch/)
    expect(out).toEqual([])
    expect(fs.existsSync(path.join(home, ".ouro-eval", "watch"))).toBe(false)
  })

  it("asks for the agent's folder", () => {
    expect(watchCli([], io())).toBe(2)
    expect(err.join("")).toMatch(/usage/)
  })

  it("fails with an error code only, never a path", () => {
    const outPath = path.join(root, `${CANARY}-out`)
    expect(watchCli(["--agent-root", root, "--out", outPath], io())).toBe(1)
    fs.writeFileSync(path.join(home, `${CANARY}-file`), "x")
    expect(watchCli(["--agent-root", root, "--out", path.join(home, `${CANARY}-file`, "sub")], io())).toBe(1)
    const printed = [...out, ...err].join("")
    expect(printed).toMatch(/refused or failed/)
    expect(printed).toMatch(/EEXIST|ENOTDIR/)
    expect(printed).not.toContain(CANARY)
    expect(printed).not.toContain(home)
  })

  it("lowers its priority, and runs on if that is refused", () => {
    const asked: number[] = []
    lowerPriority((priority) => asked.push(priority))
    expect(asked).toEqual([19])
    expect(() => lowerPriority(() => { throw new Error("no") })).not.toThrow()
    lowerPriority((priority) => expect(priority).toBe(19))
  })
})
