import { describe, expect, it, vi } from "vitest"

import { approvalRelayToken } from "../../a2a/approval-relay"
import {
  classifyTelegramPersistedApprovalState,
  createTelegramApprovalTransport,
  TELEGRAM_APPROVAL_RELAYED_NOTE,
  type TelegramPendingApprovalStore,
} from "../../senses/telegram-client"

// Ari says no through Slugger instead of tapping: the Telegram process decides it beside the tap path.
const ROUTE = "did:key:z6MkSyntheticSluggerRoute"
const TOKEN = "restored-secret-token-of-43-characters-long!"
type Records = ReturnType<TelegramPendingApprovalStore["load"]>

function fixture(input: {
  now?: () => number
  records?: Records
  edit?: (text: string) => Promise<void>
  onDecision?: ReturnType<typeof vi.fn>
  resolveDecisionToken?: () => Promise<string>
} = {}) {
  let records = structuredClone(input.records ?? [])
  const store: TelegramPendingApprovalStore = { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } }
  const order: string[] = []
  const edits: string[] = []
  const acknowledgements: Array<{ callbackQueryId: string; text?: string }> = []
  const onDecision = input.onDecision ?? vi.fn(async () => { order.push("decide"); return { accepted: false, terminalText: "❌ Denied — no action taken" } })
  const transport = createTelegramApprovalTransport({
    api: { request: vi.fn(), stop: vi.fn() },
    expectedUserId: "10",
    expectedChatId: "10",
    pendingStore: store,
    createOpaqueHandle: (() => { const values = ["approve", "deny"]; return () => values.shift() ?? "extra" })(),
    onDecision,
    resolveDecisionToken: input.resolveDecisionToken ?? (async () => TOKEN),
    now: input.now ?? (() => 1_000_000),
    effects: {
      sendText: vi.fn(async () => []),
      sendCard: vi.fn(async () => 99),
      edit: vi.fn(async ({ text }) => { order.push(`edit:${text}`); edits.push(text); await input.edit?.(text) }),
      acknowledge: vi.fn(async (ack) => { acknowledgements.push(ack) }),
    },
  })
  return { transport, onDecision, order, edits, acknowledgements, records: () => records }
}

const relayed = (overrides: Record<string, unknown> = {}) => ({
  relayToken: approvalRelayToken({ decisionToken: TOKEN, approvalId: "approval-1", routeDid: ROUTE }),
  routeDid: ROUTE, senderDid: ROUTE, envelopeBindingId: "bind-1", ...overrides,
})
const tap = (data: string, id = "query-1") => ({ update_id: 1, callback_query: { id, from: { id: 10 }, data, message: { message_id: 99, chat: { id: 10 } } } })

async function sent(f: ReturnType<typeof fixture>) {
  await f.transport.sendApproval({ approvalId: "approval-1", decisionToken: TOKEN, prompt: "Restart plex?" })
}

