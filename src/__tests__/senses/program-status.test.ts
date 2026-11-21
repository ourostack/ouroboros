import { describe, it, expect, vi } from "vitest"
import type { ChannelCallbacks } from "../../heart/core"
import {
  createProgramStatusReporter,
  formatProgramStatus,
  assistantTextSince,
  programStatusText,
  terminalReadsProgramStatus,
} from "../../senses/program-status"

const ORCA = { TERM_PROGRAM: "Orca" }

/** Decodes the reports a reporter wrote, the way Orca's parser reads them. */
function decode(sequence: string): Record<string, string> {
  expect(sequence.startsWith("\x1b]7501;")).toBe(true)
  expect(sequence.endsWith("\x1b\\")).toBe(true)
  const body = sequence.slice("\x1b]7501;".length, -2)
  const fields: Record<string, string> = {}
  for (const pair of body.split(":")) {
    const [key, value] = pair.split("=", 2) as [string, string]
    fields[key] = key === "msg" || key === "title" ? Buffer.from(value, "base64").toString("utf8") : value
  }
  return fields
}

function orcaReporter(agentName = "slugger") {
  const writes: string[] = []
  const reporter = createProgramStatusReporter({ agentName, env: ORCA, isTTY: true, write: (chunk) => { writes.push(chunk) } })
  return { reporter, writes, reports: () => writes.map(decode) }
}

function fakeCallbacks(): ChannelCallbacks & { flushMarkdown(): void } {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    flushMarkdown: vi.fn(),
  }
}

