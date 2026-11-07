import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
  it("remembers a pending retirement across instances, per registration, without credentials on disk", () => {
    tmp = createTmpBundle({ agentName: "retirements" })
    const first = fileRelayRetirements(tmp.agentRoot)
    expect(first.isPending(a)).toBe(false)
    first.markPending(a)
    const second = fileRelayRetirements(tmp.agentRoot)
    expect(second.isPending(a)).toBe(true)
    expect(second.isPending(b)).toBe(false)
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
    expect(first.isPending(a)).toBe(false)
  })
})
