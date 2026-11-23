import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGuardedFs, type GuardedFs } from "../../../eval/watch/guarded-fs"
import { readNewLines } from "../../../eval/watch/log-reader"

describe("Watch's log reader", () => {
  let tmp: string
  let logs: string
  let active: string
  let gfs: GuardedFs

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-reader-")))
    logs = path.join(tmp, "AgentBundles", "a.ouro", "state", "daemon", "logs")
    fs.mkdirSync(logs, { recursive: true })
    active = path.join(logs, "bluebubbles.ndjson")
    gfs = createGuardedFs({ protectedRoots: [path.join(tmp, "AgentBundles")], privateDir: path.join(tmp, "private") })
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  /** Rotates as the nerves sink does: the active file becomes generation 1, gzipped, and a new active file starts. */
  const rotate = (gzip = true) => {
    const one = path.join(logs, "bluebubbles.1.ndjson")
    fs.renameSync(active, one)
    if (gzip) {
      fs.writeFileSync(path.join(logs, "bluebubbles.1.ndjson.gz"), zlib.gzipSync(fs.readFileSync(one)))
      fs.unlinkSync(one)
    }
  }

  it("reads a new file from the start, then only lines added since", () => {
    fs.writeFileSync(active, "a\nb\n")
    const first = readNewLines(gfs, active, undefined)
    expect(first).toMatchObject({ lines: ["a", "b"], gap: false })
    fs.appendFileSync(active, "c\n")
    const second = readNewLines(gfs, active, first.cursor)
    expect(second.lines).toEqual(["c"])
    expect(readNewLines(gfs, active, second.cursor).lines).toEqual([])
  })

  it("leaves a half-written last line for the next run", () => {
    fs.writeFileSync(active, "a\nhal")
    const first = readNewLines(gfs, active, undefined)
    expect(first.lines).toEqual(["a"])
    fs.appendFileSync(active, "f\n")
    expect(readNewLines(gfs, active, first.cursor).lines).toEqual(["half"])
  })

  it("reads nothing, and keeps no cursor, for a file that doesn't exist", () => {
    expect(readNewLines(gfs, active, undefined)).toEqual({ lines: [], cursor: undefined, gap: false, more: false })
  })

  it("after a rotation, finishes the rotated generation and then reads the new file, counting nothing twice", () => {
    fs.writeFileSync(active, "a\nb\n")
    const first = readNewLines(gfs, active, undefined)
    fs.appendFileSync(active, "c\n")
    rotate()
    fs.writeFileSync(active, "d\n")
    const second = readNewLines(gfs, active, first.cursor)
    expect(second).toMatchObject({ lines: ["c", "d"], gap: false })
    expect(readNewLines(gfs, active, second.cursor).lines).toEqual([])
  })

  it("reads a rotated generation left uncompressed", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    fs.appendFileSync(active, "b\n")
    rotate(false)
    fs.writeFileSync(active, "c\n")
    expect(readNewLines(gfs, active, first.cursor).lines).toEqual(["b", "c"])
  })

  it("after a rotation it can't match, reports a gap and reads the new file from the start", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    rotate()
    fs.writeFileSync(path.join(logs, "bluebubbles.1.ndjson.gz"), zlib.gzipSync(Buffer.from("other\n")))
    fs.writeFileSync(active, "z\n")
    expect(readNewLines(gfs, active, first.cursor)).toMatchObject({ lines: ["z"], gap: true })
  })

  it("treats an unreadable rotated generation as a gap", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    rotate()
    fs.writeFileSync(path.join(logs, "bluebubbles.1.ndjson.gz"), "not gzip")
    fs.writeFileSync(active, "z\n")
    expect(readNewLines(gfs, active, first.cursor)).toMatchObject({ lines: ["z"], gap: true })
  })

  it("reads the plain copy while a rotation's gzip is still being written", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    fs.appendFileSync(active, "b\n")
    rotate(false)
    fs.writeFileSync(path.join(logs, "bluebubbles.1.ndjson.gz"), zlib.gzipSync(Buffer.from("a\nb\n")).subarray(0, 8))
    fs.writeFileSync(active, "c\n")
    expect(readNewLines(gfs, active, first.cursor)).toMatchObject({ lines: ["b", "c"], gap: false })
  })

  it("reads a large file in parts, each cursor part-way in", () => {
    fs.writeFileSync(active, "aaaa\nbbbb\ncccc\n")
    const first = readNewLines(gfs, active, undefined, 11)
    expect(first).toMatchObject({ lines: ["aaaa", "bbbb"], more: true })
    const second = readNewLines(gfs, active, first.cursor, 11)
    expect(second).toMatchObject({ lines: ["cccc"], more: false })
  })

  it("skips a line longer than a whole part as a gap, and goes on after it", () => {
    fs.writeFileSync(active, `${"x".repeat(30)}\nnext\n`)
    const first = readNewLines(gfs, active, undefined, 11)
    expect(first).toMatchObject({ lines: [], gap: true, more: true })
    let cursor = first.cursor
    const seen: string[] = []
    for (let run = 0; run < 5 && cursor; run++) {
      const result = readNewLines(gfs, active, cursor, 11)
      seen.push(...result.lines)
      cursor = result.cursor
      if (!result.more) break
    }
    expect(seen).toContain("next")
  })

  it("never matches a rotated generation to a cursor that has no head", () => {
    fs.writeFileSync(active, "half")
    const first = readNewLines(gfs, active, undefined)
    expect(first.cursor?.headLength).toBe(0)
    rotate()
    fs.writeFileSync(active, "z\n")
    expect(readNewLines(gfs, active, first.cursor)).toMatchObject({ lines: ["z"], gap: true })
  })

  it("treats a file rewritten in place as a new file", () => {
    fs.writeFileSync(active, "first line\n")
    const first = readNewLines(gfs, active, undefined)
    fs.unlinkSync(active)
    fs.writeFileSync(active, "x\n")
    expect(readNewLines(gfs, active, first.cursor)).toMatchObject({ lines: ["x"], gap: true })
  })

  it("finishes a rotated generation before the new file exists, then reads the new file whole", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    fs.appendFileSync(active, "b\n")
    rotate()
    const second = readNewLines(gfs, active, first.cursor)
    expect(second).toEqual({ lines: ["b"], cursor: undefined, gap: false, more: false })
    fs.writeFileSync(active, "c\n")
    expect(readNewLines(gfs, active, second.cursor).lines).toEqual(["c"])
  })

  it("keeps the cursor when the file is missing for now", () => {
    fs.writeFileSync(active, "a\n")
    const first = readNewLines(gfs, active, undefined)
    fs.unlinkSync(active)
    expect(readNewLines(gfs, active, first.cursor)).toEqual({ lines: [], cursor: first.cursor, gap: false, more: false })
  })
})
