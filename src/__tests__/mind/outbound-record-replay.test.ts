import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { recordOutboundInSession } from "../../mind/outbound-record"
import { resolveSessionPath } from "../../heart/config"

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-replay-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const record = (deliveryId: string) => recordOutboundInSession({
  agentRoot: root, friendId: "ari", channel: "teams", key: "chat-1", content: "build is out", origin: "proactive", deliveryId, originLabel: "a proactive message",
})
const copies = () => (fs.readFileSync(resolveSessionPath("ari", "teams", "chat-1", { agentRoot: root, confined: true }), "utf-8").match(/\[you sent this via a proactive message\] build is out/g) ?? []).length

describe("a replayed proactive send in the Teams session history", () => {
  it("is recorded once per delivery id over two replays, and once per send when ids are random", () => {
    expect(record("pending:abc")).toBe("recorded")
    expect(record("pending:abc")).toBe("recorded")
    expect(record("pending:abc")).toBe("recorded")
    expect(copies()).toBe(1)
    // The old random ids: each replay becomes one more copy the model reads every turn.
    record("proactive:one")
    record("proactive:two")
    expect(copies()).toBe(3)
  })
})

describe("old persisted proactive notices in the model's context", () => {
  it("are not replayed on later turns over two loads, while the durable history and user turns stay", async () => {
    const { loadSession, saveSession } = await import("../../mind/context")
    const file = resolveSessionPath("ari", "teams", "chat-1", { agentRoot: root, confined: true })
    expect(record("pending:old")).toBe("recorded")
    const envelope = JSON.parse(fs.readFileSync(file, "utf-8"))
    const old = new Date(Date.now() - 48 * 60 * 60_000).toISOString()
    for (const event of envelope.events) event.time = { ...event.time, recordedAt: old, authoredAt: old, observedAt: old }
    fs.writeFileSync(file, JSON.stringify(envelope))
    const text = (): string => JSON.stringify(loadSession(file)!.messages)
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(text()).not.toContain("build is out")
      saveSession(file, [...loadSession(file)!.messages, { role: "user", content: "thanks" }])
    }
    expect(text()).toContain("thanks")
    expect(copies()).toBe(1)
  })
})
