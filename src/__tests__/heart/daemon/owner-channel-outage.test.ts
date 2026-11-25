import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  formatOutageDuration,
  OWNER_OUTAGE_ALERT_MIN_INTERVAL_MS,
  OWNER_OUTAGE_RECOVERY_CONFIRM_MS,
  OWNER_OUTAGE_SEND_TIMEOUT_MS,
  OWNER_OUTAGE_RETRY_MS,
  OWNER_OUTAGE_THRESHOLD_MS,
  OwnerChannelOutageWatcher,
  outageAlertMessage,
  type OwnerAlertMessage,
  type OwnerAlertRoute,
  type OwnerAlertSend,
} from "../../../heart/daemon/owner-channel-outage"
import type { DaemonHealthResult } from "../../../heart/daemon/daemon"
import type { DaemonSenseRow } from "../../../heart/daemon/sense-manager"

const MIN = 60_000
const T0 = Date.parse("2026-11-25T08:00:00.000Z")
/** The first healthy check starts the confirmation; the check that ends it comes this long after the last down one. */
const CONFIRMED = OWNER_OUTAGE_RECOVERY_CONFIRM_MS + MIN

function row(sense: DaemonSenseRow["sense"], status: DaemonSenseRow["status"], overrides: Partial<DaemonSenseRow> = {}): DaemonSenseRow {
  // A running iMessage listener has shown proof unless a test says otherwise.
  const proof = sense === "bluebubbles" && status === "running" ? { lastProofAt: "2026-11-25T07:59:30.000Z" } : {}
  return { agent: "slugger", sense, label: sense, enabled: true, status, detail: "", ...proof, ...overrides }
}

interface Harness {
  watcher: OwnerChannelOutageWatcher
  rows: DaemonSenseRow[]
  clock: { now: number }
  sent: Array<{ route: OwnerAlertRoute; message: OwnerAlertMessage }>
  senders: Partial<Record<OwnerAlertRoute, OwnerAlertSend>>
  statePath: string
  results: DaemonHealthResult[]
  advance(ms: number): Promise<void>
  jump(ms: number): Promise<void>
  restart(): void
}

function harness(options: { rows?: DaemonSenseRow[]; routes?: OwnerAlertRoute[]; failing?: OwnerAlertRoute[]; dir?: string } = {}): Harness {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "owner-outage-"))
  const statePath = path.join(dir, "slugger.ouro", "state", "owner-channel-outage.json")
  const clock = { now: T0 }
  const sent: Harness["sent"] = []
  const failing = new Set(options.failing ?? [])
  const senders: Partial<Record<OwnerAlertRoute, OwnerAlertSend>> = {}
  for (const route of options.routes ?? ["mail"]) {
    senders[route] = vi.fn(async (message: OwnerAlertMessage) => {
      if (failing.has(route)) throw new Error(`${route} refused`)
      sent.push({ route, message })
    })
  }
  const h: Harness = {
    rows: options.rows ?? [row("bluebubbles", "error", { detail: "BlueBubbles listener exited" }), row("mail", "running"), row("telegram", "disabled", { enabled: false })],
    clock,
    sent,
    senders,
    statePath,
    results: [],
    watcher: null as unknown as OwnerChannelOutageWatcher,
    // The daemon checks every minute, so time passes one check at a time.
    async advance(ms: number) {
      if (ms === 0) return h.watcher.check(h.results)
      for (let left = ms; left > 0; left -= MIN) {
        clock.now += Math.min(MIN, left)
        await h.watcher.check(h.results)
      }
    },
    // Time the daemon didn't see (asleep or stopped), then one check.
    async jump(ms: number) {
      clock.now += ms
      await h.watcher.check(h.results)
    },
    restart() {
      h.watcher = build()
    },
  }
  const build = () => new OwnerChannelOutageWatcher({
    agents: () => ["slugger"],
    listSenseRows: () => h.rows,
    statePath: () => statePath,
    routes: () => senders,
    displayName: () => "Slugger",
    now: () => clock.now,
  })
  h.watcher = build()
  return h
}

