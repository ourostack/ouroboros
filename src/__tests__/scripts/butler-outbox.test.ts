import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

type Lib = Record<string, any>
const lib = (): Promise<Lib> => import(pathToFileURL(path.resolve("scripts/butler-outbox-lib.mjs")).href)
const cli = (): Promise<Lib> => import(pathToFileURL(path.resolve("scripts/butler-outbox.mjs")).href)

const CARD = "http://100.73.66.84:18940/.well-known/agent-card.json"
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "failure_report", createdAt: "2026-10-08T10:00:00Z", body: `body ${id}`, meta: {}, ...extra })

function harness(responses: Array<string | Error> | ((args: string[]) => string | Error), env: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls: Array<{ args: string[]; bin: string }> = []
  let n = 0
  const deps = {
    ouro: async (args: string[], bin: string) => {
      calls.push({ args, bin })
      const r = typeof responses === "function" ? responses(args) : responses[n++]
      if (r instanceof Error) throw r
      return r
    },
  }
  const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s), env, homedir: "/home/u" }
  return { out, err, calls, deps, io }
}

describe("butler-outbox parseArgs", () => {
  it("parses list with every flag", async () => {
    const { parseArgs } = await lib()
    expect(parseArgs(["list", "--since", "c1", "--json", "--fail-if-empty", "--card-url", "http://x", "--identity-file", "/i.json", "--ouro", "/bin/ouro"])).toEqual({
      command: "list", since: "c1", json: true, failIfEmpty: true, cardUrl: "http://x", identityFile: "/i.json", ouro: "/bin/ouro", ids: [],
    })
  })

  it("parses bare list and ack with ids and flags", async () => {
    const { parseArgs } = await lib()
    expect(parseArgs(["list"])).toMatchObject({ command: "list", since: undefined, json: false, failIfEmpty: false, ids: [] })
    expect(parseArgs(["ack", "a", "b", "--json", "--card-url", "u", "--identity-file", "f", "--ouro", "o"])).toMatchObject({ command: "ack", ids: ["a", "b"], json: true, cardUrl: "u", identityFile: "f", ouro: "o" })
  })

  it("rejects bad invocations", async () => {
    const { parseArgs } = await lib()
    expect(() => parseArgs([])).toThrow(/Usage/)
    expect(() => parseArgs(["frob"])).toThrow(/unknown command/)
    expect(() => parseArgs(["list", "--bogus"])).toThrow(/unknown flag --bogus/)
    expect(() => parseArgs(["list", "--since"])).toThrow(/--since needs a value/)
    expect(() => parseArgs(["list", "--card-url", "--json"])).toThrow(/--card-url needs a value/)
    expect(() => parseArgs(["list", "extra"])).toThrow(/list takes no positional/)
    expect(() => parseArgs(["ack", "a", "--since", "x"])).toThrow(/only valid for list/)
    expect(() => parseArgs(["ack", "a", "--fail-if-empty"])).toThrow(/only valid for list/)
  })
})

describe("butler-outbox config and ids", () => {
  it("resolves flags over env over defaults", async () => {
    const { resolveConfig, parseArgs } = await lib()
    const none = parseArgs(["list"])
    expect(resolveConfig(none, {}, "/h")).toEqual({ cardUrl: CARD, identityFile: "/h/.ouro-cli/a2a/client-identity.json", ouro: "/h/.ouro-cli/bin/ouro" })
    const env = { BUTLER_OUTBOX_CARD_URL: "e-card", BUTLER_OUTBOX_IDENTITY_FILE: "e-id", BUTLER_OUTBOX_OURO: "e-ouro" }
    expect(resolveConfig(none, env, "/h")).toEqual({ cardUrl: "e-card", identityFile: "e-id", ouro: "e-ouro" })
    const flags = parseArgs(["list", "--card-url", "f-card", "--identity-file", "f-id", "--ouro", "f-ouro"])
    expect(resolveConfig(flags, env, "/h")).toEqual({ cardUrl: "f-card", identityFile: "f-id", ouro: "f-ouro" })
  })

  it("validates ids", async () => {
    const { validateIds } = await lib()
    expect(() => validateIds(["a-1", "b.2", "c_3".replace("_", ":"), "X"])).not.toThrow()
    expect(() => validateIds([])).toThrow(/at least one id/)
    expect(() => validateIds(["ok", "bad id"])).toThrow(/invalid id/)
    expect(() => validateIds(["a,b"])).toThrow(/invalid id/)
    expect(() => validateIds(["a;rm"])).toThrow(/invalid id/)
  })

  it("builds exact ouro argv", async () => {
    const { buildOuroArgs } = await lib()
    const cfg = { cardUrl: "U", identityFile: "I", ouro: "O" }
    expect(buildOuroArgs({ command: "list", since: undefined, ids: [] }, cfg)).toEqual(["a2a", "outbox", "list", "--to", "U", "--identity-file", "I", "--json"])
    expect(buildOuroArgs({ command: "list", since: "c9", ids: [] }, cfg)).toEqual(["a2a", "outbox", "list", "--to", "U", "--since", "c9", "--identity-file", "I", "--json"])
    expect(buildOuroArgs({ command: "ack", ids: ["a", "b", "c"] }, cfg)).toEqual(["a2a", "outbox", "ack", "--to", "U", "--ids", "a,b,c", "--identity-file", "I", "--json"])
  })
})

