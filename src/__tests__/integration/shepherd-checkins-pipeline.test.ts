import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { ackFrame, startFakeCmux, type FakeCmux } from "../senses/shepherd/fake-cmux"
import type { HostSession } from "../../senses/shepherd/host"
import type { ReturnRecord } from "../../senses/shepherd/returns"
import type { JudgeRuntime } from "../../senses/shepherd/judge"

const dist = process.env.OURO_CHECKIN_FIXTURE_DIST ?? path.resolve(__dirname, "../../../dist")
const { startShepherdSenseApp } = require(path.join(dist, "senses/shepherd/sense.js")) as typeof import("../../senses/shepherd/sense")
const { createShepherdHost } = require(path.join(dist, "senses/shepherd/host.js")) as typeof import("../../senses/shepherd/host")
const { createShepherdJudge } = require(path.join(dist, "senses/shepherd/judge.js")) as typeof import("../../senses/shepherd/judge")
const { getAgentRoot, resetIdentity } = require(path.join(dist, "heart/identity.js")) as typeof import("../../heart/identity")
const { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } =
  require(path.join(dist, "heart/runtime-credentials.js")) as typeof import("../../heart/runtime-credentials")
const { readReturns } = require(path.join(dist, "senses/shepherd/returns.js")) as typeof import("../../senses/shepherd/returns")
const previousHome = process.env.HOME
const children: ChildProcess[] = []
const sockets: FakeCmux[] = []
let stop: (() => void) | null = null

const NATIVE = `
import os, pty, fcntl, termios, json, sys
master, slave = pty.openpty()
os.setsid()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
os.tcsetpgrp(slave, os.getpgrp())
os.set_inheritable(master, True)
os.set_inheritable(slave, True)
os.write(3, (json.dumps({"tty": os.ttyname(slave)}) + "\\n").encode())
os.execv(sys.argv[1], sys.argv[1:])
`

async function waitFor(ready: () => boolean, label: string, evidence?: () => unknown) {
  const deadline = Date.now() + 15_000
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`Owned check-in fixture timed out: ${label}${evidence ? `; ${JSON.stringify(evidence())}` : ""}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function codingProcess(home: string, name: string) {
  const cwd = path.join(home, name)
  const entry = path.join(cwd, "copilot", "pkg", "fixture", "bin", "cli-main.js")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));")
  const child = spawn("python3", ["-c", NATIVE, process.execPath, entry], {
    cwd, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe", "pipe"],
  })
  children.push(child)
  let metadata = "", errors = ""
  child.stdio[3]!.on("data", (chunk: Buffer) => { metadata += chunk.toString() })
  child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString() })
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Owned coding fixture exited: ${errors}`)
    return metadata.includes("\n")
  }, "controlling PTY")
  return { cwd, tty: (JSON.parse(metadata.trim()) as { tty: string }).tty }
}

afterEach(async () => {
  stop?.(); stop = null
  for (const socket of sockets.splice(0)) await socket.close()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
    child.stdin?.end()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await closed
  }
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  resetIdentity()
  resetRuntimeCredentialConfigCache()
})