describe("formatOutageDuration", () => {
  it("names minutes, hours, and both", () => {
    expect(formatOutageDuration(10_000)).toBe("1 min")
    expect(formatOutageDuration(23 * MIN)).toBe("23 min")
    expect(formatOutageDuration(13 * 60 * MIN)).toBe("13 h")
    expect(formatOutageDuration(134 * MIN)).toBe("2 h 14 min")
  })
})

describe("outageAlertMessage", () => {
  it("bounds a long detail to one plain line and leaves out an empty one", () => {
    const long = outageAlertMessage({ agent: "slugger", name: "Slugger", sense: "bluebubbles", downSince: new Date(T0).toISOString(), detail: `a\n${"x".repeat(400)}`, nowMs: T0 + 20 * MIN })
    const line = long.text.split("\n").find((item) => item.startsWith("What the daemon sees:"))!
    expect(line.length).toBeLessThan(330)
    expect(line.endsWith("…")).toBe(true)
    const none = outageAlertMessage({ agent: "slugger", name: "Slugger", sense: "teams", downSince: new Date(T0).toISOString(), detail: "  ", nowMs: T0 + 20 * MIN })
    expect(none.text).not.toContain("What the daemon sees")
    expect(none.subject).toBe("Slugger: Teams has been down for 20 min")
  })
})

