import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { atomicWriteFile, readBoundedResponse, storeDownloadedAttachment } from "../../../heart/attachments/downloaded-store"
import { getRecentAttachment } from "../../../heart/attachments/store"
import { materializeAttachment } from "../../../heart/attachments/materialize"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "downloaded-store-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("readBoundedResponse", () => {
  it("reads a body within the limit", async () => {
    await expect(readBoundedResponse(new Response("hello"), 10)).resolves.toEqual(Buffer.from("hello"))
  })

  it("refuses an advertised size over the limit before reading", async () => {
    const response = new Response("hello", { headers: { "content-length": "999" } })
    await expect(readBoundedResponse(response, 10)).rejects.toThrow("advertised size exceeds limit")
  })

  it("stops reading once the body passes the limit", async () => {
    await expect(readBoundedResponse(new Response("hello world"), 5)).rejects.toThrow("download exceeds limit")
  })

  it("still reports the limit when the stream also fails to cancel", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("far too long")) },
      cancel() { throw new Error("cancel failed") },
    })
    await expect(readBoundedResponse(new Response(body), 3)).rejects.toThrow("download exceeds limit")
  })

  it("refuses an empty body", async () => {
    await expect(readBoundedResponse(new Response(null), 5)).rejects.toThrow("empty response body")
  })
})

describe("atomicWriteFile", () => {
  it("writes the whole file into a new folder and leaves no temporary behind", async () => {
    const target = path.join(root, "nested", "file.bin")
    await atomicWriteFile(target, Buffer.from("bytes"))
    expect(fs.readFileSync(target, "utf8")).toBe("bytes")
    expect(fs.readdirSync(path.dirname(target))).toEqual(["file.bin"])
  })

  it("cleans up its temporary and reports the failure when the rename fails", async () => {
    const target = path.join(root, "dir-in-the-way")
    fs.mkdirSync(path.join(target, "occupied"), { recursive: true })
    await expect(atomicWriteFile(target, Buffer.from("bytes"))).rejects.toThrow()
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
    return (await import("../../../heart/attachments/downloaded-store")).atomicWriteFile
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

describe("storeDownloadedAttachment", () => {
  it("keeps the file under the sense's own folder and remembers it for the tools", async () => {
    const record = await storeDownloadedAttachment({
      agentName: "butler",
      agentRoot: root,
      source: "teams",
      sourceId: "abc123",
      displayName: "clip.ogg",
      mimeType: "audio/ogg",
      buffer: Buffer.from("ogg"),
    })
    expect(record).toMatchObject({ id: "attachment:teams:abc123", source: "teams", kind: "audio", byteCount: 3 })
    expect(record.sourceData.localPath.startsWith(path.join(root, "state", "attachments", "materialized", "teams") + path.sep)).toBe(true)
    expect(fs.readFileSync(record.sourceData.localPath, "utf8")).toBe("ogg")
    expect(getRecentAttachment("butler", record.id, root)?.source).toBe("teams")
    await expect(materializeAttachment("butler", record.id, { agentRoot: root })).resolves.toMatchObject({ path: record.sourceData.localPath })
  })
})
