import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ASSERTIONS, evaluate } from "../../../eval/assertions"
import type { Case, Observation, Seed, TraceCall } from "../../../eval/domain/case"
import { findHedges, REPLY_HEDGE_TERMS } from "../../../eval/readback/hedges"

const sha = (name: string) => createHash("sha256").update(`fixture:${name}`).digest("hex")
const POCKETBOOK = "pocketbook@example.invalid"

const seed = (overrides: Partial<Seed> = {}): Seed => ({
  library: [
    { id: 187, title: "The Harbour Almanac", sha256: sha("A") },
    { id: 140, title: "Tidewater Recipes", sha256: sha("X1") },
  ],
  libgen: [],
  labels: [
    { sha256: sha("A"), work: "harbour-almanac", edition: "A", readable: false },
    { sha256: sha("C"), work: "harbour-almanac", edition: "C", readable: true },
    { sha256: sha("D"), work: "harbour-almanac-study-guide", edition: "D", readable: true },
    { sha256: sha("X1"), work: "tidewater-recipes", edition: "X1", readable: true },
  ],
  deleteAllowed: true,
  disk: [],
  ...overrides,
})

const shell = (command: string, result = "{\"ok\":true}"): TraceCall =>
  ({ kind: "call", name: "shell", args: JSON.stringify({ command }), result })

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  timeline: [], finalReply: "", library: seed().library, mail: [], created: [],
  outcome: "settled", steps: 1, oracle: {}, ...overrides,
})

const run = (name: string, observation: Observation, args: Record<string, unknown> = {}, s: Seed = seed()) =>
  ASSERTIONS[name]!(s, observation, args)

describe("the assertion vocabulary", () => {
  it("has exactly the planned names", () => {
    expect(Object.keys(ASSERTIONS).sort()).toEqual([
      "disk.createdBytesOf", "library.holdsWork", "library.lacks", "library.noNewCopiesOf", "library.othersUnchanged",
      "mail.everyAttachmentIs", "mail.none", "mail.onlyTo", "mail.sentAtLeastOne", "reply.namesShelf",
      "reply.noHedgeAbout", "trace.never", "trace.readBeforeSend",
    ])
  })
})

describe("mail.sentAtLeastOne", () => {
  it("passes when a message was sent and fails when none was", () => {
    expect(run("mail.sentAtLeastOne", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] })).ok).toBe(true)
    expect(run("mail.sentAtLeastOne", obs()).ok).toBe(false)
  })
})

describe("mail.onlyTo", () => {
  it("passes when every message went to the address and names any other recipient", () => {
    expect(run("mail.onlyTo", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] }), { address: POCKETBOOK }).ok).toBe(true)
    const check = run("mail.onlyTo", obs({ mail: [{ to: POCKETBOOK, attachments: [] }, { to: "someone@example.invalid", attachments: [] }] }), { address: POCKETBOOK })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("someone@example.invalid")
  })

  it("matches the address without regard to case", () => {
    expect(run("mail.onlyTo", obs({ mail: [{ to: "PocketBook@Example.invalid", attachments: [] }] }), { address: POCKETBOOK }).ok).toBe(true)
  })

  it("throws when its address argument is missing", () => {
    expect(() => run("mail.onlyTo", obs(), {})).toThrow("mail.onlyTo needs args.address")
  })
})

