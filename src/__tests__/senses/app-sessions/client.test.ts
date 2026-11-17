import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  appUrl, assertSessionId, eventLogPath, findHousesitter, HOUSESITTER_ENV, realRunFile, restartEnqueue, restartStatus, snapshot, type AppSessionRow, type RunFile,
} from "../../../senses/app-sessions/client"

const WS = "11111111-aaaa-bbbb-cccc-000000000001"
const NOW = Date.parse("2026-11-10T03:00:00Z")

const row = (id: string, state: AppSessionRow["state"]): AppSessionRow => ({
  id, name: `name ${id}`, kind: "workspace", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
  parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state, detail: "", isRunning: false, wasInterrupted: false, remote: false,
  createdAt: null, updatedAt: null, lastActivity: null,
})

describe("app-sessions client basics", () => {
  it("checks session ids, links a session in the app, and finds its event log in the state folder", () => {
    expect(assertSessionId(WS)).toBe(WS)
    expect(() => assertSessionId("../etc")).toThrow("is not a Copilot app session id")
    expect(appUrl(WS)).toBe(`ghapp://sessions/${WS}`)
    expect(eventLogPath(WS, { stateDir: "/state" })).toBe(path.join("/state", "session-state", WS, "events.jsonl"))
    expect(eventLogPath(WS)).toBe(path.join(os.homedir(), ".copilot", "session-state", WS, "events.jsonl"))
  })

  it("counts the rows by state and lists each session, stamped with the time given", () => {
    expect(snapshot([row("a", "working"), row("b", "stuck"), row("c", "working")], NOW)).toEqual({
      at: new Date(NOW).toISOString(),
      appRunning: true,
      counts: { working: 2, idle: 0, waiting: 0, stuck: 1 },
      sessions: [{ id: "a", name: "name a", state: "working" }, { id: "b", name: "name b", state: "stuck" }, { id: "c", name: "name c", state: "working" }],
    })
  })
})

