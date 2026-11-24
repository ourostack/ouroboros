import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { pruneProvenMailroomCopies, type HostedMailCopies, type HostedMailMessageRecord } from "../../../heart/daemon/mailroom-copy-proof"
import { hostedMessageStorageId } from "../../../mailroom/core"

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")

interface LocalMail {
  id: string
  hostedId: string
  raw: Buffer
  messagePath: string
  rawPath: string
}

/** Writes one gzipped local copy, the way retention leaves it: messages/<id>.json.gz and raw/<id>.eml.gz. */
function writeLocalMail(root: string, n: number, overrides: { rawSha256?: string; rawSize?: number } = {}): LocalMail {
  const raw = Buffer.from(`From: sender${n}@example.com\r\nSubject: synthetic ${n}\r\n\r\nbody ${n} ${"x".repeat(300)}\r\n`)
  const id = `mail_${String(n).padStart(32, "0")}`
  const envelope = { mailFrom: `sender${n}@example.com`, rcptTo: ["slugger@ouro.bot"] }
  const message = {
    schemaVersion: 1,
    id,
    agentId: "slugger",
    mailboxId: "mailbox_slugger",
    recipient: "Slugger@Ouro.bot",
    envelope,
    rawObject: `raw/${id}.eml`,
    rawSha256: overrides.rawSha256 ?? sha(raw),
    rawSize: overrides.rawSize ?? raw.byteLength,
    bodyForm: "plaintext",
    private: { subject: `synthetic ${n}` },
  }
  const messagePath = path.join(root, "messages", `${id}.json.gz`)
  const rawPath = path.join(root, "raw", `${id}.eml.gz`)
  fs.mkdirSync(path.dirname(messagePath), { recursive: true })
  fs.mkdirSync(path.dirname(rawPath), { recursive: true })
  fs.writeFileSync(messagePath, zlib.gzipSync(Buffer.from(JSON.stringify(message))))
  fs.writeFileSync(rawPath, zlib.gzipSync(raw))
  const hostedId = hostedMessageStorageId(envelope, raw, { agentId: "slugger", mailboxId: "mailbox_slugger", address: "Slugger@Ouro.bot" })
  return { id, hostedId, raw, messagePath, rawPath }
}

/** A fake Blob container: messages/<id>.json records and raw object sizes. */
class FakeBlob implements HostedMailCopies {
  messages = new Map<string, HostedMailMessageRecord>()
  rawSizes = new Map<string, number>()
  failMessageReads = false
  readMessage = vi.fn(async (id: string) => {
    if (this.failMessageReads) throw new Error("AuthorizationFailure")
    return this.messages.get(id) ?? null
  })
  rawObjectSize = vi.fn(async (name: string) => this.rawSizes.get(name) ?? null)

  upload(mail: LocalMail, key = mail.hostedId, overrides: Partial<HostedMailMessageRecord> = {}): void {
    const rawObject = `raw/${key}.fingerprint.json`
    this.messages.set(key, { rawSha256: sha(mail.raw), rawSize: mail.raw.byteLength, rawObject, ...overrides })
    this.rawSizes.set(rawObject, 2048)
  }
}

