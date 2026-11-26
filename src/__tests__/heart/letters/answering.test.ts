import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"
import { ANSWERING_FILE, normalizeAnsweringHandle, ownerFriendIds, readAnsweringHandles, setAnsweringHandle, writeAnsweringHandle } from "../../../heart/letters/answering"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function lettersDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "letters-answering-"))
  roots.push(root)
  return path.join(root, "state", "letters")
}

describe("normalizeAnsweringHandle", () => {
  it("writes phone numbers as E.164 and email addresses in lowercase", () => {
    expect(normalizeAnsweringHandle(" +1 (555) 123-4567 ")).toEqual({ ok: true, handle: "+15551234567" })
    expect(normalizeAnsweringHandle("+44 20.7946.0958")).toEqual({ ok: true, handle: "+442079460958" })
    expect(normalizeAnsweringHandle("Ari@Example.COM")).toEqual({ ok: true, handle: "ari@example.com" })
  })

  it("refuses a number without its country code instead of guessing one", () => {
    expect(normalizeAnsweringHandle("555-123-4567")).toEqual({ ok: false, problem: "\"555-123-4567\" has no country code. Write it with one, such as +15551234567." })
  })

  it("refuses what is neither a phone number nor an email address", () => {
    for (const raw of ["", "ari", "+0123456789", "+12", "ari@", "a b@example.com", "+1555123456789012"]) {
      expect([raw, normalizeAnsweringHandle(raw).ok]).toEqual([raw, false])
    }
    expect(normalizeAnsweringHandle("ari@")).toEqual({ ok: false, problem: "\"ari@\" isn't an email address or a phone number." })
  })
})

describe("answering handles file", () => {
  it("reads nobody's handle when the file is missing, torn or the wrong shape", () => {
    const dir = lettersDir()
    expect(readAnsweringHandles(dir)).toEqual({})
    fs.mkdirSync(dir, { recursive: true })
    for (const content of ["{torn", "null", "[]", "{\"handles\":[]}", "{\"handles\":\"x\"}", "{}"]) {
      fs.writeFileSync(path.join(dir, ANSWERING_FILE), content)
      expect([content, readAnsweringHandles(dir)]).toEqual([content, {}])
    }
    // A file that can't be read at all, here a folder in its place, reads as nobody's handle too.
    fs.rmSync(path.join(dir, ANSWERING_FILE))
    fs.mkdirSync(path.join(dir, ANSWERING_FILE))
    expect(readAnsweringHandles(dir)).toEqual({})
  })

  it("keeps only handles that normalise, normalised", () => {
    const dir = lettersDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ANSWERING_FILE), JSON.stringify({ v: 1, handles: { a: "+1 555 123 4567", b: 7, c: "nobody", d: "D@X.IO" } }))
    expect(readAnsweringHandles(dir)).toEqual({ a: "+15551234567", d: "d@x.io" })
  })

  it("sets one person's handle without touching the others, entries it can't use included", () => {
    const dir = lettersDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ANSWERING_FILE), JSON.stringify({ v: 1, handles: { odd: 7 } }))
    writeAnsweringHandle(dir, "friend-ari", "+15551234567")
    writeAnsweringHandle(dir, "friend-bo", "bo@example.com")
    writeAnsweringHandle(dir, "friend-ari", "ari@example.com")
    expect(JSON.parse(fs.readFileSync(path.join(dir, ANSWERING_FILE), "utf8")).handles).toEqual({ odd: 7, "friend-ari": "ari@example.com", "friend-bo": "bo@example.com" })
    expect(fs.readdirSync(dir)).toEqual([ANSWERING_FILE])
    expect(fs.statSync(path.join(dir, ANSWERING_FILE)).mode & 0o777).toBe(0o600)
  })

  it("refuses to replace a file that doesn't read, so nobody's handle is lost", () => {
    const dir = lettersDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ANSWERING_FILE), "{torn")
    expect(() => writeAnsweringHandle(dir, "friend-ari", "+15551234567")).toThrow(expect.objectContaining({ code: "answering-unreadable" }))
    expect(fs.readFileSync(path.join(dir, ANSWERING_FILE), "utf8")).toBe("{torn")
  })
})

describe("ownerFriendIds", () => {
  it("reads the bundle's own friends folder when no list is given", async () => {
    expect(await ownerFriendIds(path.dirname(path.dirname(lettersDir())), "ari")).toEqual([])
  })
})

describe("setAnsweringHandle", () => {
  const friend = (id: string, name: string, trustLevel: FriendRecord["trustLevel"] = "family", owner = "ari") =>
    ({ id, name, trustLevel, externalIds: [{ provider: "local", externalId: owner, linkedAt: "2026-01-01T00:00:00.000Z" }] }) as FriendRecord
  const bundle = () => path.dirname(path.dirname(lettersDir()))
  const owner = () => "ari"

  it("finds the person by id, or by name ignoring case, and sets their handle", async () => {
    const root = bundle()
    const list = async () => [friend("friend-ari", "Ari"), friend("friend-bo", "Bo", "friend", "bo")]
    await expect(setAnsweringHandle(root, "friend-ari", "ARI@x.io", { list, owner })).resolves.toBe("Ari (friend-ari) answers letters from ari@x.io. Letters filed from now on go to that chat; letters already filed keep the handle they were filed with.")
    await setAnsweringHandle(root, "ari", "+15551234567", { list, owner })
    expect(readAnsweringHandles(path.join(root, "state", "letters"))).toEqual({ "friend-ari": "+15551234567" })
  })

  it("refuses someone letters don't go to, naming who they do go to", async () => {
    const list = async () => [friend("friend-ari", "Ari"), friend("friend-bo", "Bo", "friend", "bo")]
    await expect(setAnsweringHandle(bundle(), "Bo", "+15551234567", { list, owner })).rejects.toEqual(expect.objectContaining({
      code: "not-recipient", message: "Bo (friend-bo) isn't who letters go to: that is the family record naming this machine's owner, friend-ari.",
    }))
    await expect(setAnsweringHandle(bundle(), "Bo", "+15551234567", { list, owner: () => "nobody" })).rejects.toEqual(expect.objectContaining({
      message: "Bo (friend-bo) isn't who letters go to: that is the family record naming this machine's owner.",
    }))
  })

  it("refuses a bad handle, an unknown person and a name two friends share, each with its code", async () => {
    const root = bundle()
    const list = async () => [friend("friend-a1", "Sam"), friend("friend-a2", "sam")]
    await expect(setAnsweringHandle(root, "Sam", "nope", { list, owner })).rejects.toEqual(expect.objectContaining({ code: "bad-handle" }))
    await expect(setAnsweringHandle(root, "Sam", "+15551234567", { list, owner })).rejects.toEqual(expect.objectContaining({ code: "which-person", message: "2 friends are named Sam: friend-a1, friend-a2. Pass one of those ids." }))
    await expect(setAnsweringHandle(root, "friend-a2", "+15551234567", { list, owner })).resolves.toMatch(/^sam \(friend-a2\)/)
    // With no list given it reads the bundle's own friends folder, empty here.
    await expect(setAnsweringHandle(root, "Ari", "+15551234567")).rejects.toEqual(expect.objectContaining({ code: "no-person" }))
  })
})