describe("OwnerChannelOutageWatcher", () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it("stays quiet while the outage is shorter than the threshold", async () => {
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS - MIN)
    expect(h.sent).toEqual([])
    const state = JSON.parse(fs.readFileSync(h.statePath, "utf-8"))
    expect(state.outages.bluebubbles.downSince).toBe(new Date(T0).toISOString())
  })

  it("mails the owner once when iMessage stays down past the threshold, and once when it is back", async () => {
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS + MIN)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.route).toBe("mail")
    expect(h.sent[0]!.message.subject).toBe("Slugger: iMessage has been down for 15 min")
    expect(h.sent[0]!.message.text).toContain("Slugger can't reach you on iMessage")
    expect(h.sent[0]!.message.text).toContain("BlueBubbles listener exited")

    // Thirteen more hours down: still one message.
    await h.advance(13 * 60 * MIN)
    expect(h.sent).toHaveLength(1)

    h.rows[0] = row("bluebubbles", "running")
    await h.advance(CONFIRMED - MIN)
    expect(h.sent).toHaveLength(1)
    await h.advance(MIN)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.route).toBe("mail")
    expect(h.sent[1]!.message.subject).toBe("Slugger: iMessage is back")
    expect(h.sent[1]!.message.text).toBe("Slugger can reach you on iMessage again, after 13 h 17 min down.")
    expect(h.sent[1]!.message.noticeId).toBe(`owner-channel-outage:slugger:bluebubbles:${new Date(T0).toISOString()}:back`)

    await h.advance(MIN)
    expect(h.sent).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).outages).toEqual({})
  })

  it("prefers another healthy owner channel over mail", async () => {
    h = harness({ routes: ["telegram", "mail"], rows: [row("bluebubbles", "error"), row("telegram", "running"), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent.map((item) => item.route)).toEqual(["telegram"])
    // An empty detail still names the sense as in error.
    expect(h.sent[0]!.message.text).toContain("What the daemon sees: the sense is in error")
  })

  it("falls back to mail when the other owner channel fails or is itself unhealthy", async () => {
    h = harness({ routes: ["telegram", "teams", "mail"], failing: ["telegram"], rows: [row("bluebubbles", "error", { lastFailure: "exit 1" }), row("telegram", "running"), row("teams", "needs_config"), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent.map((item) => item.route)).toEqual(["mail"])
    expect(h.senders.telegram).toHaveBeenCalledTimes(1)
    expect(h.senders.teams).not.toHaveBeenCalled()
    expect(h.sent[0]!.message.text).toContain("exit 1")
  })

  it("counts a route that hangs as failed and moves on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      h = harness({ routes: ["telegram", "mail"], rows: [row("bluebubbles", "error"), row("telegram", "running"), row("mail", "running")] })
      ;(h.senders.telegram as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined))
      await h.advance(0)
      for (let i = 0; i < 14; i++) await h.advance(MIN)
      const pass = h.advance(MIN)
      await vi.advanceTimersByTimeAsync(OWNER_OUTAGE_SEND_TIMEOUT_MS)
      await pass
      expect(h.sent.map((item) => item.route)).toEqual(["mail"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not alert over a channel that is down too, and alerts for each down channel", async () => {
    h = harness({ routes: ["telegram", "mail"], rows: [row("bluebubbles", "error"), row("telegram", "error"), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent.map((item) => `${item.route}:${item.message.subject}`)).toEqual([
      "mail:Slugger: iMessage has been down for 15 min",
      "mail:Slugger: Telegram has been down for 15 min",
    ])
    expect(h.senders.telegram).not.toHaveBeenCalled()
  })

  it("closes the outage where the owner heard about it, else on the recovered channel", async () => {
    h = harness({ routes: ["telegram", "bluebubbles", "mail"], rows: [row("bluebubbles", "error"), row("telegram", "running"), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent.map((item) => item.route)).toEqual(["telegram"])
    h.rows[0] = row("bluebubbles", "running")
    await h.advance(CONFIRMED)
    expect(h.sent.map((item) => item.route)).toEqual(["telegram", "telegram"])

    const only = harness({ routes: ["bluebubbles", "mail"], failing: ["mail"], rows: [row("bluebubbles", "error"), row("mail", "running")] })
    // Seed an outage the owner heard about by mail.
    fs.mkdirSync(path.dirname(only.statePath), { recursive: true })
    fs.writeFileSync(only.statePath, JSON.stringify({ schemaVersion: 1, outages: { bluebubbles: { downSince: new Date(T0).toISOString(), detail: "x", alertedAt: new Date(T0 + 15 * MIN).toISOString(), alertedVia: "mail" } }, lastAlertAt: {} }))
    only.rows[0] = row("bluebubbles", "running")
    await only.advance(20 * MIN)
    expect(only.sent.map((item) => item.route)).toEqual(["bluebubbles"])
  })

  it("waits for a process before saying a told outage is back", async () => {
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    h.rows[0] = row("bluebubbles", "running")
    await h.advance(MIN)
    h.rows[0] = row("bluebubbles", "ready")
    await h.advance(10 * MIN)
    expect(h.sent).toHaveLength(1)
    // Running again starts a fresh confirmation.
    h.rows[0] = row("bluebubbles", "running")
    await h.advance(OWNER_OUTAGE_RECOVERY_CONFIRM_MS)
    expect(h.sent).toHaveLength(1)
    h.rows[0] = row("bluebubbles", "ready")
    await h.advance(MIN)
    h.rows[0] = row("bluebubbles", "interactive")
    await h.advance(CONFIRMED)
    expect(h.sent.map((item) => item.message.subject)).toEqual(["Slugger: iMessage has been down for 15 min", "Slugger: iMessage is back"])
  })

  it("survives a daemon restart without re-sending, and keeps the outage's start", async () => {
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent).toHaveLength(1)
    h.restart()
    await h.advance(61 * MIN)
    expect(h.sent).toHaveLength(1)
    h.rows[0] = row("bluebubbles", "running")
    h.restart()
    await h.advance(CONFIRMED)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.message.text).toContain("after 1 h 17 min down")
  })

  it("counts an outage from its first sighting across a quick restart", async () => {
    await h.advance(0)
    await h.advance(10 * MIN)
    h.restart()
    await h.jump(MIN)
    await h.advance(4 * MIN)
    expect(h.sent).toHaveLength(1)
  })

  it("restarts the clock of an untold outage after time it couldn't see", async () => {
    await h.advance(0)
    await h.advance(10 * MIN)
    // The Mac slept for an hour.
    await h.jump(60 * MIN)
    expect(h.sent).toEqual([])
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS - MIN)
    expect(h.sent).toEqual([])
    await h.advance(MIN)
    expect(h.sent[0]!.message.subject).toBe("Slugger: iMessage has been down for 15 min")
  })

  it("keeps a flapping channel as one outage", async () => {
    await h.advance(0)
    for (let i = 0; i < 8; i++) {
      h.rows[0] = row("bluebubbles", "running")
      await h.advance(MIN)
      h.rows[0] = row("bluebubbles", "error")
      await h.advance(MIN)
    }
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.message.subject).toBe("Slugger: iMessage has been down for 16 min")
  })

  it("rate-limits a channel that keeps going down to one alert an hour", async () => {
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    h.rows[0] = row("bluebubbles", "running")
    await h.advance(CONFIRMED)
    expect(h.sent).toHaveLength(2)
    h.rows[0] = row("bluebubbles", "error")
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS + MIN)
    expect(h.sent).toHaveLength(2)
    // Still down once the hour since the last alert has passed: it goes out then.
    await h.advance(OWNER_OUTAGE_ALERT_MIN_INTERVAL_MS - OWNER_OUTAGE_THRESHOLD_MS - CONFIRMED - 2 * MIN)
    expect(h.sent).toHaveLength(2)
    await h.advance(MIN)
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]!.message.subject).toContain("has been down for")
  })

  it("retries an undelivered alert only after the retry wait, and an undelivered back message too", async () => {
    h = harness({ failing: ["mail"] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    await h.advance(MIN)
    expect(h.senders.mail).toHaveBeenCalledTimes(1)
    await h.advance(OWNER_OUTAGE_RETRY_MS - MIN)
    expect(h.senders.mail).toHaveBeenCalledTimes(2)
    expect(h.sent).toEqual([])

    const back = harness({ failing: [] })
    await back.advance(0)
    await back.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(back.sent).toHaveLength(1)
    const mail = back.senders.mail as ReturnType<typeof vi.fn>
    mail.mockImplementationOnce(async () => { throw "mail offline" })
    back.rows[0] = row("bluebubbles", "running")
    await back.advance(CONFIRMED)
    expect(mail).toHaveBeenCalledTimes(2)
    await back.advance(MIN)
    expect(mail).toHaveBeenCalledTimes(2)
    await back.advance(OWNER_OUTAGE_RETRY_MS - MIN)
    expect(mail).toHaveBeenCalledTimes(3)
    expect(back.sent.map((item) => item.message.subject)).toEqual(["Slugger: iMessage has been down for 15 min", "Slugger: iMessage is back"])
  })

  it("records an alert it had no route for, and never mails without an enabled mail sense", async () => {
    h = harness({ rows: [row("bluebubbles", "error"), row("mail", "disabled", { enabled: false })] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.senders.mail).not.toHaveBeenCalled()
    const state = JSON.parse(fs.readFileSync(h.statePath, "utf-8"))
    expect(state.outages.bluebubbles.alertedAt).toBeUndefined()
    expect(state.outages.bluebubbles.lastAttemptAt).toBeDefined()
  })

  it("treats a stale BlueBubbles proof from the health result as down", async () => {
    h = harness({ rows: [row("bluebubbles", "running"), row("mail", "running")] })
    h.results = [{ name: "sense-probe:bluebubbles-proof:slugger", status: "critical", message: "BlueBubbles proof has not changed in 10m" }]
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent[0]!.message.text).toContain("BlueBubbles proof has not changed in 10m")
  })

  it("treats a running iMessage listener that has never shown proof as down", async () => {
    h = harness({ rows: [row("bluebubbles", "running", { lastProofAt: undefined }), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent[0]!.message.text).toContain("has never shown that it is connected")
  })

  it("updates the detail it reports as the outage changes", async () => {
    await h.advance(0)
    h.rows[0] = row("bluebubbles", "error", { detail: "respawn guard tripped" })
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent[0]!.message.text).toContain("respawn guard tripped")
  })

  it("drops an outage without a message when it was never told or the channel was turned off", async () => {
    await h.advance(0)
    h.rows[0] = row("bluebubbles", "running")
    await h.advance(CONFIRMED)
    expect(h.sent).toEqual([])
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).outages).toEqual({})

    h.rows[0] = row("bluebubbles", "error")
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS + MIN)
    expect(h.sent).toHaveLength(1)
    h.rows[0] = row("bluebubbles", "disabled", { enabled: false })
    await h.advance(MIN)
    expect(h.sent).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).outages).toEqual({})

    // An untold outage on a channel that moved to another machine ends at once.
    h.rows[0] = row("bluebubbles", "error")
    await h.advance(MIN)
    h.rows[0] = row("bluebubbles", "not_attached")
    await h.advance(MIN)
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).outages).toEqual({})
  })

  it("ignores another agent's rows and a disabled owner channel in error", async () => {
    h = harness({ rows: [row("bluebubbles", "error", { agent: "other" }), row("teams", "error", { enabled: false }), row("mail", "running")] })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent).toEqual([])
    expect(fs.existsSync(h.statePath)).toBe(false)
  })

  it("starts fresh from unreadable or foreign state", async () => {
    fs.mkdirSync(path.dirname(h.statePath), { recursive: true })
    fs.writeFileSync(h.statePath, "{not json")
    await h.advance(0)
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).schemaVersion).toBe(1)
    fs.writeFileSync(h.statePath, JSON.stringify({ schemaVersion: 2 }))
    h.restart()
    await h.advance(MIN)
    expect(JSON.parse(fs.readFileSync(h.statePath, "utf-8")).outages.bluebubbles.downSince).toBe(new Date(T0 + MIN).toISOString())
  })

  it("keeps going when the state cannot be written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-outage-ro-"))
    // A file where the bundle folder should be makes every write fail.
    fs.writeFileSync(path.join(dir, "slugger.ouro"), "")
    h = harness({ dir })
    await h.advance(0)
    await h.advance(OWNER_OUTAGE_THRESHOLD_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("shares one pass between overlapping checks, and isolates one agent's failure", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rows = [row("bluebubbles", "error"), row("mail", "running")]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-outage-many-"))
    const send = vi.fn(async () => { await gate })
    const clock = { now: T0 }
    const watcher = new OwnerChannelOutageWatcher({
      agents: () => ["broken", "slugger"],
      listSenseRows: () => rows,
      statePath: (agent) => {
        if (agent === "broken") throw new Error("no bundle")
        return path.join(dir, `${agent}.json`)
      },
      routes: () => ({ mail: send }),
      now: () => clock.now,
      sightingGapMs: OWNER_OUTAGE_THRESHOLD_MS,
    })
    await watcher.check([])
    clock.now += OWNER_OUTAGE_THRESHOLD_MS
    const first = watcher.check([])
    const second = watcher.check([])
    expect(second).toBe(first)
    release()
    await first
    expect(send).toHaveBeenCalledTimes(1)
    // With no display name, the agent's own name is used.
    expect((send.mock.calls[0] as unknown as [OwnerAlertMessage])[0].subject).toBe("slugger: iMessage has been down for 15 min")
  })

  it("defaults its thresholds and clock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-outage-defaults-"))
    const send = vi.fn(async () => undefined)
    const watcher = new OwnerChannelOutageWatcher({
      agents: () => ["slugger"],
      listSenseRows: () => [row("bluebubbles", "error"), row("mail", "running")],
      statePath: () => path.join(dir, "state.json"),
      routes: () => ({ mail: send }),
    })
    await watcher.check([])
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8")).outages.bluebubbles).toBeDefined()
  })
})
