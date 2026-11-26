import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Letter, LetterEvent } from "../../../heart/letters/letter"
import { LetterStore, type StoreIo } from "../../../heart/letters/store"

const roots: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "letters-store-"))
  roots.push(dir)
  return path.join(dir, "state", "letters")
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function letter(id: string, code = "L1"): Letter {
  return {
    v: 1, id: `ltr_${id}`, code, to: "friend-ari", from: { agent: "slugger" }, kind: "know", subject: "Heads up", body: "",
    options: [{ id: "1", label: "got it", effect: "e" }], links: [], urgency: "whenever", createdAt: "2026-11-23T10:00:00.000Z",
  }
}

const seen: LetterEvent = { t: "seen", at: "2026-11-23T11:00:00.000Z", via: "web" }
const withdrawn: LetterEvent = { t: "withdrawn", at: "2026-11-23T12:00:00.000Z", reason: "moot" }

/** The real fs, with every fsync recorded by the path it was opened with. */
function recordingIo(): { io: StoreIo; synced: string[] } {
  const synced: string[] = []
  const paths = new Map<number, string>()
  const io: StoreIo = {
    ...fs,
    openSync: ((file: string, flags: string, mode?: number) => {
      const fd = fs.openSync(file, flags, mode)
      paths.set(fd, file)
      return fd
    }) as StoreIo["openSync"],
    fsyncSync: (fd: number) => {
      synced.push(paths.get(fd)!)
      fs.fsyncSync(fd)
    },
  }
  return { io, synced }
}

