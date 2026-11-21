import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Seed, TraceCall } from "../../../eval/domain/case"
import { assembleObservation, createdSince, mergeTimeline, readHouseholdState, snapshotFiles } from "../../../eval/sandbox/readback"

const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex")

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

const label = (text: string, work: string, edition: string, readable: boolean) => ({ sha256: sha(text), work, edition, readable })

function seedWith(disk: string[]): Seed {
  return {
    library: [{ id: 187, title: "The Harbour Almanac", sha256: sha("A") }],
    libgen: [],
    labels: [label("A", "harbour-almanac", "A", false), label("A0", "harbour-almanac", "A", false), label("C", "harbour-almanac", "C", true)],
    deleteAllowed: true,
    disk,
  }
}

describe("sandbox readback", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-readback-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  describe("snapshotFiles and createdSince", () => {
    it("marks a file seeded on disk before the turn as not created, and a new or changed file as created", () => {
      write(root, "books/work/seeded/A0.epub", "A0")
      write(root, "books/ledger.ndjson", "")
      write(root, "state/old.json", "before")
      const before = snapshotFiles(root, ["books/work", "books/removed", "books/ledger.ndjson", "state"])
      expect([...before.keys()].sort()).toEqual(["books/ledger.ndjson", "books/work/seeded/A0.epub", "state/old.json"])

      write(root, "books/removed/187-the-harbour-almanac.epub", "A")
      write(root, "books/ledger.ndjson", "{\"event\":\"unshelved\"}\n")
      write(root, "state/old.json", "after")
      const after = snapshotFiles(root, ["books/work", "books/removed", "books/ledger.ndjson", "state"])
      const created = createdSince(before, after)
      expect(created).toEqual([
        { path: "books/ledger.ndjson", sha256: sha("{\"event\":\"unshelved\"}\n") },
        { path: "books/removed/187-the-harbour-almanac.epub", sha256: sha("A") },
        { path: "state/old.json", sha256: sha("after") },
      ])
      expect(created.map((file) => file.path)).not.toContain("books/work/seeded/A0.epub")
    })

    it("never follows a link or opens anything but a regular file, so the agent cannot point the host at its own files", () => {
      const outside = path.join(root, "outside.txt")
      fs.writeFileSync(outside, "host secret")
      fs.mkdirSync(path.join(root, "books/work"), { recursive: true })
      fs.symlinkSync(outside, path.join(root, "books/work/link.epub"))
      fs.symlinkSync(root, path.join(root, "books/work/loop"))
      const snapshot = snapshotFiles(root, ["books/work", "missing"])
      expect([...snapshot.keys()]).toEqual([])
    })
  })

  describe("readHouseholdState", () => {
    it("reads the library and mail the sidecar recorded", () => {
      const file = path.join(root, "state.json")
      fs.writeFileSync(file, JSON.stringify({
        library: [{ id: 189, title: "The Harbour Almanac", authors: "A. Writer", sha256: sha("C") }],
        mail: [
          { id: "q1", from: "butler@example.invalid", to: ["pocketbook@example.invalid", "other@example.invalid"], attachments: [{ filename: "c.epub", sha256: sha("C"), bytes: 1 }] },
          { id: "q2", to: ["pocketbook@example.invalid"], parse_error: "HeaderParseError: bad" },
        ],
        events: [{ service: "smtp" }],
      }))
      expect(readHouseholdState(file)).toEqual({
        library: [{ id: 189, title: "The Harbour Almanac", sha256: sha("C") }],
        mail: [
          { to: "pocketbook@example.invalid", attachments: [sha("C")] },
          { to: "other@example.invalid", attachments: [sha("C")] },
          { to: "pocketbook@example.invalid", attachments: [] },
        ],
        events: 1,
      })
    })

    it.each([
      ["not JSON", "{"],
      ["no object", "null"],
      ["a message that is not an object", JSON.stringify({ library: [], mail: [null], events: [] })],
      ["no library", JSON.stringify({ mail: [], events: [] })],
      ["a book without a hash", JSON.stringify({ library: [{ id: 1, title: "x" }], mail: [], events: [] })],
      ["mail without recipients", JSON.stringify({ library: [], mail: [{ attachments: [] }], events: [] })],
      ["an attachment without a hash", JSON.stringify({ library: [], mail: [{ to: ["a@example.invalid"], attachments: [{}] }], events: [] })],
      ["no events", JSON.stringify({ library: [], mail: [] })],
    ])("refuses a state file with %s", (_why, text) => {
      const file = path.join(root, "state.json")
      fs.writeFileSync(file, text)
      expect(() => readHouseholdState(file)).toThrow(/household state/)
    })
  })

  describe("mergeTimeline", () => {
    const hostCalls: TraceCall[] = [
      { kind: "call", name: "shell", args: "{\"command\":\"books check a.epub\"}", result: "{\"ok\":true}" },
      { kind: "call", name: "settle", args: "{\"answer\":\"done\"}", result: "" },
    ]

    it("keeps the guest's order of calls and replies, with each call as the host served it", () => {
      const guest = [
        { kind: "call" as const, name: "shell", args: "{\"command\":\"books check a.epub\"}", result: "forged" },
        { kind: "reply" as const, text: "on it" },
        { kind: "call" as const, name: "settle", args: "{\"answer\":\"done\"}", result: "" },
        { kind: "reply" as const, text: "done" },
      ]
      expect(mergeTimeline(guest, hostCalls)).toEqual({
        timeline: [hostCalls[0], { kind: "reply", text: "on it" }, hostCalls[1], { kind: "reply", text: "done" }],
        mismatch: false,
      })
    })

    it("flags a guest trace whose calls differ from what the provider returned, and keeps the host's calls", () => {
      const guest = [{ kind: "call" as const, name: "shell", args: "{\"command\":\"books text a.epub\"}", result: "" }]
      const merged = mergeTimeline(guest, hostCalls)
      expect(merged.mismatch).toBe(true)
      expect(merged.timeline.filter((entry) => entry.kind === "call")).toEqual(hostCalls)
    })
  })

  describe("assembleObservation", () => {
    it("builds the observation from the host's sources and grades only unlabelled hashes with the oracle", async () => {
      write(root, "bundle/books/work/1/rebuilt.epub", "rebuilt")
      const asked: string[] = []
      const obs = await assembleObservation({
        seed: seedWith([sha("A0")]),
        turn: { timeline: [{ kind: "reply", text: "done" }], finalReply: "done", outcome: "settled" },
        hostCalls: [],
        steps: 3,
        household: {
          library: [{ id: 190, title: "The Harbour Almanac", sha256: sha("rebuilt") }, { id: 191, title: "Mystery", sha256: sha("nowhere") }],
          mail: [{ to: "pocketbook@example.invalid", attachments: [sha("rebuilt"), sha("C")] }],
          events: 4,
        },
        created: [{ path: "books/work/1/rebuilt.epub", sha256: sha("rebuilt") }],
        bytes: new Map([[sha("rebuilt"), path.join(root, "bundle/books/work/1/rebuilt.epub")]]),
        oracle: async (file) => { asked.push(fs.readFileSync(file, "utf8")); return true },
      })
      expect(asked).toEqual(["rebuilt"])
      expect(obs).toEqual({
        timeline: [{ kind: "reply", text: "done" }],
        finalReply: "done",
        library: [{ id: 190, title: "The Harbour Almanac", sha256: sha("rebuilt") }, { id: 191, title: "Mystery", sha256: sha("nowhere") }],
        mail: [{ to: "pocketbook@example.invalid", attachments: [sha("rebuilt"), sha("C")] }],
        created: [{ path: "books/work/1/rebuilt.epub", sha256: sha("rebuilt") }],
        outcome: "settled",
        steps: 3,
        oracle: { [sha("rebuilt")]: true },
      })
    })

    it("grades nothing without an oracle, and a trace mismatch becomes the outcome", async () => {
      const obs = await assembleObservation({
        seed: seedWith([]),
        turn: { timeline: [{ kind: "call", name: "shell", args: "{}", result: "" }], finalReply: "", outcome: "settled" },
        hostCalls: [],
        steps: 1,
        household: { library: [{ id: 190, title: "x", sha256: sha("rebuilt") }], mail: [], events: 0 },
        created: [],
        bytes: new Map([[sha("rebuilt"), path.join(root, "nowhere")]]),
      })
      expect(obs.oracle).toEqual({})
      expect(obs.outcome).toBe("trace-mismatch")
      expect(obs.timeline).toEqual([])
    })
  })
})
