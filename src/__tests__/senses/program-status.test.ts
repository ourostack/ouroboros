import { describe, it, expect, vi } from "vitest"
import type { ChannelCallbacks } from "../../heart/core"
import {
  createProgramStatusReporter,
  formatProgramStatus,
  lastAssistantText,
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

describe("lastAssistantText", () => {
  it("is the newest assistant text of the turn", () => {
    expect(lastAssistantText([
      { role: "user", content: "book it" },
      { role: "assistant", content: "Looking." },
      { role: "tool", content: "ok" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Booked." },
    ])).toBe("Booked.")
  })

  it("skips assistant messages without text", () => {
    expect(lastAssistantText([
      { role: "user", content: "book it" },
      { role: "assistant", content: "Booked." },
      { role: "assistant", content: null },
    ])).toBe("Booked.")
  })

  it("never reaches back past the person's message to an earlier turn", () => {
    expect(lastAssistantText([
      { role: "assistant", content: "Old reply." },
      { role: "user", content: "and now?" },
    ])).toBeUndefined()
    expect(lastAssistantText([])).toBeUndefined()
  })
})