describe("restarting the app through housesitter", () => {
  const bin = path.join(os.tmpdir(), "ouro-housesitter-test", "bin", "housesitter.mjs")
  function runner(answer: { code: number; stdout: string; stderr?: string }): RunFile & { calls: string[][] } {
    const calls: string[][] = []
    const run = (async (file: string, args: string[]) => {
      calls.push([file, ...args])
      return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" }
    }) as RunFile & { calls: string[][] }
    run.calls = calls
    return run
  }
  const there = { housesitterPaths: [bin] }
  beforeAll(() => { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, "") })
  afterAll(() => { fs.rmSync(path.dirname(path.dirname(bin)), { recursive: true, force: true }) })

  it("finds housesitter from the explicit paths, HOUSESITTER_BIN, the checkout or PATH, and runs a script with node", () => {
    expect(findHousesitter(there)).toEqual({ file: process.execPath, args: [bin] })
    expect(findHousesitter({ housesitterPaths: ["", "/nonexistent/housesitter", bin] })).toEqual({ file: process.execPath, args: [bin] })
    const exe = path.join(path.dirname(bin), "housesitter")
    fs.writeFileSync(exe, "")
    expect(findHousesitter({ housesitterPaths: [exe] })).toEqual({ file: exe, args: [] })
    expect(findHousesitter({ housesitterPaths: ["/nonexistent/housesitter"] })).toBeNull()
    fs.rmSync(exe)
    const home = path.join(path.dirname(path.dirname(bin)), "home")
    const saved = { env: process.env[HOUSESITTER_ENV], path: process.env.PATH }
    try {
      process.env[HOUSESITTER_ENV] = bin
      expect(findHousesitter()).toEqual({ file: process.execPath, args: [bin] })
      delete process.env[HOUSESITTER_ENV]
      expect(findHousesitter({ homeDir: home, housesitterPaths: undefined })).toBeNull()
      fs.mkdirSync(path.join(home, "code", "housesitter", "bin"), { recursive: true })
      fs.writeFileSync(path.join(home, "code", "housesitter", "bin", "housesitter.mjs"), "")
      expect(findHousesitter({ homeDir: home })).toEqual({ file: process.execPath, args: [path.join(home, "code", "housesitter", "bin", "housesitter.mjs")] })
      fs.rmSync(path.join(home, "code"), { recursive: true })
      process.env.PATH = path.dirname(bin)
      fs.writeFileSync(exe, "")
      expect(findHousesitter({ homeDir: home })).toEqual({ file: exe, args: [] })
      fs.rmSync(exe)
      delete process.env.PATH
      expect(findHousesitter({ homeDir: home })).toBeNull()
    } finally {
      if (saved.env === undefined) delete process.env[HOUSESITTER_ENV]; else process.env[HOUSESITTER_ENV] = saved.env
      process.env.PATH = saved.path
    }
  })

  it("runs the real command when no runner is given", async () => {
    const script = path.join(path.dirname(bin), "fake-housesitter.mjs")
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ state: 'none', argv: process.argv.slice(2) }))")
    expect(await restartStatus({ housesitterPaths: [script] })).toEqual({ installed: true, status: { state: "none", argv: ["restart-copilot", "--status", "--json"] } })
    fs.rmSync(script)
  })

  it("starts a detached restart that resumes every working session, naming who asked", async () => {
    const run = runner({ code: 0, stdout: '{"ok":true,"log":"/l","plist":"/p","error":""}' })
    expect(await restartEnqueue("pick up the new build", "slugger", { ...there, runFile: run })).toEqual({ installed: true, request: { ok: true, log: "/l", plist: "/p", error: "" } })
    expect(run.calls).toEqual([[process.execPath, bin, "restart-copilot", "--resume", "--detach", "--why", "pick up the new build (asked by slugger)", "--json"]])
  })

  it("reports a job launchd would not start", async () => {
    await expect(restartEnqueue("x", "y", { ...there, runFile: runner({ code: 1, stdout: '{"ok":false,"error":"Bootstrap failed"}' }) })).rejects.toThrow("housesitter did not start the restart: Bootstrap failed")
    await expect(restartEnqueue("x", "y", { ...there, runFile: runner({ code: 1, stdout: '{"ok":false}' }) })).rejects.toThrow("no reason given")
  })

  it("reads the restart's state, step and result, including a failed run that exits 1", async () => {
    const running = '{"state":"running","step":"quit sent","started":"2026-11-14T19:49:26.576Z"}'
    const run = runner({ code: 0, stdout: running })
    expect(await restartStatus({ ...there, runFile: run })).toEqual({ installed: true, status: JSON.parse(running) })
    expect(run.calls[0].slice(2)).toEqual(["restart-copilot", "--status", "--json"])
    expect(await restartStatus({ ...there, runFile: runner({ code: 1, stdout: '{"state":"failed","step":"failed at quit"}' }) })).toEqual({ installed: true, status: { state: "failed", step: "failed at quit" } })
  })

  it("says plainly when housesitter is not on this Mac, and runs nothing", async () => {
    const run = runner({ code: 0, stdout: "{}" })
    const none = { housesitterPaths: ["/nonexistent/housesitter"], runFile: run }
    const status = await restartStatus(none)
    expect(status).toEqual({ installed: false, message: expect.stringContaining("Housesitter is not on this Mac") })
    expect(await restartEnqueue("x", "y", none)).toEqual(status)
    expect(run.calls).toHaveLength(0)
  })

  it("throws when housesitter refuses or fails", async () => {
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: "", stderr: "a restart is already running\n" }) })).rejects.toThrow("housesitter failed: a restart is already running")
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: "not json" }) })).rejects.toThrow("housesitter failed: not json")
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: '{"code":"action-unavailable"}' }) })).rejects.toThrow("housesitter failed")
  })

  it("runs commands for real, reporting failure as a non-zero code", async () => {
    expect(await realRunFile(process.execPath, ["-e", "process.stdout.write('ok')"], 10_000)).toEqual({ code: 0, stdout: "ok", stderr: "" })
    const failed = await realRunFile(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"], 10_000)
    expect(failed).toMatchObject({ code: 1, stderr: "bad" })
    expect((await realRunFile("/nonexistent/housesitter", [], 1_000)).stderr).toContain("ENOENT")
  })
})
