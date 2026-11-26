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

describe("the daemon's letter expiry pass", () => {
  it("loads no letters code until a bundle has letters, then closes the letters past their expiry", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-expiry-"))
    made.push(bundlesRoot)
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"))
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(daemonOptions(bundlesRoot) as ConstructorParameters<typeof OuroDaemon>[0])
    expect(await daemon.expireLetters()).toBe(0)
    expect((daemon as unknown as { lettersWriter: unknown }).lettersWriter).toBeNull()
    const lettersDir = path.join(bundlesRoot, "slugger.ouro", "state", "letters")
    fs.mkdirSync(lettersDir, { recursive: true })
    fs.writeFileSync(path.join(lettersDir, "ltr_A1.jsonl"), `${JSON.stringify({ v: 1, id: "ltr_A1", code: "L1", to: "friend-ari", from: { agent: "slugger" }, kind: "know", subject: "Gone", whyOnlyYou: "", body: "", options: [], links: [], urgency: "now", expiresAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-12-31T00:00:00.000Z" })}\n`)
    const wake = vi.spyOn(daemon as unknown as { handlePrivateRuntimeWake: (command: unknown) => Promise<unknown> }, "handlePrivateRuntimeWake").mockResolvedValue({ ok: true })
    expect(await daemon.expireLetters()).toBe(1)
    expect(await daemon.expireLetters()).toBe(0)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ triggerSource: "letter-expired" })))
  })

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

  it("passes quietly over a bundles folder that doesn't exist yet, and logs a pass that fails", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const failures = () => vi.mocked(emitNervesEvent).mock.calls.filter(([event]) => event.event === "daemon.letter_expiry_error")
    vi.mocked(emitNervesEvent).mockClear()
    const gone = new OuroDaemon(daemonOptions(path.join(os.tmpdir(), "c21-daemon-expiry-gone-does-not-exist")) as ConstructorParameters<typeof OuroDaemon>[0])
    expect(await gone.expireLetters()).toBe(0)
    expect(failures()).toEqual([])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c21-daemon-expiry-file-"))
    made.push(root)
    fs.writeFileSync(path.join(root, "bundles"), "")
    const file = new OuroDaemon(daemonOptions(path.join(root, "bundles")) as ConstructorParameters<typeof OuroDaemon>[0])
    expect(await file.expireLetters()).toBe(0)
    expect(failures()).toHaveLength(1)
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