describe("terminalReadsProgramStatus", () => {
  it("is on in an Orca terminal", () => {
    expect(terminalReadsProgramStatus({ TERM_PROGRAM: "Orca" }, true)).toBe(true)
  })

  it("is on in an Orca pane whose TERM_PROGRAM was replaced, such as over SSH or in tmux", () => {
    expect(terminalReadsProgramStatus({ TERM_PROGRAM: "tmux", ORCA_PANE_KEY: "tab:pane" }, true)).toBe(true)
  })

  it("is off in other terminals", () => {
    expect(terminalReadsProgramStatus({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false)
    expect(terminalReadsProgramStatus({}, true)).toBe(false)
  })

  it("is off when output is not a terminal, even inside Orca", () => {
    expect(terminalReadsProgramStatus(ORCA, false)).toBe(false)
  })
})

describe("programStatusText", () => {
  it("folds text to one line without controls", () => {
    expect(programStatusText("Booked it.\n\nAlso added\tthe \u001b[31mcalendar\u0007 entry.", 240))
      .toBe("Booked it. Also added the [31mcalendar entry.")
  })

  it("shortens long text by characters, never splitting one", () => {
    const text = programStatusText("🐍".repeat(300), 10)
    expect(Array.from(text!)).toHaveLength(10)
    expect(text!.endsWith("…")).toBe(true)
  })

  it("is undefined for empty or blank text", () => {
    expect(programStatusText(undefined, 10)).toBeUndefined()
    expect(programStatusText("", 10)).toBeUndefined()
    expect(programStatusText(" \n\t ", 10)).toBeUndefined()
  })
})

describe("formatProgramStatus", () => {
  it("writes state, app, kind and base64 text the way the protocol asks", () => {
    const sequence = formatProgramStatus({ state: "blocked", kind: "question", msg: "Which flight?", title: "Slugger" })
    expect(sequence).toBe(
      `\x1b]7501;state=blocked:app=ouro:kind=question:msg=${Buffer.from("Which flight?").toString("base64")}:title=${Buffer.from("Slugger").toString("base64")}\x1b\\`,
    )
  })

  it("names a kind only on blocked", () => {
    expect(decode(formatProgramStatus({ state: "working", kind: "question" }))).toEqual({ state: "working", app: "ouro" })
  })

  it("clears with the state alone", () => {
    expect(formatProgramStatus({ state: "clear", msg: "ignored", title: "ignored" })).toBe("\x1b]7501;state=clear\x1b\\")
  })

  it("keeps every report inside the protocol's limits", () => {
    const sequence = formatProgramStatus({ state: "done", msg: "é".repeat(5000), title: "t".repeat(500) })
    expect(Buffer.byteLength(sequence, "utf8")).toBeLessThanOrEqual(4096)
    const fields = decode(sequence)
    expect(Buffer.byteLength(fields.msg, "utf8")).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(fields.title, "utf8")).toBeLessThanOrEqual(192)
  })
})

describe("createProgramStatusReporter", () => {
  it("reports a turn: idle, working, done with the reply, titled with the agent", () => {
    const { reporter, reports } = orcaReporter("slugger")
    expect(reporter.enabled).toBe(true)
    reporter.idle()
    reporter.working()
    reporter.done("Booked the noon flight.")
    expect(reports()).toEqual([
      { state: "idle", app: "ouro", title: "slugger" },
      { state: "working", app: "ouro", title: "slugger" },
      { state: "done", app: "ouro", msg: "Booked the noon flight.", title: "slugger" },
    ])
  })

  it("skips a report that repeats the last one", () => {
    const { reporter, writes } = orcaReporter()
    reporter.working("Using shell")
    reporter.working("Using shell")
    reporter.working("Using read file")
    expect(writes).toHaveLength(2)
  })

  it("keeps a failed turn failed when the turn then ends", () => {
    const { reporter, reports } = orcaReporter()
    reporter.working()
    reporter.error("provider unavailable")
    reporter.done("stale reply")
    expect(reports().map((report) => report.state)).toEqual(["working", "error"])
    reporter.working()
    reporter.done("fresh reply")
    expect(reports().map((report) => report.state)).toEqual(["working", "error", "working", "done"])
  })

  it("clears the row when the chat closes", () => {
    const { reporter, writes } = orcaReporter()
    reporter.idle()
    reporter.clear()
    expect(writes.at(-1)).toBe("\x1b]7501;state=clear\x1b\\")
  })

  it("writes nothing outside Orca", () => {
    const write = vi.fn()
    const reporter = createProgramStatusReporter({ agentName: "slugger", env: {}, isTTY: true, write })
    expect(reporter.enabled).toBe(false)
    reporter.idle()
    reporter.working("Using shell")
    reporter.done("hi")
    reporter.error("boom")
    reporter.clear()
    expect(write).not.toHaveBeenCalled()
    const callbacks = fakeCallbacks()
    expect(reporter.wrap(callbacks)).toBe(callbacks)
  })

  it("never lets a broken terminal break the chat", () => {
    const reporter = createProgramStatusReporter({
      agentName: "slugger",
      env: ORCA,
      isTTY: true,
      write: () => { throw new Error("EPIPE") },
    })
    expect(() => reporter.working()).not.toThrow()
    const stringThrower = createProgramStatusReporter({
      agentName: "slugger",
      env: ORCA,
      isTTY: true,
      write: () => { throw "closed" },
    })
    expect(() => stringThrower.done("hi")).not.toThrow()
  })

  it("defaults to this process's terminal and environment", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const original = { tty: process.stdout.isTTY, term: process.env.TERM_PROGRAM, pane: process.env.ORCA_PANE_KEY }
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      process.env.TERM_PROGRAM = "Orca"
      const reporter = createProgramStatusReporter({ agentName: "slugger" })
      expect(reporter.enabled).toBe(true)
      reporter.working()
      expect(write).toHaveBeenCalledWith(expect.stringContaining("\x1b]7501;state=working:app=ouro"))
    } finally {
      write.mockRestore()
      Object.defineProperty(process.stdout, "isTTY", { value: original.tty, configurable: true })
      if (original.term === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = original.term
      if (original.pane === undefined) delete process.env.ORCA_PANE_KEY
      else process.env.ORCA_PANE_KEY = original.pane
    }
  })

  it("reports tool use and terminal errors from the callbacks it wraps, and still calls them", () => {
    const { reporter, reports } = orcaReporter()
    const callbacks = fakeCallbacks()
    const wrapped = reporter.wrap(callbacks)
    wrapped.onToolStart("query_calendar", { day: "today" })
    wrapped.onError(new Error("retrying"), "transient")
    wrapped.onToolStart("--", {})
    wrapped.onError(new Error("provider unavailable"), "terminal")
    expect(callbacks.onToolStart).toHaveBeenCalledWith("query_calendar", { day: "today" })
    expect(callbacks.onError).toHaveBeenCalledTimes(2)
    expect(reports().map((report) => [report.state, report.msg])).toEqual([
      ["working", "Using query calendar"],
      ["working", "Using --"],
      ["error", "provider unavailable"],
    ])
    wrapped.flushMarkdown()
    expect(callbacks.flushMarkdown).toHaveBeenCalled()
  })
})