describe("relayDeny", () => {
  it("edits the card first, then decides deny with the relay's provenance, then edits it to its final state", async () => {
    const f = fixture()
    await sent(f)
    expect(await f.transport.relayDeny(relayed())).toEqual({ status: "settled", approvalId: "approval-1" })
    expect(f.order).toEqual([
      `edit:Restart plex?\n\n${TELEGRAM_APPROVAL_RELAYED_NOTE}`,
      "decide",
      `edit:❌ Denied — no action taken\n\n${TELEGRAM_APPROVAL_RELAYED_NOTE}`,
    ])
    expect(f.onDecision).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1", decisionToken: TOKEN, decision: "deny", decisionAt: 1_000_000,
      relay: { senderDid: ROUTE, envelopeBindingId: "bind-1" },
    }))
    expect(f.acknowledgements).toEqual([])
    expect(f.records()).toEqual([])
  })

  it.each([
    ["a wrong token", { relayToken: "x".repeat(43) }],
    ["a token for another route", { relayToken: approvalRelayToken({ decisionToken: TOKEN, approvalId: "approval-1", routeDid: `${ROUTE}2` }) }],
    ["a token for another approval", { relayToken: approvalRelayToken({ decisionToken: TOKEN, approvalId: "approval-2", routeDid: ROUTE }) }],
    ["an empty token", { relayToken: "" }],
  ])("finds nothing for %s and touches nothing", async (_name, overrides) => {
    const f = fixture()
    await sent(f)
    expect(await f.transport.relayDeny(relayed(overrides))).toEqual({ status: "not_pending" })
    expect(f.edits).toEqual([])
    expect(f.onDecision).not.toHaveBeenCalled()
    expect(f.records()).toHaveLength(1)
  })

  it("never matches an approval whose decision token is gone", async () => {
    const f = fixture({ resolveDecisionToken: async () => "" })
    const restored = fixture()
    await sent(restored)
    const g = fixture({ records: restored.records(), resolveDecisionToken: async () => "" })
    expect(await g.transport.relayDeny(relayed())).toEqual({ status: "not_pending" })
    expect(g.edits).toEqual([])
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("says expired once the approval's own five minutes are up, and decides nothing", async () => {
    let clock = 1_000_000
    const f = fixture({ now: () => clock })
    await sent(f)
    clock = 1_300_000
    expect(await f.transport.relayDeny(relayed())).toEqual({ status: "expired" })
    expect(f.edits).toEqual([])
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("refuses and decides nothing when the card edit fails, leaving the tap path working", async () => {
    let failEdits = true
    const f = fixture({ edit: async () => { if (failEdits) throw new Error("telegram down") } })
    await sent(f)
    expect(await f.transport.relayDeny(relayed())).toEqual({ status: "refused", reason: "card_edit_failed" })
    expect(f.onDecision).not.toHaveBeenCalled()
    expect(f.records()[0]?.decisionAttempt).toBeUndefined()
    failEdits = false
    expect(await f.transport.handleUpdate(tap("d:deny"))).toEqual({ handled: true, accepted: false, reason: "decision_refused" })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
    expect(f.onDecision.mock.calls[0]![0]).not.toHaveProperty("relay")
  })

  it("makes a tap during a relayed deny wait, then find the card already settled", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = fixture({ onDecision: vi.fn(async () => { await gate; return { accepted: false, terminalText: "❌ Denied — no action taken" } }) })
    await sent(f)
    const relay = f.transport.relayDeny(relayed())
    await vi.waitFor(() => expect(f.onDecision).toHaveBeenCalledTimes(1))
    const tapped = f.transport.handleUpdate(tap("a:approve"))
    release()
    expect(await relay).toEqual({ status: "settled", approvalId: "approval-1" })
    expect(await tapped).toEqual({ handled: true, accepted: false, reason: "stale_callback" })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
  })

  it("marks a card saved without its prompt text by a generic line", async () => {
    const f = fixture()
    await sent(f)
    const g = fixture({ records: f.records().map(({ prompt: _prompt, ...record }) => record) })
    expect(await g.transport.relayDeny(relayed())).toEqual({ status: "settled", approvalId: "approval-1" })
    expect(g.edits[0]).toBe(`Approval request\n\n${TELEGRAM_APPROVAL_RELAYED_NOTE}`)
  })

  it("finds nothing for a prompt that was never delivered", async () => {
    const f = fixture()
    await f.transport.sendApproval({ approvalId: "approval-1", decisionToken: TOKEN, prompt: "Restart plex?" })
    const undelivered = f.records().map((record) => ({ ...record, deliveryState: "send_attempting" as const, messageId: null }))
    const g = fixture({ records: undelivered })
    expect(await g.transport.relayDeny(relayed())).toEqual({ status: "not_pending" })
  })
})

describe("a relayed deny across a restart", () => {
  async function crashed() {
    const f = fixture({ onDecision: vi.fn(async () => { throw new Error("process died") }) })
    await sent(f)
    await expect(f.transport.relayDeny(relayed())).rejects.toThrow("process died")
    return f.records()
  }

  it("persists a signed deny attempt that names the relay", async () => {
    const records = await crashed()
    expect(records[0]?.decisionAttempt).toMatchObject({ decision: "deny", attemptedAt: 1_000_000, relay: { senderDid: ROUTE, envelopeBindingId: "bind-1" } })
    expect(classifyTelegramPersistedApprovalState(records[0]!)).toBe("decision_attempt")
  })

  it("refuses a tap on a card a relay already answered", async () => {
    const g = fixture({ records: await crashed() })
    expect(await g.transport.handleUpdate(tap("a:approve"))).toEqual({ handled: true, accepted: false, reason: "already_relayed" })
    expect(g.acknowledgements).toEqual([expect.objectContaining({ callbackQueryId: "query-1", text: "This approval is no longer valid." })])
    expect(g.onDecision).not.toHaveBeenCalled()
  })

  it("finishes the relayed deny on recovery, with the relay's provenance", async () => {
    const g = fixture({ records: await crashed() })
    expect(await g.transport.recoverDecisionAttempt("approval-1")).toBe(true)
    expect(g.onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny", relay: { senderDid: ROUTE, envelopeBindingId: "bind-1" } }))
    expect(g.edits).toEqual([`❌ Denied — no action taken\n\n${TELEGRAM_APPROVAL_RELAYED_NOTE}`])
    expect(g.records()).toEqual([])
  })

  it("answers a second relay of the same answer with nothing to do", async () => {
    const g = fixture({ records: await crashed() })
    expect(await g.transport.relayDeny(relayed())).toEqual({ status: "not_pending" })
    expect(g.onDecision).not.toHaveBeenCalled()
  })

  it.each([
    ["a changed sender", (r: Records[number]) => ({ ...r, decisionAttempt: { ...r.decisionAttempt!, relay: { ...r.decisionAttempt!.relay!, senderDid: "did:key:z6MkOther" } } })],
    ["a flip to approve", (r: Records[number]) => ({ ...r, decisionAttempt: { ...r.decisionAttempt!, decision: "approve" as const } })],
    ["an extra relay key", (r: Records[number]) => ({ ...r, decisionAttempt: { ...r.decisionAttempt!, relay: { ...r.decisionAttempt!.relay!, actor: "owner" } as never } })],
    ["a stripped relay", (r: Records[number]) => ({ ...r, decisionAttempt: { ...r.decisionAttempt!, relay: undefined } })],
    ["a relay that isn't an object", (r: Records[number]) => ({ ...r, decisionAttempt: { ...r.decisionAttempt!, relay: ["did", "bind"] as never } })],
  ])("refuses to recover a relayed attempt with %s", async (_name, tamper) => {
    const g = fixture({ records: (await crashed()).map(tamper) })
    await expect(g.transport.recoverDecisionAttempt("approval-1")).rejects.toThrow("decision attempt is invalid")
    expect(g.onDecision).not.toHaveBeenCalled()
  })
})
