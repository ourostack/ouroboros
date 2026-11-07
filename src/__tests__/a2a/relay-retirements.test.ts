import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { fileRelayRetirements } from "../../a2a/relay-retirements"

let tmp: TmpBundleHandle | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

const a = { relayUrl: "https://a.example", handle: "a-h", inboxAuth: "a-ia", sendCredential: "a-sc" }
const b = { relayUrl: "https://b.example", handle: "b-h", inboxAuth: "b-ia", sendCredential: "b-sc" }

describe("fileRelayRetirements", () => {
  it("remembers each registration's record across instances, 0600 and without credentials on disk", () => {
    tmp = createTmpBundle({ agentName: "retirements" })
    const first = fileRelayRetirements(tmp.agentRoot)
    expect(first.read(a)).toEqual({})
    first.write(a, { firstFailedAt: 1234 })
    first.write(a, { firstFailedAt: 1234, retired: true })
    const second = fileRelayRetirements(tmp.agentRoot)
    expect(second.read(a)).toEqual({ firstFailedAt: 1234, retired: true })
    expect(second.read(b)).toEqual({})
    const dir = path.join(tmp.agentRoot, "state", "a2a", "relay-retired")
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/)
    const body = fs.readFileSync(path.join(dir, files[0]), "utf8")
    expect(body).not.toContain(a.inboxAuth)
    expect(body).not.toContain(a.sendCredential)
    expect(fs.statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600)
    second.clear(a)
    second.clear(b)
    expect(second.read(a)).toEqual({})
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })

  it("logs each record it writes, with the relay but never its credentials", async () => {
    tmp = createTmpBundle({ agentName: "retirements" })
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    try {
      const store = fileRelayRetirements(tmp.agentRoot)
      store.write(a, { firstFailedAt: 1 })
      store.write(a, { firstFailedAt: 1, retired: true })
      const events = nerves.mock.calls.map(([e]) => e).filter((e) => e.event === "channel.a2a_relay_retirement_recorded")
      expect(events.map((e) => e.meta)).toEqual([{ relayUrl: a.relayUrl, retired: false }, { relayUrl: a.relayUrl, retired: true }])
      expect(JSON.stringify(events)).not.toContain(a.inboxAuth)
      expect(JSON.stringify(events)).not.toContain(a.sendCredential)
    } finally {
      nerves.mockRestore()
    }
  })

  it("reads a damaged record as empty and ignores fields it does not know", () => {
    tmp = createTmpBundle({ agentName: "retirements" })
    const store = fileRelayRetirements(tmp.agentRoot)
    store.write(a, {})
    const dir = path.join(tmp.agentRoot, "state", "a2a", "relay-retired")
    const [name] = fs.readdirSync(dir)
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ firstFailedAt: "yesterday", retired: "yes", extra: 1 }))
    expect(fileRelayRetirements(tmp.agentRoot).read(a)).toEqual({})
    fs.writeFileSync(path.join(dir, name), "{not json")
    expect(fileRelayRetirements(tmp.agentRoot).read(a)).toEqual({})
  })

  it("keeps a record in memory when the disk write fails", () => {
    tmp = createTmpBundle({ agentName: "retirements" })
    const dir = path.join(tmp.agentRoot, "state", "a2a")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "relay-retired"), "a file where the folder should be")
    const store = fileRelayRetirements(tmp.agentRoot)
    expect(() => store.write(a, { firstFailedAt: 5 })).toThrow()
    expect(store.read(a)).toEqual({ firstFailedAt: 5 })
  })
})