describe("turnEnded", () => {
  function endState(end: Parameters<ReturnType<typeof createProgramStatusReporter>["turnEnded"]>[0]) {
    const { reporter, reports } = orcaReporter()
    reporter.working()
    reporter.turnEnded(end)
    const last = reports().at(-1)!
    return { state: last.state, kind: last.kind, msg: last.msg }
  }

  it("is done with the first line of the reply when the turn settled", () => {
    expect(endState({ outcome: "settled", aborted: false, reply: "\nBooked the noon flight.\nDetails below." }))
      .toEqual({ state: "done", kind: undefined, msg: "Booked the noon flight." })
  })

  it("is done for a turn with no named outcome that replied, as on the legacy path", () => {
    expect(endState({ aborted: false, reply: "Hi." })).toEqual({ state: "done", kind: undefined, msg: "Hi." })
  })

  it("keeps the specific error a terminal onError already reported for the turn", () => {
    const { reporter, reports } = orcaReporter()
    reporter.working()
    reporter.wrap(fakeCallbacks()).onError(new Error("Rate limited by the provider."), "terminal")
    reporter.turnEnded({ outcome: "errored", aborted: false })
    expect(reports().at(-1)).toMatchObject({ state: "error", msg: "Rate limited by the provider." })
  })

  it("is an error when the turn errored, even though the reply callbacks saw no terminal error", () => {
    expect(endState({ outcome: "errored", aborted: false })).toEqual({ state: "error", kind: undefined, msg: "The turn failed." })
    expect(endState({ outcome: "errored", aborted: false, reply: "Provider unavailable." }))
      .toEqual({ state: "error", kind: undefined, msg: "Provider unavailable." })
  })

  it("is an error when the engine failed closed", () => {
    expect(endState({ outcome: "blocked", aborted: false, reply: "I can't finish that safely." }))
      .toEqual({ state: "error", kind: undefined, msg: "I can't finish that safely." })
    expect(endState({ outcome: "blocked", aborted: false })).toEqual({ state: "error", kind: undefined, msg: "The turn was blocked." })
  })

  it("waits on the person when the turn is suspended for an approval", () => {
    expect(endState({ outcome: "suspended", aborted: false }))
      .toEqual({ state: "blocked", kind: "permission", msg: "Waiting for your approval." })
    expect(endState({ outcome: "suspended", aborted: false, reply: "Approve sending the invoice?" }))
      .toEqual({ state: "blocked", kind: "permission", msg: "Approve sending the invoice?" })
  })

  it("rests when the person interrupted the turn", () => {
    expect(endState({ outcome: "settled", aborted: true, reply: "partial" }).state).toBe("idle")
    expect(endState({ outcome: "aborted", aborted: false }).state).toBe("idle")
  })

  it("rests when the turn was declined or said nothing", () => {
    expect(endState({ aborted: false }).state).toBe("idle")
    expect(endState({ outcome: "settled", aborted: false, reply: " \n " }).state).toBe("idle")
  })
})

describe("assistantTextSince", () => {
  const none = new Set<object>()

  it("is the newest assistant text of the turn", () => {
    expect(assistantTextSince([
      { role: "user", content: "book it" },
      { role: "assistant", content: "Looking." },
      { role: "tool", content: "ok" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Booked." },
    ], none)).toBe("Booked.")
  })

  it("skips assistant messages without text", () => {
    expect(assistantTextSince([
      { role: "user", content: "book it" },
      { role: "assistant", content: "Booked." },
      { role: "assistant", content: null },
    ], none)).toBe("Booked.")
  })

  it("never reaches back past the person's message to an earlier turn", () => {
    expect(assistantTextSince([
      { role: "assistant", content: "Old reply." },
      { role: "user", content: "and now?" },
    ], none)).toBeUndefined()
    expect(assistantTextSince([], none)).toBeUndefined()
  })

  it("never reports a message that was there before the turn, as when a declined turn added nothing", () => {
    const messages = [{ role: "user", content: "earlier" }, { role: "assistant", content: "Old reply." }]
    expect(assistantTextSince(messages, new Set(messages))).toBeUndefined()
  })

  it("finds the reply after trimming shortened the array below its length at turn start", () => {
    const old = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `old ${index}` }))
    const before = new Set<object>(old)
    const user = { role: "user", content: "book it" }
    const reply = { role: "assistant", content: "Booked." }
    // Trimming keeps the newest messages and drops the rest, in place.
    const trimmed = [old[9], user, reply]
    expect(trimmed.length).toBeLessThan(before.size)
    expect(assistantTextSince(trimmed, before)).toBe("Booked.")
  })
})