describe("butler-outbox formatting and exit decisions", () => {
  it("formats list output", async () => {
    const { formatList } = await lib()
    const empty = { entries: [], nextCursor: null, more: false }
    expect(formatList(empty, false)).toBe("no new entries")
    expect(JSON.parse(formatList(empty, true))).toEqual({ count: 0, entries: [], nextCursor: null, more: false })
    const full = { entries: [entry("1"), entry("2", { kind: "await_outcome" })], nextCursor: "2", more: true }
    const plain = formatList(full, false)
    expect(plain).toContain("id: 1\nkind: failure_report\ncreatedAt: 2026-10-08T10:00:00Z\nbody 1")
    expect(plain).toContain("kind: await_outcome")
    expect(plain).toContain("more entries available; next cursor: 2")
    expect(formatList({ entries: [entry("1")], nextCursor: "1", more: false }, false)).not.toContain("more entries")
    const json = formatList(full, true)
    expect(json.includes("\n")).toBe(false)
    expect(JSON.parse(json)).toMatchObject({ count: 2, nextCursor: "2", more: true })
    expect(JSON.parse(formatList({ entries: [entry("1")] }, true))).toMatchObject({ nextCursor: null, more: false })
  })

  it("formats ack output", async () => {
    const { formatAck } = await lib()
    expect(formatAck({ acked: ["a"], unknown: ["b"] }, false)).toBe("acked: a\nunknown: b")
    expect(formatAck({ acked: [], unknown: [] }, false)).toBe("acked: (none)")
    expect(JSON.parse(formatAck({ acked: ["a"], unknown: [] }, true))).toEqual({ acked: ["a"], unknown: [] })
  })

  it("decides exit codes", async () => {
    const { listExitCode, ackExitCode } = await lib()
    expect(listExitCode(0, true)).toBe(3)
    expect(listExitCode(0, false)).toBe(0)
    expect(listExitCode(2, true)).toBe(0)
    expect(ackExitCode({ acked: ["a"], unknown: [] })).toBe(0)
    expect(ackExitCode({ acked: ["a"], unknown: ["b"] })).toBe(4)
  })
})

