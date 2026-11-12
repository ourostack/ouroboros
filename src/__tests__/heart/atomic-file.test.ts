import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, openSync: vi.fn(actual.openSync), fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) }
})

import { writeFileAtomicSync, writeJsonAtomicSync } from "../../heart/atomic-file"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-"))
})

afterEach(() => {
  vi.mocked(fs.openSync).mockClear()
  vi.mocked(fs.renameSync).mockClear()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("writeFileAtomicSync", () => {
  it("creates the folder, writes a private file and leaves no temporary behind", () => {
    const target = path.join(root, "a", "b", "state.txt")
    writeFileAtomicSync(target, "hello")
    expect(fs.readFileSync(target, "utf8")).toBe("hello")
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(target))).toEqual(["state.txt"])
  })

  it("replaces an existing file and honours a requested mode", () => {
    const target = path.join(root, "state.txt")
    fs.writeFileSync(target, "old")
    writeFileAtomicSync(target, Buffer.from("new"), { mode: 0o640 })
    expect(fs.readFileSync(target, "utf8")).toBe("new")
    expect(fs.statSync(target).mode & 0o777).toBe(0o640)
  })

  it("keeps the temporary in a separate folder when asked, so readers of the target folder never see it", () => {
    const target = path.join(root, "outbox", "entry.json")
    const scratch = path.join(root, "outbox-tmp")
    const seen: string[][] = []
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      seen.push(fs.readdirSync(path.dirname(target)))
      expect(path.dirname(String(from))).toBe(scratch)
      fs.copyFileSync(from, to)
      fs.unlinkSync(from)
    })
    writeFileAtomicSync(target, "x", { temporaryDirectory: scratch })
    expect(seen).toEqual([[]])
    expect(fs.readdirSync(scratch)).toEqual([])
  })

  it("never lets two writes in one process share a temporary", () => {
    const target = path.join(root, "state.txt")
    writeFileAtomicSync(target, "one")
    writeFileAtomicSync(target, "two")
    const temporaries = new Set(vi.mocked(fs.openSync).mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".tmp")))
    expect(temporaries.size).toBe(2)
    expect(fs.readFileSync(target, "utf8")).toBe("two")
  })

  it("removes its temporary and keeps the old contents when the write fails", () => {
    const target = path.join(root, "state.txt")
    fs.writeFileSync(target, "old")
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error("disk full") })
    expect(() => writeFileAtomicSync(target, "new")).toThrow("disk full")
    expect(fs.readFileSync(target, "utf8")).toBe("old")
    expect(fs.readdirSync(root)).toEqual(["state.txt"])
  })

  it("reports a failure that is not an Error", () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw "rename refused" })
    expect(() => writeFileAtomicSync(path.join(root, "state.txt"), "x")).toThrow("rename refused")
    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe("writeJsonAtomicSync", () => {
  it("writes pretty JSON with a trailing newline", () => {
    const target = path.join(root, "state.json")
    writeJsonAtomicSync(target, { a: 1 })
    expect(fs.readFileSync(target, "utf8")).toBe('{\n  "a": 1\n}\n')
  })
})