describe("compiled periodic check-in pipeline on owned PTYs", () => {
  it("continues a provider-stalled terminal, protects a drafted blocker, and stays quiet after restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "checkins-pipeline-"))
    process.env.HOME = home
    resetIdentity()
    const agent = "periodic-fixture"
    const root = getAgentRoot(agent)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Fixture Shepherd" }))
    const first = await codingProcess(home, "unfinished")
    const second = await codingProcess(home, "blocked")
    expect(first.tty).not.toBe(second.tty)
    const ids = [randomUUID(), randomUUID()]
    const workspace = randomUUID()
    const sessions: Array<HostSession & { tty: string }> = [first, second].map((process, index) => ({
      id: ids[index]!, ref: `surface:${index + 1}`, workspace, title: `Owned fixture ${index}`,
      agent: "Copilot", tty: process.tty, cwd: process.cwd, focused: false,
    }))
    const frame = [
      "● Provider retries exhausted; already-authorized implementation is unfinished.",
      "╻" + "▄".repeat(30), "┃  ", "╹" + "▀".repeat(30),
      " Interactive · / commands · 1 scheduled",
    ].join("\n")
    const screens = new Map([
      [ids[0]!, frame],
      [ids[1]!, frame.replace("Provider retries exhausted; already-authorized implementation is unfinished.", "AUTH: needs the human's account sign-in.")
        .replace("┃  ", "┃  human draft must remain untouched")],
    ])
    const cmux = await startFakeCmux({ capability: "v1.owned.fixture" })
    sockets.push(cmux)
    cmux.respond("events.stream", () => ackFrame())
    cmux.respond("system.tree", () => ({ windows: [{ id: "WIN-1", workspaces: [{
      id: workspace, ref: "workspace:1", title: "Owned fixtures", selected: false,
      panes: [{ id: "P-1", surfaces: sessions.map(session => ({ ...session, type: "terminal" })) }],
    }] }] }))
    cmux.respond("surface.read_text", params => {
      const id = String(params.surface_id)
      if (!screens.has(id) || params.workspace_id !== workspace) throw new Error("Fixture refused non-explicit target")
      const text = screens.get(id)!
      return { window_id: "WIN-1", window_ref: "window:1", workspace_id: workspace, workspace_ref: "workspace:1",
        surface_id: id, surface_ref: sessions.find(session => session.id === id)!.ref, text, base64: Buffer.from(text).toString("base64") }
    })
    cmux.respond("terminal.paste", () => ({}))
    cmux.respond("surface.send_key", () => ({}))
    cacheMachineRuntimeCredentialConfig(agent, { cmux: { socketPath: cmux.socketPath, socketCapability: "v1.owned.fixture" } })
    let clock = Date.parse("2026-10-16T04:00:00Z")
    let jobs: Array<{ fn: () => void; at: number; ms: number }> = []
    const notices: ReturnRecord[] = []
    const escalations: string[] = []
    const wakes: string[][] = []
    const providerRequests: string[] = []
    const provider: JudgeRuntime = { streamTurn: async request => {
      const current = String(request.messages[1]!.content)
      providerRequests.push(current)
      expect(request.messages[0]!.content).toContain("periodic check-in")
      expect(request.activeTools).toEqual([])
      return { content: JSON.stringify({ kind: current.includes("AUTH:") ? "gate" : "premature",
        reply: { text: "Never send this provider-selected text." }, reason: current.includes("AUTH:") ? "Human sign-in required." : "Existing work can continue safely." }) }
    } }
    const start = async () => {
      const app = await startShepherdSenseApp({ agentName: agent, now: () => clock,
        schedule: (fn, ms) => {
          const job = { fn, ms, at: clock + ms }
          jobs.push(job)
          return () => { jobs = jobs.filter(candidate => candidate !== job) }
        },
        createHost: connection => ({
          ...createShepherdHost(connection, { agentName: agent, now: () => clock }),
          // This fixture drives the periodic path, not unrelated hook/quiet return detection.
          watch: () => ({ close() {} }),
        }),
        judge: createShepherdJudge(async () => provider, 5000),
        notifyOwner: record => { notices.push(record); return { state: "queued", noticeId: "fixture-notice" } },
        escalate: text => { escalations.push(text) }, wake: async ids => { wakes.push(ids) },
        feedbackWorker: () => ({ drain: async () => {}, stop() {} }),
      })
      stop = app.stop
      await waitFor(() => jobs.some(job => job.ms === 8000), "startup quiet batch")
    }
    const quiet = async (expectedRequests: number) => {
      const task = jobs.find(job => job.ms === 8000)!
      jobs = jobs.filter(job => job !== task)
      clock = task.at
      task.fn()
      await waitFor(() => providerRequests.length === expectedRequests && notices.length === 2 &&
        readReturns(root).filter(record => record.trigger === "periodic").length >= expectedRequests, "fresh compiled judgments", () => ({
        providerRequests: providerRequests.length, notices, records: readReturns(root), methods: cmux.methods.slice(-12),
      }))
    }
    await start()
    await quiet(2)
    const writes = () => cmux.methods.filter(entry => ["terminal.paste", "surface.send_key"].includes(entry.method))
    expect(writes()).toHaveLength(2)
    expect(writes().every(entry => entry.params.surface_id === ids[0] && entry.params.workspace_id === workspace)).toBe(true)
    const paste = writes().find(entry => entry.method === "terminal.paste")!
    expect(JSON.stringify(paste.params)).toContain("Reassess your existing task and continue only already-authorized remaining work.")
    expect(JSON.stringify(paste.params)).not.toContain("provider-selected")
    expect(notices.map(record => [record.session, record.kind, record.action])).toEqual([
      [ids[0], "premature", "respond"], [ids[1], "gate", "let_through"],
    ])
    expect(providerRequests.every(request => request.includes("history only"))).toBe(true)
    const statusCount = cmux.lines.filter(line => line.includes("set_status")).length
    const wake = jobs.find(job => job.ms === 2000)!
    jobs = jobs.filter(job => job !== wake)
    clock = wake.at
    wake.fn()
    await waitFor(() => wakes.length === 1, "coalesced wake")
    stop!(); stop = null
    await waitFor(() => cmux.streamCount() === 0, "closed owned watcher")
    clock += 3_600_000
    await start()
    await quiet(4)
    expect(writes()).toHaveLength(2)
    expect(notices).toHaveLength(2)
    expect(escalations).toHaveLength(1)
    expect(wakes).toHaveLength(1)
    expect(cmux.lines.filter(line => line.includes("set_status"))).toHaveLength(statusCount)
    expect(cmux.methods.some(entry => /focus|select|split|create|close/.test(entry.method))).toBe(false)
  })
})