describe("butler-outbox run", () => {
  it("lists entries, never acks, and passes configured argv", async () => {
    const { run } = await lib()
    const h = harness([JSON.stringify({ entries: [entry("1")], nextCursor: "1", more: false })])
    expect(await run(["list", "--since", "0"], h.io, h.deps)).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].args).toEqual(["a2a", "outbox", "list", "--to", CARD, "--since", "0", "--identity-file", "/home/u/.ouro-cli/a2a/client-identity.json", "--json"])
    expect(h.calls[0].bin).toBe("/home/u/.ouro-cli/bin/ouro")
    expect(h.calls.some((c) => c.args.includes("ack"))).toBe(false)
    expect(h.out.join("")).toContain("body 1")
  })

  it("honours env for binary", async () => {
    const { run } = await lib()
    const h = harness([JSON.stringify({ entries: [] })], { BUTLER_OUTBOX_OURO: "/x/ouro" })
    await run(["list"], h.io, h.deps)
    expect(h.calls[0].bin).toBe("/x/ouro")
  })

  it("prints empty output and honours --fail-if-empty", async () => {
    const { run } = await lib()
    const empty = JSON.stringify({ entries: [], nextCursor: null, more: false })
    let h = harness([empty])
    expect(await run(["list"], h.io, h.deps)).toBe(0)
    expect(h.out.join("")).toBe("no new entries\n")
    h = harness([empty])
    expect(await run(["list", "--fail-if-empty"], h.io, h.deps)).toBe(3)
    expect(h.out.join("")).toBe("no new entries\n")
    h = harness([empty])
    expect(await run(["list", "--json", "--fail-if-empty"], h.io, h.deps)).toBe(3)
    expect(JSON.parse(h.out.join(""))).toMatchObject({ count: 0 })
  })

  it("prints json list on one line", async () => {
    const { run } = await lib()
    const h = harness([JSON.stringify({ entries: [entry("1"), entry("2")], nextCursor: "2", more: true })])
    expect(await run(["list", "--json"], h.io, h.deps)).toBe(0)
    expect(h.out.join("").trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(h.out.join(""))).toMatchObject({ count: 2, nextCursor: "2", more: true })
  })

  it("acks ids with exit 0, and exit 4 when some are unknown", async () => {
    const { run } = await lib()
    let h = harness([JSON.stringify({ acked: ["a", "b"], unknown: [] })])
    expect(await run(["ack", "a", "b"], h.io, h.deps)).toBe(0)
    expect(h.calls[0].args).toEqual(["a2a", "outbox", "ack", "--to", CARD, "--ids", "a,b", "--identity-file", "/home/u/.ouro-cli/a2a/client-identity.json", "--json"])
    expect(h.out.join("")).toContain("acked: a, b")
    h = harness([JSON.stringify({ acked: ["a"], unknown: ["c"] })])
    expect(await run(["ack", "a", "c", "--json"], h.io, h.deps)).toBe(4)
    expect(JSON.parse(h.out.join(""))).toEqual({ acked: ["a"], unknown: ["c"] })
  })

  it("exits 2 with usage on bad arguments or ids, without calling ouro", async () => {
    const { run } = await lib()
    for (const argv of [[], ["list", "--nope"], ["ack"], ["ack", "bad id"], ["ack", "a;b"]]) {
      const h = harness([])
      expect(await run(argv, h.io, h.deps)).toBe(2)
      expect(h.calls).toHaveLength(0)
      expect(h.err.join("")).toMatch(/butler-outbox: /)
    }
    const h = harness([])
    await run([], h.io, h.deps)
    expect(h.err.join("")).toContain("Usage:")
  })

  it("exits 1 on malformed or unexpected network output", async () => {
    const { run } = await lib()
    let h = harness(["not json"])
    expect(await run(["list"], h.io, h.deps)).toBe(1)
    expect(h.err.join("")).toMatch(/butler-outbox: .*not valid JSON/)
    h = harness([JSON.stringify({ nope: 1 })])
    expect(await run(["list"], h.io, h.deps)).toBe(1)
    expect(h.err.join("")).toMatch(/unexpected list response/)
    h = harness([JSON.stringify({ acked: [] })])
    expect(await run(["ack", "a"], h.io, h.deps)).toBe(1)
    expect(h.err.join("")).toMatch(/unexpected ack response/)
    h = harness(["null"])
    expect(await run(["list"], h.io, h.deps)).toBe(1)
  })

  it("exits 1 when the network layer rejects", async () => {
    const { run } = await lib()
    const h = harness([new Error("connection refused")])
    expect(await run(["list"], h.io, h.deps)).toBe(1)
    expect(h.err.join("")).toBe("butler-outbox: connection refused\n")
    const h2 = harness([new Error("nope")])
    expect(await run(["ack", "a"], h2.io, h2.deps)).toBe(1)
    const h3 = harness([Object.assign(new Error(""), {})])
    expect(await run(["list"], h3.io, h3.deps)).toBe(1)
    const h4 = harness(() => "x")
    h4.deps.ouro = async () => { throw "string failure" }
    expect(await run(["list"], h4.io, h4.deps)).toBe(1)
    expect(h4.err.join("")).toContain("string failure")
  })
})

describe("butler-outbox entry module", () => {
  it("exports main wired to injected io", async () => {
    const { main } = await cli()
    expect(typeof main).toBe("function")
  })
})
