import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"
import { ANSWERING_FILE, normalizeAnsweringHandle, readAnsweringHandles, setAnsweringHandle, writeAnsweringHandle } from "../../../heart/letters/answering"

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
  })

  it("keeps only handles that normalise, normalised", () => {
    const dir = lettersDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ANSWERING_FILE), JSON.stringify({ v: 1, handles: { a: "+1 555 123 4567", b: 7, c: "nobody", d: "D@X.IO" } }))
    expect(readAnsweringHandles(dir)).toEqual({ a: "+15551234567", d: "d@x.io" })
  })

  it("sets one person's handle without touching the others, replacing the file atomically", () => {
    const dir = lettersDir()
    writeAnsweringHandle(dir, "friend-ari", "+15551234567")
    writeAnsweringHandle(dir, "friend-bo", "bo@example.com")
    writeAnsweringHandle(dir, "friend-ari", "ari@example.com")
    expect(readAnsweringHandles(dir)).toEqual({ "friend-ari": "ari@example.com", "friend-bo": "bo@example.com" })
    expect(fs.readdirSync(dir)).toEqual([ANSWERING_FILE])
    expect(fs.statSync(path.join(dir, ANSWERING_FILE)).mode & 0o777).toBe(0o600)
  })
})

describe("setAnsweringHandle", () => {
  const friend = (id: string, name: string) => ({ id, name }) as FriendRecord
  const bundle = () => path.dirname(path.dirname(lettersDir()))

  it("finds the person by id, or by name ignoring case, and sets their handle", async () => {
    const root = bundle()
    const list = async () => [friend("friend-ari", "Ari"), friend("friend-bo", "Bo")]
    await expect(setAnsweringHandle(root, "friend-bo", "BO@x.io", list)).resolves.toBe("Bo (friend-bo) answers letters from bo@x.io. Letters filed from now on go to that chat; letters already filed keep the handle they were filed with.")
    await setAnsweringHandle(root, "ARI", "+15551234567", list)
    expect(readAnsweringHandles(path.join(root, "state", "letters"))).toEqual({ "friend-ari": "+15551234567", "friend-bo": "bo@x.io" })
  })

  it("refuses a bad handle, an unknown person and a name two friends share, each with its code", async () => {
    const root = bundle()
    const list = async () => [friend("friend-a1", "Sam"), friend("friend-a2", "sam")]
    await expect(setAnsweringHandle(root, "Sam", "nope", list)).rejects.toEqual(expect.objectContaining({ code: "bad-handle" }))
    await expect(setAnsweringHandle(root, "Sam", "+15551234567", list)).rejects.toEqual(expect.objectContaining({ code: "which-person", message: "2 friends are named Sam: friend-a1, friend-a2. Pass one of those ids." }))
    await expect(setAnsweringHandle(root, "friend-a2", "+15551234567", list)).resolves.toMatch(/^sam \(friend-a2\)/)
    // With no list given it reads the bundle's own friends folder, empty here.
    await expect(setAnsweringHandle(root, "Ari", "+15551234567")).rejects.toEqual(expect.objectContaining({ code: "no-person" }))
  })
})