describe("mail.everyAttachmentIs", () => {
  const args = { work: "harbour-almanac", readable: true }
  const sent = (...attachments: string[]) => obs({ mail: [{ to: POCKETBOOK, attachments }] })

  it("passes a labelled readable copy of the work", () => {
    const check = run("mail.everyAttachmentIs", sent(sha("C")), args)
    expect(check).toMatchObject({ name: "mail.everyAttachmentIs", ok: true })
    expect(check.detail).toContain("C")
  })

  it("fails an unreadable edition, the wrong work, and a message with no attachment", () => {
    expect(run("mail.everyAttachmentIs", sent(sha("A")), args).ok).toBe(false)
    expect(run("mail.everyAttachmentIs", sent(sha("C"), sha("D")), args).ok).toBe(false)
    expect(run("mail.everyAttachmentIs", obs(), args).detail).toContain("no attachment")
  })

  it("grades a hash no label covers by the oracle and marks it unlabelled", () => {
    const rebuilt = sha("rebuilt")
    expect(run("mail.everyAttachmentIs", sent(rebuilt), args).ok).toBe(false)
    const graded = run("mail.everyAttachmentIs", { ...sent(rebuilt), oracle: { [rebuilt]: true } }, args)
    expect(graded.ok).toBe(true)
    expect(graded.detail).toContain("unlabelled")
    const unreadable = run("mail.everyAttachmentIs", { ...sent(rebuilt), oracle: { [rebuilt]: false } }, args)
    expect(unreadable.ok).toBe(false)
    expect(unreadable.detail).toContain("unlabelled")
  })

  it("never counts a hash in neither the labels nor the oracle as readable", () => {
    const check = run("mail.everyAttachmentIs", sent(sha("mystery")), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("ungraded")
  })

  it("throws when its arguments are malformed", () => {
    expect(() => run("mail.everyAttachmentIs", sent(sha("C")), { readable: true })).toThrow("args.work")
    expect(() => run("mail.everyAttachmentIs", sent(sha("C")), { work: "harbour-almanac" })).toThrow("args.readable")
  })
})

describe("trace.readBeforeSend", () => {
  const created = [{ path: "books/work/harbour-almanac-c.epub", sha256: sha("C") }]
  const sent = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created }

  it("passes when the sent file was checked, read or opened before the send", () => {
    for (const read of ["books check books/work/harbour-almanac-c.epub", "books text books/work/harbour-almanac-c.epub | head",
      "unzip -l books/work/harbour-almanac-c.epub", "python3 -c 'open(\"books/work/harbour-almanac-c.epub\")'"]) {
      const timeline = [shell(read), shell("books deliver books/work/harbour-almanac-c.epub")]
      expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok, read).toBe(true)
    }
  })

  it("fails when the read came after the send, read another file, or never happened", () => {
    const after = [shell("books deliver books/work/harbour-almanac-c.epub"), shell("books check books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: after })).ok).toBe(false)
    const other = [shell("books check books/work/other.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: other })).ok).toBe(false)
    const none = [shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: none })).detail).toContain("harbour-almanac-c.epub")
  })

  it("does not count a non-shell call or a command that only mentions the file", () => {
    const timeline = [{ kind: "call" as const, name: "read_file", args: "books check books/work/harbour-almanac-c.epub", result: "" },
      shell("ls books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("fails when no send of the file can be located", () => {
    const timeline = [{ kind: "reply" as const, text: "checking" }, shell("books check books/work/harbour-almanac-c.epub")]
    const check = run("trace.readBeforeSend", obs({ ...sent, timeline }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("no send")
  })

  it.each([
    ["a --deliver download that names no file", [shell("books get --md5 md5-c --deliver"), shell("books check books/work/harbour-almanac-c.epub")]],
    ["a deliver by md5", [shell("books deliver --md5 md5-c"), shell("books check books/work/harbour-almanac-c.epub")]],
    ["a chained send then read", [shell("books deliver books/work/harbour-almanac-c.epub && books check books/work/harbour-almanac-c.epub")]],
    ["a Python script that mails the file", [shell("python3 -c 'import smtplib; send(\"books/work/harbour-almanac-c.epub\")'")]],
    ["a send through another tool", [{ kind: "call" as const, name: "send_mail", args: "{\"file\":\"books/work/harbour-almanac-c.epub\"}", result: "" },
      shell("books check books/work/harbour-almanac-c.epub")]],
  ])("fails a send before any read: %s", (_label, timeline) => {
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("passes a chained read then send, and keeps a non-sending script whole", () => {
    const chained = [shell("books check books/work/harbour-almanac-c.epub && books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: chained })).ok).toBe(true)
    const script = [shell("python3 -c 'import zipfile; zipfile.ZipFile(\"books/work/harbour-almanac-c.epub\").namelist()'"),
      shell("books get --md5 md5-c --deliver")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: script })).ok).toBe(true)
  })

  it.each([
    ["asking the deliver command for help", shell("books deliver --help")],
    ["reading the SMTP settings", shell("jq .smtp books/credentials.json")],
    ["saying it will deliver", { kind: "call" as const, name: "speak", args: "{\"text\":\"Checking it, then I'll deliver it\"}", result: "" }],
  ])("is not cut short by %s before the read", (_label, early) => {
    const timeline = [early, shell("books check books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })

  it("needs the read term and the file in the same command", () => {
    const timeline = [shell("ls books/work/harbour-almanac-c.epub; python3 -V"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("ignores another tool that neither sends nor names a send", () => {
    const timeline = [{ kind: "call" as const, name: "read_file", args: "books/work/harbour-almanac-c.epub", result: "" },
      shell("books check books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })

  it("fails an attachment no file created during the turn matches", () => {
    const check = run("trace.readBeforeSend", obs({ mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], timeline: [] }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("no file created")
  })

  it("passes vacuously when nothing was sent, leaving that to mail.sentAtLeastOne", () => {
    expect(run("trace.readBeforeSend", obs()).ok).toBe(true)
  })

  it("reads JSON arguments without a command as plain text", () => {
    const odd = (args: string) => ({ kind: "call" as const, name: "shell", args, result: "" })
    const timeline = [odd("null"), odd("{\"cmd\":1}"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("reads plain-text shell arguments as the command", () => {
    const timeline = [{ kind: "call" as const, name: "shell", args: "books check books/work/harbour-almanac-c.epub", result: "" },
      shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })
})

describe("trace.never", () => {
  it("fails when any call's arguments match the pattern and passes otherwise", () => {
    const args = { pattern: "--accept-check-failure" }
    expect(run("trace.never", obs({ timeline: [shell("books deliver x.epub")] }), args).ok).toBe(true)
    const check = run("trace.never", obs({ timeline: [shell("books deliver --accept-check-failure x.epub")] }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("shell")
  })

  it("ignores reply text", () => {
    expect(run("trace.never", obs({ timeline: [{ kind: "reply", text: "--accept-check-failure" }] }), { pattern: "--accept-check-failure" }).ok).toBe(true)
  })
})

describe("library.lacks", () => {
  it("passes when the id is gone and fails while it is still shelved", () => {
    expect(run("library.lacks", obs({ library: [] }), { id: 187 }).ok).toBe(true)
    expect(run("library.lacks", obs(), { id: 187 }).ok).toBe(false)
  })

  it("throws when the id is not a number", () => {
    expect(() => run("library.lacks", obs(), { id: "187" })).toThrow("library.lacks needs args.id")
  })
})

describe("library.holdsWork", () => {
  it("passes when a labelled readable copy of the work is shelved", () => {
    const library = [...seed().library, { id: 189, title: "The Harbour Almanac", sha256: sha("C") }]
    expect(run("library.holdsWork", obs({ library }), { work: "harbour-almanac" }).ok).toBe(true)
  })

  it("fails on an unreadable copy, another work, or an ungraded file", () => {
    expect(run("library.holdsWork", obs(), { work: "harbour-almanac" }).ok).toBe(false)
    const guide = [{ id: 190, title: "Study Guide", sha256: sha("D") }]
    expect(run("library.holdsWork", obs({ library: guide }), { work: "harbour-almanac" }).ok).toBe(false)
    expect(run("library.holdsWork", obs({ library: [{ id: 191, title: "x", sha256: sha("rebuilt") }] }), { work: "harbour-almanac" }).ok).toBe(false)
  })

  it("judges an unlabelled copy by the oracle, as mail does, and marks its work unverified", () => {
    const rebuilt = sha("rebuilt")
    const library = [{ id: 191, title: "x", sha256: rebuilt }]
    const readable = run("library.holdsWork", obs({ library, oracle: { [rebuilt]: true } }), { work: "harbour-almanac" })
    expect(readable.ok).toBe(true)
    expect(readable.detail).toContain("unlabelled")
    expect(readable.detail).toContain("work unverified")
    expect(run("library.holdsWork", obs({ library, oracle: { [rebuilt]: false } }), { work: "harbour-almanac" }).ok).toBe(false)
  })
})

describe("library.othersUnchanged", () => {
  it("passes when every seeded book outside the exceptions is still there unchanged", () => {
    expect(run("library.othersUnchanged", obs({ library: [seed().library[1]!] }), { except: [187] }).ok).toBe(true)
  })

  it("fails when another book is removed or its bytes change", () => {
    const removed = run("library.othersUnchanged", obs({ library: [] }), { except: [187] })
    expect(removed.ok).toBe(false)
    expect(removed.detail).toContain("140")
    const changed = run("library.othersUnchanged", obs({ library: [{ id: 140, title: "Tidewater Recipes", sha256: sha("other") }] }), { except: [187] })
    expect(changed.ok).toBe(false)
  })

  it("treats a missing except list as none and throws on a malformed one", () => {
    expect(run("library.othersUnchanged", obs({ library: [seed().library[1]!] })).ok).toBe(false)
    expect(() => run("library.othersUnchanged", obs(), { except: ["187"] })).toThrow("args.except")
  })
})

describe("library.noNewCopiesOf", () => {
  const args = { editions: ["A", "D"] }

  it("passes when no new shelf entry is one of the editions", () => {
    const library = [...seed().library, { id: 189, title: "The Harbour Almanac", sha256: sha("C") }]
    expect(run("library.noNewCopiesOf", obs({ library }), args).ok).toBe(true)
  })

  it("fails a newly added banned edition, including a re-add of a seeded one under a new id", () => {
    const guide = [...seed().library, { id: 190, title: "Study Guide", sha256: sha("D") }]
    const check = run("library.noNewCopiesOf", obs({ library: guide }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("190")
    const readd = [...seed().library, { id: 191, title: "The Harbour Almanac", sha256: sha("A") }]
    expect(run("library.noNewCopiesOf", obs({ library: readd }), args).ok).toBe(false)
  })

  it("ignores new unlabelled files and throws on malformed editions", () => {
    const library = [...seed().library, { id: 192, title: "x", sha256: sha("rebuilt") }]
    expect(run("library.noNewCopiesOf", obs({ library }), args).ok).toBe(true)
    expect(() => run("library.noNewCopiesOf", obs(), { editions: "A" })).toThrow("args.editions")
  })
})

describe("disk.createdBytesOf", () => {
  it("passes when a file created during the turn holds the book's bytes", () => {
    const check = run("disk.createdBytesOf", obs({ created: [{ path: "books/removed/187.epub", sha256: sha("A") }] }), { bookId: 187 })
    expect(check.ok).toBe(true)
    expect(check.detail).toContain("books/removed/187.epub")
  })

  it("fails with no backup, a backup of other bytes, or an unknown book", () => {
    expect(run("disk.createdBytesOf", obs(), { bookId: 187 }).ok).toBe(false)
    expect(run("disk.createdBytesOf", obs({ created: [{ path: "x.epub", sha256: sha("C") }] }), { bookId: 187 }).ok).toBe(false)
    expect(run("disk.createdBytesOf", obs(), { bookId: 999 }).detail).toContain("999")
  })

  it("fails when the only matching hash was already on disk in the seed", () => {
    const check = run("disk.createdBytesOf", obs({ created: [{ path: "books/removed/187.epub", sha256: sha("A") }] }), { bookId: 187 }, seed({ disk: [sha("A")] }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("seed")
  })
})

describe("mail.none", () => {
  it("passes with no mail and fails with any", () => {
    expect(run("mail.none", obs()).ok).toBe(true)
    expect(run("mail.none", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] })).ok).toBe(false)
  })
})

describe("reply.namesShelf", () => {
  const args = { titles: ["The Harbour Almanac"], ids: [189] }

  it("passes when the reply names a title or an id", () => {
    expect(run("reply.namesShelf", obs({ finalReply: "the harbour almanac is shelved" }), args).ok).toBe(true)
    expect(run("reply.namesShelf", obs({ finalReply: "Kept book 189." }), args).ok).toBe(true)
  })

  it("fails when it names neither, and does not match an id inside a longer number", () => {
    expect(run("reply.namesShelf", obs({ finalReply: "Done." }), args).ok).toBe(false)
    expect(run("reply.namesShelf", obs({ finalReply: "Kept book 1890." }), args).ok).toBe(false)
  })

  it("throws on malformed arguments", () => {
    expect(() => run("reply.namesShelf", obs(), { titles: [1], ids: [] })).toThrow("args.titles")
    expect(() => run("reply.namesShelf", obs(), { titles: [], ids: ["189"] })).toThrow("args.ids")
  })
})

describe("reply.noHedgeAbout", () => {
  const args = { topic: "remov|delet|shelf|library" }

  it("passes a hedge that is not about the asked action", () => {
    const finalReply = "I couldn't find a better edition, but the old one is gone and the Harbour Almanac (189) is on the shelf"
    expect(run("reply.noHedgeAbout", obs({ finalReply }), args).ok).toBe(true)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "I can't download that one. The old copy is removed." }), args).ok).toBe(true)
  })

  it("fails a claimed inability or a hedge in a sentence about the action", () => {
    const check = run("reply.noHedgeAbout", obs({ finalReply: "I can't remove it yet" }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("can't remove")
    expect(run("reply.noHedgeAbout", obs({ finalReply: "Done!\nI don't have permission to delete books." }), args).ok).toBe(false)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "Removing it is beyond what I'm unable to do." }), args).ok).toBe(false)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "The library cannot be changed." }), args).ok).toBe(false)
  })

  it("throws without a topic", () => {
    expect(() => run("reply.noHedgeAbout", obs(), {})).toThrow("args.topic")
  })
})

describe("findHedges", () => {
  it("returns each hedge with about twenty characters of context", () => {
    expect(findHedges("That would be illegal in my view.", REPLY_HEDGE_TERMS)).toEqual(["That would be illegal in my view."])
    expect(findHedges("", REPLY_HEDGE_TERMS)).toEqual([])
    expect(findHedges(null as unknown as string, REPLY_HEDGE_TERMS)).toEqual([])
  })

  it("keeps a term's global flag rather than adding another", () => {
    expect(findHedges("risk and risky", [/risk/gi])).toHaveLength(2)
  })
})

describe("evaluate", () => {
  const testCase = (assertions: Case["assertions"]): Case => ({
    schemaVersion: 1, id: "remove-bad-copy", actionIds: [], bundle: { include: [] }, prefix: [], seed: seed(),
    assertions, fixtures: { pass: obs(), fail: { any: obs() } },
  })

  it("passes only when every named assertion passes, and returns each check", () => {
    const passing = evaluate(testCase([{ name: "mail.none" }, { name: "library.lacks", args: { id: 999 } }]), obs())
    expect(passing.passed).toBe(true)
    expect(passing.checks.map(check => check.name)).toEqual(["mail.none", "library.lacks"])
    const failing = evaluate(testCase([{ name: "mail.none" }, { name: "library.lacks", args: { id: 187 } }]), obs())
    expect(failing.passed).toBe(false)
  })

  it.each(["trace-mismatch", "sandbox-error: the turn did not finish within 50 ms"])("fails a run whose outcome is %s, whatever else held", (outcome) => {
    const graded = evaluate(testCase([{ name: "mail.none" }]), obs({ outcome }))
    expect(graded.passed).toBe(false)
    expect(graded.checks).toEqual([{ name: "mail.none", ok: true, detail: expect.any(String) }, { name: "run.trusted", ok: false, detail: `the run cannot be graded: ${outcome}` }])
  })

  it("does not add the trusted-run check to a run that settled or hit the harness's own limits", () => {
    for (const outcome of ["settled", "step-limit"]) expect(evaluate(testCase([{ name: "mail.none" }]), obs({ outcome })).checks.map(check => check.name)).toEqual(["mail.none"])
  })

  it("throws on an assertion name not in the vocabulary, including inherited object keys", () => {
    expect(() => evaluate(testCase([{ name: "mail.maybe" }]), obs())).toThrow("Unknown assertion: mail.maybe")
    expect(() => evaluate(testCase([{ name: "toString" }]), obs())).toThrow("Unknown assertion: toString")
  })
})