describe("pruneProvenMailroomCopies", () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mailroom-proof-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("deletes a gzipped local copy only once Blob holds the same mail under its hosted key", async () => {
    const blob = new FakeBlob()
    const proven = writeLocalMail(root, 1)
    blob.upload(proven)
    const size = fs.statSync(proven.messagePath).size + fs.statSync(proven.rawPath).size

    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })

    expect(fs.existsSync(proven.messagePath)).toBe(false)
    expect(fs.existsSync(proven.rawPath)).toBe(false)
    expect(result).toEqual(expect.objectContaining({ checked: 1, deleted: 1, bytesFreed: size, notInBlob: 0, mismatched: 0, unconfirmed: 0 }))
  })

  it("also accepts a copy Blob holds under the local id", async () => {
    const blob = new FakeBlob()
    const mail = writeLocalMail(root, 2)
    blob.upload(mail, mail.id)
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result.deleted).toBe(1)
    expect(fs.existsSync(mail.messagePath)).toBe(false)
  })

  it("keeps a copy whose upload is missing from Blob", async () => {
    const blob = new FakeBlob()
    const missing = writeLocalMail(root, 3)
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ checked: 1, deleted: 0, notInBlob: 1 }))
    expect(fs.existsSync(missing.messagePath)).toBe(true)
    expect(fs.existsSync(missing.rawPath)).toBe(true)
  })

  it("keeps a copy whose Blob record has a different size or hash", async () => {
    const blob = new FakeBlob()
    const wrongSize = writeLocalMail(root, 4)
    blob.upload(wrongSize, wrongSize.hostedId, { rawSize: wrongSize.raw.byteLength + 1 })
    const wrongHash = writeLocalMail(root, 5)
    blob.upload(wrongHash, wrongHash.hostedId, { rawSha256: "0".repeat(64) })
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ checked: 2, deleted: 0, mismatched: 2 }))
    for (const mail of [wrongSize, wrongHash]) {
      expect(fs.existsSync(mail.messagePath)).toBe(true)
      expect(fs.existsSync(mail.rawPath)).toBe(true)
    }
  })

  it("keeps a copy whose raw object is missing or empty in Blob", async () => {
    const blob = new FakeBlob()
    const noRaw = writeLocalMail(root, 6)
    blob.upload(noRaw)
    blob.rawSizes.clear()
    const emptyRaw = writeLocalMail(root, 7)
    blob.upload(emptyRaw)
    blob.rawSizes.set(`raw/${emptyRaw.hostedId}.fingerprint.json`, 0)
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ deleted: 0, notInBlob: 2 }))
  })

  it("keeps everything it can't confirm when Blob can't be read", async () => {
    const blob = new FakeBlob()
    const mail = writeLocalMail(root, 8)
    blob.upload(mail)
    blob.failMessageReads = true
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ checked: 1, deleted: 0, unconfirmed: 1 }))
    expect(fs.existsSync(mail.messagePath)).toBe(true)
  })

  it("keeps a local copy whose own raw file doesn't match its record, or has no raw file", async () => {
    const blob = new FakeBlob()
    const corrupt = writeLocalMail(root, 9, { rawSize: 1 })
    blob.upload(corrupt)
    const orphan = writeLocalMail(root, 10)
    blob.upload(orphan)
    fs.rmSync(orphan.rawPath)
    fs.mkdirSync(path.join(root, "messages"), { recursive: true })
    fs.writeFileSync(path.join(root, "messages", "mail_bad.json.gz"), Buffer.from("not gzip"))
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ checked: 3, deleted: 0, localInvalid: 3 }))
    expect(fs.existsSync(corrupt.messagePath)).toBe(true)
    expect(fs.existsSync(orphan.messagePath)).toBe(true)
  })

  it("leaves files that aren't gzipped yet, and stops at the per-pass limit", async () => {
    const blob = new FakeBlob()
    const mails = [writeLocalMail(root, 11), writeLocalMail(root, 12), writeLocalMail(root, 13)]
    for (const mail of mails) blob.upload(mail)
    fs.writeFileSync(path.join(root, "messages", "mail_plain.json"), "{}")
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob, maxPerPass: 2 })
    expect(result).toEqual(expect.objectContaining({ checked: 2, deleted: 2, deferred: 1 }))
    expect(fs.existsSync(path.join(root, "messages", "mail_plain.json"))).toBe(true)
    expect(fs.existsSync(mails[2].messagePath)).toBe(true)
  })

  it("keeps a copy that changed while it was being checked", async () => {
    const blob = new FakeBlob()
    const mail = writeLocalMail(root, 14)
    blob.upload(mail)
    blob.rawObjectSize.mockImplementationOnce(async (name: string) => {
      fs.appendFileSync(mail.rawPath, Buffer.from([0]))
      return blob.rawSizes.get(name) ?? null
    })
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ deleted: 0, changed: 1 }))
    expect(fs.existsSync(mail.messagePath)).toBe(true)
  })

  it("keeps a local record that is missing fields or points outside raw/", async () => {
    const blob = new FakeBlob()
    const write = (name: string, record: unknown) =>
      fs.writeFileSync(path.join(root, "messages", name), zlib.gzipSync(Buffer.from(JSON.stringify(record))))
    fs.mkdirSync(path.join(root, "messages"), { recursive: true })
    write("mail_nofields.json.gz", { id: "mail_nofields" })
    write("mail_escape.json.gz", { id: "mail_escape", rawObject: "../outside", rawSha256: "h", rawSize: 1 })
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ checked: 2, localInvalid: 2, deleted: 0 }))
    expect(blob.readMessage).not.toHaveBeenCalled()
  })

  it("checks only the local id when the record has no destination", async () => {
    const blob = new FakeBlob()
    const mail = writeLocalMail(root, 15)
    const record = JSON.parse(zlib.gunzipSync(fs.readFileSync(mail.messagePath)).toString()) as Record<string, unknown>
    delete record.mailboxId
    fs.writeFileSync(mail.messagePath, zlib.gzipSync(Buffer.from(JSON.stringify(record))))
    blob.upload(mail, mail.id)
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(blob.readMessage.mock.calls.map(([id]) => id)).toEqual([mail.id])
    expect(result.deleted).toBe(1)
  })

  it("keeps a copy whose Blob record names no raw object", async () => {
    const blob = new FakeBlob()
    const mail = writeLocalMail(root, 16)
    blob.upload(mail, mail.hostedId, { rawObject: undefined })
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ deleted: 0, notInBlob: 1 }))
    expect(blob.rawObjectSize).not.toHaveBeenCalled()
  })

  it("keeps a copy whose message record was removed or rewritten while it was checked", async () => {
    const blob = new FakeBlob()
    const removed = writeLocalMail(root, 17)
    const rewritten = writeLocalMail(root, 18)
    blob.upload(removed)
    blob.upload(rewritten)
    blob.rawObjectSize.mockImplementationOnce(async () => {
      fs.rmSync(removed.messagePath)
      return 10
    })
    blob.rawObjectSize.mockImplementationOnce(async () => {
      fs.appendFileSync(rewritten.messagePath, Buffer.from([0]))
      return 10
    })
    const result = await pruneProvenMailroomCopies({ mailroomRoot: root, hosted: blob })
    expect(result).toEqual(expect.objectContaining({ deleted: 0, changed: 2 }))
    expect(fs.existsSync(removed.rawPath)).toBe(true)
    expect(fs.existsSync(rewritten.rawPath)).toBe(true)
  })

  it("does nothing when there is no messages folder", async () => {
    const result = await pruneProvenMailroomCopies({ mailroomRoot: path.join(root, "absent"), hosted: new FakeBlob() })
    expect(result.checked).toBe(0)
  })
})
