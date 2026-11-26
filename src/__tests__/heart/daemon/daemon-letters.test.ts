import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
// The agent's BlueBubbles server is the test's: one whose address can't be trusted, so it is never asked.
vi.mock("../../../senses/bluebubbles/agent-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../senses/bluebubbles/agent-client")>()),
  letterAnswerSource: () => async () => ({ trust: "untrusted", hostTrust: "shared-apple-id", getServerMessage: async () => null }),
}))

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function daemonOptions(bundlesRoot: string) {
  return {
    socketPath: path.join(bundlesRoot, "daemon.sock"),
    bundlesRoot,
    processManager: { listAgentSnapshots: vi.fn(() => []), startAutoStartAgents: vi.fn(async () => undefined), stopAll: vi.fn(async () => undefined), startAgent: vi.fn(async () => undefined), sendToAgent: vi.fn() },
    scheduler: { listJobs: vi.fn(() => []), triggerJob: vi.fn(async () => ({ ok: true, message: "" })), reconcile: vi.fn(async () => undefined) },
    healthMonitor: { runChecks: vi.fn(async () => []) },
    router: { send: vi.fn(async () => ({ id: "m", queuedAt: "" })), pollInbox: vi.fn(() => []) },
    senseManager: { startAutoStartSenses: vi.fn(async () => undefined), stopAll: vi.fn(async () => undefined), listSenseRows: vi.fn(() => []) },
  }
}

describe("the daemon's letters.action command", () => {
  it("hands each mailbox call to one letters writer over the daemon's bundles, and answers its refusals with their code", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-letters-"))
    made.push(bundlesRoot)
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    await expect(daemon.handleCommand({ kind: "letters.action", agent: "slugger", action: "mailbox_list", input: {} }))
      .resolves.toEqual({ ok: true, data: { outcome: "done", count: 0, listing: "" } })
    await expect(daemon.handleCommand({ kind: "letters.action", agent: "nobody", action: "mailbox_list", input: {} }))
      .resolves.toEqual(expect.objectContaining({ ok: false, data: expect.objectContaining({ code: "no-agent" }) }))
  })
})

describe("the daemon's filing note", () => {
  it("tells the agent through its private runtime when a letter is filed through the daemon", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-filed-"))
    made.push(bundlesRoot)
    const friends = path.join(bundlesRoot, "slugger.ouro", "friends")
    fs.mkdirSync(friends, { recursive: true })
    const stamp = "2026-01-01T00:00:00.000Z"
    fs.writeFileSync(path.join(friends, "friend-ari.json"), JSON.stringify({
      id: "friend-ari", name: "Ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: os.userInfo().username, linkedAt: stamp }],
      tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: stamp, updatedAt: stamp, schemaVersion: 1,
    }))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    const wake = vi.spyOn(daemon as unknown as { handlePrivateRuntimeWake: (command: unknown) => Promise<unknown> }, "handlePrivateRuntimeWake").mockResolvedValue({ ok: true })
    await expect(daemon.handleCommand({ kind: "letters.action", agent: "slugger", action: "mailbox_send", input: { kind: "know", subject: "Built" } }))
      .resolves.toMatchObject({ ok: true, data: { outcome: "needs-human", code: "L1" } })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ triggerSource: "letter-filed" })))
  })
})

describe("the daemon's letters.answer command", () => {
  it("checks a message named by GUID with the same letters writer, through the agent's own server", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-answer-"))
    made.push(bundlesRoot)
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    await expect(daemon.handleCommand({ kind: "letters.answer", agent: "slugger", messageGuid: "m-1" }))
      .resolves.toEqual({ ok: true, data: { recorded: false, reason: "untrusted-server-url" } })
  })

  it("tells the agent through its private runtime once an answer is recorded", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-answered-"))
    made.push(bundlesRoot)
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    const wake = vi.spyOn(daemon as unknown as { handlePrivateRuntimeWake: (command: unknown) => Promise<unknown> }, "handlePrivateRuntimeWake").mockResolvedValue({ ok: true })
    const writer = await (daemon as unknown as { letters: () => Promise<{ deps: { onAnswered: (agent: string, letter: unknown, answer: unknown) => Promise<void> } }> }).letters()
    // A letter with no answering handle has no chat for a receipt, so only the agent is told.
    const letter = { v: 1, id: "ltr_A1", code: "L1", to: "friend-ari", from: { agent: "slugger" }, kind: "decide", subject: "Which name?", whyOnlyYou: "", body: "", options: [{ id: "1", label: "Ouro" }], links: [], urgency: "today", createdAt: "2026-11-26T00:00:00.000Z" }
    await writer.deps.onAnswered("slugger", letter, { option: "1", label: "Ouro", messageGuid: "m-1", at: "2026-11-26T01:00:00.000Z" })
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ triggerSource: "letter-answered" }))
  })
})
