import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
import { letterFiledNote, letterFiledTeller, letterFiledWake, tellAgentLetterFiled } from "../../../heart/letters/filed-note"
import type { Letter } from "../../../heart/letters/letter"

const letter = {
  v: 1, id: "ltr_A1", code: "L7", to: "friend-ari", from: { agent: "slugger", lane: "desk/task" }, kind: "decide", subject: "Which name?",
  whyOnlyYou: "It is your product.", body: "", options: [], links: [], urgency: "today", createdAt: "2026-11-26T12:00:00.000Z",
} as unknown as Letter

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function bundles(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filed-note-"))
  roots.push(root)
  fs.mkdirSync(path.join(root, "slugger.ouro"))
  return root
}
function queued(root: string): Array<Record<string, unknown>> {
  const dir = path.join(root, "slugger.ouro", "state", "pending", "self", "inner", "dialog")
  const found: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : found.push(path.join(d, e.name)) }
  walk(fs.existsSync(dir) ? dir : path.join(root, "slugger.ouro", "state"))
  return found.filter((f) => f.endsWith(".json") && f.includes("pending")).map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
}

describe("letterFiledNote", () => {
  it("names the code, lane, subject, kind and urgency, and how the letter can reach the person", () => {
    expect(letterFiledNote(letter)).toBe("letter L7 from the lane \"desk/task\" was filed (decide, today); its sender gave it the subject \"Which name?\". it waits for my person's answer. i decide whether and when they see it: it can't go to their chat, since they had no answering handle when it was filed; mailbox_read shows it.")
    expect(letterFiledNote({ ...letter, from: { agent: "slugger" }, answeringHandle: "+15551234567", holdUntil: "interactive" } as Letter))
      .toBe("letter L7 was filed (decide, today, held until interactive); its sender gave it the subject \"Which name?\". it waits for my person's answer. i decide whether and when they see it: mailbox_deliver sends it to their chat; mailbox_read shows it.")
  })
})

describe("tellAgentLetterFiled", () => {
  it("queues the note once in the agent's private runtime and wakes it", async () => {
    const root = bundles()
    const wakes: unknown[] = []
    const tell = letterFiledTeller(root, async (command) => { wakes.push(command); return { ok: true } })
    await tell("slugger", letter)
    await tell("slugger", letter)
    const notes = queued(root)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ from: "slugger", friendId: "self", channel: "inner", key: "dialog", packetId: "letter-filed:ltr_A1", content: letterFiledNote(letter) })
    expect(wakes).toEqual([letterFiledWake("slugger", letter), letterFiledWake("slugger", letter)])
    expect(letterFiledWake("slugger", letter)).toEqual({
      kind: "private.wake", agent: "slugger", reason: "letter L7 filed", triggerSource: "letter-filed", budgetClass: "interactive",
      idempotencyKey: "letter-filed:slugger:ltr_A1", originRefs: [{ kind: "letter", id: "ltr_A1" }, { kind: "daemon-command", id: "letters.file" }],
    })
  })

  it("leaves the note queued when the wake is refused or throws", async () => {
    const root = bundles()
    const agentRoot = path.join(root, "slugger.ouro")
    await tellAgentLetterFiled("slugger", agentRoot, letter, async () => ({ ok: false, error: "not managed" }))
    await tellAgentLetterFiled("slugger", agentRoot, { ...letter, id: "ltr_A2" } as Letter, async () => ({ ok: false }))
    await tellAgentLetterFiled("slugger", agentRoot, { ...letter, id: "ltr_A3" } as Letter, async () => { throw new Error("down") })
    // A wake policy denies still answers ok, with a decision that can't run.
    await tellAgentLetterFiled("slugger", agentRoot, { ...letter, id: "ltr_A4" } as Letter, async () => ({ ok: true, message: "denied", data: { decision: { executable: false } } }))
    await tellAgentLetterFiled("slugger", agentRoot, { ...letter, id: "ltr_A5" } as Letter, async () => ({ ok: true, data: { decision: { executable: false } } }))
    expect(queued(root)).toHaveLength(5)
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    expect(vi.mocked(emitNervesEvent).mock.calls.filter(([event]) => event.event === "letters.filed_wake_failed")).toHaveLength(5)
  })
})
