import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { answerReceipt, letterAnsweredNote, letterAnsweredTeller, letterAnsweredWake } from "../../../heart/letters/answered-note"
import type { Letter } from "../../../heart/letters/letter"
import { getPrivateRuntimePendingDir } from "../../../mind/pending"
import { emitNervesEvent } from "../../../nerves/runtime"

const letter = {
  v: 1, id: "ltr_A1", code: "L7", to: "friend-ari", from: { agent: "slugger" }, kind: "decide", subject: "Which name?", answeringHandle: "+15551234567",
  whyOnlyYou: "w", body: "", options: [{ id: "1", label: "Orca" }, { id: "2", label: "Ouro" }], links: [], urgency: "today", createdAt: "2026-11-26T12:00:00.000Z",
} as unknown as Letter
const answer = { option: "2", label: "Ouro", note: "ship it", messageGuid: "m-1", at: "2026-11-26T12:05:00.000Z" }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.mocked(emitNervesEvent).mockClear() })
function bundles(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "letters-answered-"))
  roots.push(root)
  fs.mkdirSync(path.join(root, "slugger.ouro"))
  return root
}
const notes = (root: string) => {
  const dir = getPrivateRuntimePendingDir("slugger", path.join(root, "slugger.ouro"))
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : []
}
const events = (name: string) => vi.mocked(emitNervesEvent).mock.calls.filter(([event]) => event.event === name)

describe("what a recorded answer says", () => {
  it("shows the person the code, subject and option, and quotes other people's words to the agent", () => {
    expect(answerReceipt(letter, answer)).toBe("Recorded L7 · Slugger asks: Which name? → 2 Ouro")
    expect(letterAnsweredNote(letter, answer)).toBe("my person answered letter L7 (its sender's subject: \"Which name?\") with option 2, \"Ouro\", with the note \"ship it\". mailbox_read shows it.")
    expect(letterAnsweredNote(letter, { ...answer, note: undefined })).toBe("my person answered letter L7 (its sender's subject: \"Which name?\") with option 2, \"Ouro\". mailbox_read shows it.")
  })
})

describe("letterAnsweredTeller", () => {
  it("sends the receipt to the letter's handle, queues the note once and wakes the agent", async () => {
    const root = bundles()
    const sent: unknown[] = []
    const wakes: unknown[] = []
    const tell = letterAnsweredTeller(root, async (request) => { sent.push(request) }, async (wake) => { wakes.push(wake); return { ok: true, data: { decision: { executable: true } } } })
    await tell("slugger", letter, answer)
    await tell("slugger", letter, answer)
    expect(sent[0]).toEqual({ agent: "slugger", handle: "+15551234567", text: "Recorded L7 · Slugger asks: Which name? → 2 Ouro" })
    expect(notes(root).map((note) => note.packetId)).toEqual(["letter-answered:ltr_A1"])
    expect(wakes[0]).toEqual(letterAnsweredWake("slugger", letter))
    expect(events("letters.answered_told")).toHaveLength(2)
  })

  it("keeps the answer when the receipt fails or the wake is refused, denied or throws", async () => {
    const root = bundles()
    const tell = (wake: Parameters<typeof letterAnsweredTeller>[2], send?: Parameters<typeof letterAnsweredTeller>[1]) => letterAnsweredTeller(root, send, wake)("slugger", letter, answer)
    await tell(async () => ({ ok: false, error: "not managed" }), async () => { throw new Error("offline") })
    await tell(async () => ({ ok: false }))
    await tell(async () => ({ ok: true, message: "denied", data: { decision: { executable: false } } }))
    await tell(async () => ({ ok: true, data: { decision: { executable: false } } }))
    await tell(async () => { throw new Error("down") })
    expect(events("letters.receipt_failed")).toHaveLength(1)
    expect(events("letters.answered_wake_failed")).toHaveLength(5)
  })

  it("sends no receipt for a letter with no handle", async () => {
    const root = bundles()
    const send = vi.fn(async () => undefined)
    await letterAnsweredTeller(root, send, async () => ({ ok: true }))("slugger", { ...letter, answeringHandle: undefined } as Letter, answer)
    expect(send).not.toHaveBeenCalled()
  })
})
