import childProcess from "node:child_process"
import dgram from "node:dgram"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createGuardedFs } from "../../../eval/watch/guarded-fs"
import { readBundleCommit, runWatch } from "../../../eval/watch/run-watch"
import { createLogger } from "../../../nerves/index"
import { setRuntimeLogger } from "../../../nerves/runtime"
import { summaryLine } from "./fixtures"

const CANARY = "zebracanary7731"
const COMMIT = "c".repeat(40)

describe("runWatch", () => {
  let tmp: string
  let bundles: string
  let root: string
  let privateDir: string

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const append = (rel: string, text: string) => fs.appendFileSync(path.join(root, rel), text)
  const run = (extra: Partial<Parameters<typeof runWatch>[0]> = {}) =>
    runWatch({ agentRoot: root, gfs: createGuardedFs({ protectedRoots: [bundles, root], privateDir }), ...extra })
  const privateFiles = () => fs.readdirSync(privateDir).map((name) => fs.readFileSync(path.join(privateDir, name), "utf8")).join("\n")

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-run-")))
    bundles = path.join(tmp, "AgentBundles")
    root = path.join(bundles, "agent.ouro")
    privateDir = path.join(tmp, "home", ".ouro-eval", "watch", "agent")
    write(".git/HEAD", "ref: refs/heads/main\n")
    write(".git/refs/heads/main", `${COMMIT}\n`)
    write("state/daemon/logs/bluebubbles.ndjson", `${summaryLine()}\n`)
    write("state/daemon/logs/a2a.ndjson", `${summaryLine({ channel: "a2a" }, { trace_id: "t2" })}\n`)
    write("state/logs/cli/runtime.ndjson", `${summaryLine({ channel: "cli" }, { trace_id: "t3" })}\n`)
    write("state/daemon/logs/daemon.ndjson", `${JSON.stringify({ event: "daemon.tick", meta: {} })}\n`)
    // Not logs Watch reads as active: an old uncompressed generation and a process's plain stdout.
    write("state/daemon/logs/daemon.2.ndjson", `${summaryLine({}, { trace_id: "old" })}\n`)
    write("state/daemon/logs/ouro-daemon-stdout.log", `${summaryLine({}, { trace_id: "stdout" })}\n`)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setRuntimeLogger(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("counts every log's turn summaries by day and channel, and keeps private rows", () => {
    const report = run()
    expect(report).toMatchObject({ filesRead: 4, newTurns: 3, rejected: { parse: 0, schema: 0 }, gaps: 0, stoppedEarly: false, bundleCommitKnown: true })
    expect(Object.keys(report.days["2026-11-23"]).sort()).toEqual(["a2a", "bluebubbles", "cli"])
    const rows = fs.readFileSync(path.join(privateDir, "rows.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(rows).toHaveLength(3)
    expect(rows[0].bundleCommitAtWatch).toBe(COMMIT)
    for (const name of fs.readdirSync(privateDir)) expect(fs.statSync(path.join(privateDir, name)).mode & 0o777).toBe(0o600)
  })

  it("reads only new lines on the next run, so nothing is counted twice", () => {
    run()
    expect(run()).toMatchObject({ newTurns: 0, days: {} })
    append("state/daemon/logs/bluebubbles.ndjson", `${summaryLine({}, { trace_id: "t4" })}\n`)
    expect(run()).toMatchObject({ newTurns: 1 })
    expect(fs.readFileSync(path.join(privateDir, "rows.ndjson"), "utf8").trim().split("\n")).toHaveLength(4)
  })

  it("follows a rotation that happened between runs", () => {
    run()
    const active = path.join(root, "state/daemon/logs/bluebubbles.ndjson")
    append("state/daemon/logs/bluebubbles.ndjson", `${summaryLine({}, { trace_id: "t5" })}\n`)
    fs.writeFileSync(path.join(root, "state/daemon/logs/bluebubbles.1.ndjson.gz"), zlib.gzipSync(fs.readFileSync(active)))
    fs.writeFileSync(active, `${summaryLine({}, { trace_id: "t6" })}\n`)
    expect(run()).toMatchObject({ newTurns: 2, gaps: 0 })
  })

  it("counts a log that was replaced between runs as a gap", () => {
    run()
    fs.writeFileSync(path.join(root, "state/daemon/logs/a2a.ndjson"), `${summaryLine({ channel: "a2a" }, { trace_id: "t9", ts: "2026-11-23T11:00:00.000Z" })}\n`)
    expect(run()).toMatchObject({ gaps: 1, newTurns: 1 })
  })

  it("stops when it has used its CPU budget and picks up there next run", () => {
    let used = 0
    const first = run({ cpuBudgetMs: 10, cpuUsedMs: () => (used += 6) })
    expect(first).toMatchObject({ stoppedEarly: true, filesRead: 2 })
    const second = run()
    expect(second.filesRead).toBe(4)
    expect(first.newTurns + second.newTurns).toBe(3)
  })

  it("checks its CPU between parts of one large log, and picks up part-way next run", () => {
    write("state/daemon/logs/bluebubbles.ndjson", [1, 2, 3, 4].map((n) => summaryLine({}, { trace_id: `big${n}` })).join("\n") + "\n")
    const part = summaryLine().length + 1
    let used = 0
    const first = run({ cpuBudgetMs: 10, cpuUsedMs: () => (used += 6), maxBytes: part * 2 })
    expect(first).toMatchObject({ stoppedEarly: true, filesRead: 1, newTurns: 3 })
    const second = run({ maxBytes: part * 2 })
    expect(first.newTurns + second.newTurns).toBe(6)
  })

  it("counts a log it can't read by error code only, and goes on", () => {
    fs.mkdirSync(path.join(root, `state/daemon/logs/${CANARY}.ndjson`))
    const report = run()
    expect(report).toMatchObject({ newTurns: 3, unreadable: { EISDIR: 1 } })
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })

  it("counts a read failure without an error code as other, never by its message", () => {
    const gfs = createGuardedFs({ protectedRoots: [bundles, root], privateDir })
    const withFile = gfs.withFile.bind(gfs)
    vi.spyOn(gfs, "withFile").mockImplementation((file, use) => {
      if (file.endsWith("a2a.ndjson")) throw new Error(CANARY)
      return withFile(file, use)
    })
    const report = runWatch({ agentRoot: root, gfs })
    expect(report).toMatchObject({ unreadable: { other: 1 }, filesRead: 3, newTurns: 2 })
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })

  it("stops the run when a private write is refused, rather than counting it as a read problem", () => {
    const gfs = createGuardedFs({ protectedRoots: [bundles, root], privateDir })
    vi.spyOn(gfs, "appendPrivate").mockImplementation(() => { throw new Error("refused") })
    expect(() => runWatch({ agentRoot: root, gfs })).toThrow(/refused/)
  })

  it("starts over from a cursor file it can't read, and replaces a salt that isn't one", () => {
    fs.mkdirSync(privateDir, { recursive: true })
    fs.writeFileSync(path.join(privateDir, "cursor.json"), "{broken")
    fs.writeFileSync(path.join(privateDir, "salt"), "short")
    expect(run().newTurns).toBe(3)
    expect(fs.readFileSync(path.join(privateDir, "salt"), "utf8")).toMatch(/^[0-9a-f]{64}$/)
    fs.writeFileSync(path.join(privateDir, "cursor.json"), "[]")
    expect(run().newTurns).toBe(3)
  })

  it("drops a log's cursor once its rotated lines are read and no new file exists yet", () => {
    run()
    const active = path.join(root, "state/daemon/logs/bluebubbles.ndjson")
    append("state/daemon/logs/bluebubbles.ndjson", `${summaryLine({}, { trace_id: "t7" })}\n`)
    fs.writeFileSync(path.join(root, "state/daemon/logs/bluebubbles.1.ndjson.gz"), zlib.gzipSync(fs.readFileSync(active)))
    fs.unlinkSync(active)
    expect(run().newTurns).toBe(1)
    fs.writeFileSync(active, `${summaryLine({}, { trace_id: "t8" })}\n`)
    expect(run().newTurns).toBe(1)
  })

  it("keeps one salt across runs", () => {
    run()
    const salt = fs.readFileSync(path.join(privateDir, "salt"), "utf8")
    run()
    expect(fs.readFileSync(path.join(privateDir, "salt"), "utf8")).toBe(salt)
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
  })

  it("imports nothing that can reach the network or start a process", () => {
    const allowed = new Set(["node:crypto", "node:fs", "node:os", "node:path", "node:zlib", "../../nerves/runtime", "../../heart/turn-summary", "../../heart/identity", "./guarded-fs", "./log-reader", "./rows", "./run-watch", "../kill-switch"])
    const dir = path.join(__dirname, "../../../eval/watch")
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), "utf8")
      for (const [, from] of source.matchAll(/from "([^"]+)"/g)) expect(allowed, `${name} imports ${from}`).toContain(from)
      expect(source).not.toMatch(/require\(|import\(/)
    }
    // The kill switch Watch checks first reaches only the file system and nerves too.
    const killSwitch = fs.readFileSync(path.join(dir, "../kill-switch.ts"), "utf8")
    expect([...killSwitch.matchAll(/from "([^"]+)"/g)].map(([, from]) => from)).toEqual(["node:fs", "node:os", "node:path", "../nerves/runtime"])
    expect(killSwitch).not.toMatch(/require\(|import\(/)
  })

  it("makes no network call and starts no process", () => {
    const refuse = () => { throw new Error("network or process use is not allowed in Watch") }
    vi.spyOn(globalThis, "fetch").mockImplementation(refuse)
    for (const name of ["connect", "createConnection", "createServer"] as const) vi.spyOn(net, name).mockImplementation(refuse)
    for (const name of ["request", "get"] as const) {
      vi.spyOn(http, name).mockImplementation(refuse)
      vi.spyOn(https, name).mockImplementation(refuse)
    }
    vi.spyOn(tls, "connect").mockImplementation(refuse)
    vi.spyOn(dgram, "createSocket").mockImplementation(refuse)
    for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
      vi.spyOn(childProcess, name).mockImplementation(refuse)
    }
    expect(run().newTurns).toBe(3)
  })

  it("never carries content into anything it writes, returns or logs (content canary)", () => {
    const events: unknown[] = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    const words = `please read the ${CANARY} ledger and tell me what the ${CANARY} entry says about tomorrow`
    append("state/daemon/logs/bluebubbles.ndjson", [
      JSON.stringify({ event: "senses.inbound", message: words, meta: { text: words, file: `${CANARY}.md` } }),
      `{"event":"engine.turn_summary","meta":{"note":"${words}"`,
      summaryLine({ note: words }),
      summaryLine({ note: `tell-${CANARY}` }),
      summaryLine({ toolCalls: { [`tell ${CANARY}`]: 1, [`tell-${CANARY}`]: 1, [`tell_${CANARY}X`]: 1 } }),
      summaryLine({ provider: `tell-${CANARY}` }),
      summaryLine({ model: `Tell-${CANARY}` }),
      summaryLine({}, { trace_id: CANARY, message: words }),
      summaryLine({}, { trace_id: `tell-${CANARY}` }),
      "",
    ].join("\n"))
    write(`state/logs/${CANARY}/runtime.ndjson`, `${summaryLine({}, { trace_id: words })}\n`)
    const report = run()
    expect(report.rejected).toEqual({ parse: 1, schema: 2 })
    expect(report.newTurns, JSON.stringify(report)).toBe(9)
    const outputs = [JSON.stringify(report), privateFiles(), JSON.stringify(events)].join("\n")
    expect(outputs).not.toContain(CANARY)
    const fixture = words.split(" ")
    for (let i = 0; i + 8 <= fixture.length; i++) expect(outputs).not.toContain(fixture.slice(i, i + 8).join(" "))
  })

  it("refuses to run with a private folder inside the agent's bundle", () => {
    expect(() => createGuardedFs({ protectedRoots: [bundles, root], privateDir: path.join(root, "state", "watch") })).toThrow(/protected/)
  })
})

describe("readBundleCommit", () => {
  let tmp: string
  let gfs: ReturnType<typeof createGuardedFs>
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), text)
  }
  let privateTmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-git-")))
    privateTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-git-private-")))
    gfs = createGuardedFs({ protectedRoots: [tmp], privateDir: path.join(privateTmp, "watch") })
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(privateTmp, { recursive: true, force: true })
  })

  it("reads a branch head, a packed ref and a detached head", () => {
    write(".git/HEAD", "ref: refs/heads/main\n")
    write(".git/packed-refs", `# pack-refs with: peeled\n${"d".repeat(40)} refs/heads/main\n`)
    expect(readBundleCommit(gfs, tmp)).toBe("d".repeat(40))
    write(".git/HEAD", `${"e".repeat(40)}\n`)
    expect(readBundleCommit(gfs, tmp)).toBe("e".repeat(40))
  })

  it("is unknown without a readable commit", () => {
    expect(readBundleCommit(gfs, tmp)).toBe("unknown")
    write(".git/HEAD", "ref: refs/heads/main\n")
    expect(readBundleCommit(gfs, tmp)).toBe("unknown")
    write(".git/HEAD", "garbage\n")
    expect(readBundleCommit(gfs, tmp)).toBe("unknown")
  })
})
