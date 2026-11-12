import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeFileAtomic } from "../../heart/atomic-file"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-async-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("writeFileAtomic", () => {
  it("writes the whole file into a new folder and leaves no temporary behind", async () => {
    const target = path.join(root, "nested", "file.bin")
    await writeFileAtomic(target, Buffer.from("bytes"))
    expect(fs.readFileSync(target, "utf8")).toBe("bytes")
    expect(fs.readdirSync(path.dirname(target))).toEqual(["file.bin"])
  })

  it("cleans up its temporary and reports the failure when the rename fails", async () => {
    const target = path.join(root, "dir-in-the-way")
    fs.mkdirSync(path.join(target, "occupied"), { recursive: true })
    await expect(writeFileAtomic(target, Buffer.from("bytes"))).rejects.toThrow()
    expect(fs.readdirSync(root)).toEqual(["dir-in-the-way"])
  })
})

describe("atomicWriteFile when the disk misbehaves", () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock("node:fs/promises")
  })

  async function loadWithBrokenWrite(unlinkCode: string) {
    vi.resetModules()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.doMock("node:fs/promises", () => ({
      ...actual,
      open: vi.fn(async () => ({ writeFile: vi.fn().mockRejectedValue(new Error("disk full")), close: vi.fn().mockRejectedValue(new Error("close failed")) })),
      unlink: vi.fn().mockRejectedValue(Object.assign(new Error(`unlink ${unlinkCode}`), { code: unlinkCode })),
    }))
    return (await import("../../heart/atomic-file")).writeFileAtomic
  }

  it("reports the write failure even when closing and an already-gone temporary fail too", async () => {
    const write = await loadWithBrokenWrite("ENOENT")
    await expect(write(path.join(root, "f"), Buffer.from("x"))).rejects.toThrow("disk full")
  })

  it("surfaces a temporary it could not remove", async () => {
    const write = await loadWithBrokenWrite("EACCES")
    await expect(write(path.join(root, "f"), Buffer.from("x"))).rejects.toThrow("unlink EACCES")
  })
})