describe("LetterStore", () => {
  it("creates a letter as one JSON line, syncing the file and its folder", () => {
    const dir = tempDir()
    const { io, synced } = recordingIo()
    const store = new LetterStore(dir, io)
    store.create(letter("A"))
    const file = path.join(dir, "ltr_A.jsonl")
    expect(fs.readFileSync(file, "utf8")).toBe(`${JSON.stringify(letter("A"))}\n`)
    // The new state/ and state/letters/ folders are synced into their parents first.
    expect(synced).toEqual([path.dirname(dir), path.dirname(path.dirname(dir)), file, dir])
  })

  it("syncs only the folder when it already exists", () => {
    const dir = tempDir()
    fs.mkdirSync(dir, { recursive: true })
    const { io, synced } = recordingIo()
    new LetterStore(dir, io).create(letter("A"))
    expect(synced).toEqual([path.join(dir, "ltr_A.jsonl"), dir])
  })

  it("discards a failed create's file and says when one is left", () => {
    const dir = tempDir()
    const { io, synced } = recordingIo()
    const store = new LetterStore(dir, io)
    store.create(letter("A"))
    synced.length = 0
    expect(store.discard("ltr_A")).toBe(true)
    expect(fs.existsSync(path.join(dir, "ltr_A.jsonl"))).toBe(false)
    expect(synced).toEqual([dir])
    expect(store.discard("ltr_A")).toBe(true)
    store.create(letter("B"))
    const stuck = new LetterStore(dir, { ...fs, unlinkSync: () => { throw new Error("EPERM") } })
    expect(stuck.discard("ltr_B")).toBe(false)
    expect(fs.existsSync(path.join(dir, "ltr_B.jsonl"))).toBe(true)
  })

  it("refuses to create a letter whose file already exists", () => {
    const store = new LetterStore(tempDir())
    store.create(letter("A"))
    expect(() => store.create(letter("A"))).toThrow(/EEXIST/)
  })

  it("appends each event as a line and syncs it", () => {
    const dir = tempDir()
    const { io, synced } = recordingIo()
    const store = new LetterStore(dir, io)
    store.create(letter("A"))
    store.append("ltr_A", seen)
    expect(synced.at(-1)).toBe(path.join(dir, "ltr_A.jsonl"))
    expect(store.read("ltr_A")).toEqual({ letter: letter("A"), events: [seen], closed: false })
  })

  it("cuts a torn last line back to the last newline before appending, so it never fuses with the next event", () => {
    const dir = tempDir()
    const store = new LetterStore(dir)
    store.create(letter("A"))
    const file = path.join(dir, "ltr_A.jsonl")
    // A crash mid-append leaves half a line.
    fs.appendFileSync(file, '{"t":"seen","at":"2026-11-2')
    expect(store.read("ltr_A")!.events).toEqual([])
    store.append("ltr_A", withdrawn)
    expect(fs.readFileSync(file, "utf8")).toBe(`${JSON.stringify(letter("A"))}\n${JSON.stringify(withdrawn)}\n`)
  })

  it("skips a whole line that isn't JSON, and keeps reading the rest", () => {
    const dir = tempDir()
    const store = new LetterStore(dir)
    store.create(letter("A"))
    fs.appendFileSync(path.join(dir, "ltr_A.jsonl"), `not json\nnull\n[]\n{"t":7,"at":"x"}\n{"t":"seen"}\n${JSON.stringify(seen)}\n`)
    expect(store.read("ltr_A")!.events).toEqual([seen])
  })

  it("reads nothing from a file whose first line isn't a whole letter, or names another letter", () => {
    const dir = tempDir()
    const store = new LetterStore(dir)
    fs.mkdirSync(dir, { recursive: true })
    const { createdAt: _createdAt, ...noCreatedAt } = letter("C")
    const broken: Array<[string, unknown]> = [
      ["ltr_V", { ...letter("V"), v: 2 }],
      ["ltr_W", letter("other")],
      ["ltr_C", noCreatedAt],
      ["ltr_D", { ...letter("D"), code: "7" }],
      ["ltr_E", { ...letter("E"), code: 7 }],
      ["ltr_F", { ...letter("F"), kind: 1 }],
      ["ltr_G", { ...letter("G"), subject: null }],
      ["ltr_H", { ...letter("H"), options: "none" }],
      ["ltr_I", { ...letter("I"), from: "slugger" }],
      ["ltr_K", { ...letter("K"), from: { agent: 3 } }],
    ]
    for (const [id, first] of broken) {
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify(first)}\n`)
      expect([id, store.read(id)]).toEqual([id, null])
    }
  })

  it("reads nothing for a letter it doesn't have, or one whose first line is torn", () => {
    const dir = tempDir()
    const store = new LetterStore(dir)
    expect(store.read("ltr_missing")).toBeNull()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "ltr_T.jsonl"), '{"v":1,"id":"ltr_T"')
    expect(store.read("ltr_T")).toBeNull()
    fs.writeFileSync(path.join(dir, "ltr_N.jsonl"), "[]\n")
    expect(store.read("ltr_N")).toBeNull()
    fs.writeFileSync(path.join(dir, "ltr_J.jsonl"), `not json\n${JSON.stringify(seen)}\n`)
    expect(store.read("ltr_J")).toBeNull()
  })

  it("refuses an id that could leave the letters folder", () => {
    const store = new LetterStore(tempDir())
    expect(() => store.read("../secrets")).toThrow(/not a letter id/)
    expect(() => store.append("ltr_../x", seen)).toThrow(/not a letter id/)
  })

  it("rolls a closed letter into closed/YYYY-MM with a rename, syncing both folders, and still reads it", () => {
    const dir = tempDir()
    const { io, synced } = recordingIo()
    const store = new LetterStore(dir, io)
    store.create(letter("A"))
    store.append("ltr_A", withdrawn)
    synced.length = 0
    store.roll("ltr_A", new Date("2027-02-21T00:00:00.000Z"))
    const closedDir = path.join(dir, "closed", "2027-02")
    expect(fs.existsSync(path.join(dir, "ltr_A.jsonl"))).toBe(false)
    expect(fs.existsSync(path.join(closedDir, "ltr_A.jsonl"))).toBe(true)
    // closed/ and closed/2027-02/ are new, so their parents are synced before the rename.
    expect(synced).toEqual([path.join(dir, "closed"), dir, closedDir, dir])
    expect(store.read("ltr_A")).toEqual({ letter: letter("A"), events: [withdrawn], closed: true })
  })

  it("loads every letter, open and closed, and nothing else in the folder", () => {
    const dir = tempDir()
    const store = new LetterStore(dir)
    expect(store.loadAll()).toEqual([])
    store.create(letter("A", "L1"))
    store.create(letter("B", "L2"))
    store.append("ltr_B", withdrawn)
    store.roll("ltr_B", new Date("2027-02-21T00:00:00.000Z"))
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a letter")
    fs.writeFileSync(path.join(dir, "ltr_T.jsonl"), "{torn")
    fs.writeFileSync(path.join(dir, "closed", "2027-02", "ltr_U.jsonl"), "{torn")
    fs.writeFileSync(path.join(dir, "closed", "README"), "a stray file under closed/")
    const loaded = store.loadAll().sort((a, b) => a.letter.id.localeCompare(b.letter.id))
    expect(loaded.map((entry) => [entry.letter.id, entry.closed, entry.events.length])).toEqual([["ltr_A", false, 0], ["ltr_B", true, 1]])
  })

  it("keeps the next code in a file it replaces atomically, ignoring a temporary file a crash left behind", () => {
    const dir = tempDir()
    const { io, synced } = recordingIo()
    const store = new LetterStore(dir, io)
    expect(store.readNextCode()).toBe(1)
    store.writeNextCode(8)
    expect(store.readNextCode()).toBe(8)
    expect(synced).toEqual([path.dirname(dir), path.dirname(path.dirname(dir)), path.join(dir, "next-code.tmp"), dir])
    fs.writeFileSync(path.join(dir, "next-code.tmp"), "99")
    expect(store.readNextCode()).toBe(8)
    fs.writeFileSync(path.join(dir, "next-code"), "garbage")
    expect(store.readNextCode()).toBe(1)
  })
})
