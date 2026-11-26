import { describe, expect, it, vi } from "vitest"
import { DEFAULT_DAEMON_SOCKET_PATH } from "../../../heart/daemon/socket-client"
import { askDaemonToAnswerLetter } from "../../../senses/bluebubbles/letter-answer-ingress"

describe("askDaemonToAnswerLetter", () => {
  it("sends the daemon the message's GUID and reads whether it recorded an answer", async () => {
    const send = vi.fn(async () => ({ ok: true, data: { recorded: true } }))
    expect(await askDaemonToAnswerLetter("slugger", "m-1", send as never, () => 1_000)).toBe(true)
    // The daemon stops 3 s before the sense does, so it never records an answer the sense has given up on.
    expect(send).toHaveBeenCalledWith(DEFAULT_DAEMON_SOCKET_PATH, { kind: "letters.answer", agent: "slugger", messageGuid: "m-1", deadlineAt: 28_000 }, { timeoutMs: 30_000 })
    expect(await askDaemonToAnswerLetter("slugger", "m-1", (async () => ({ ok: true, data: { recorded: false, reason: "not-waiting" } })) as never)).toBe(false)
    expect(await askDaemonToAnswerLetter("slugger", "m-1", (async () => ({ ok: true })) as never)).toBe(false)
  })

  it("throws when the daemon refuses, so the message stays a chat turn", async () => {
    await expect(askDaemonToAnswerLetter("slugger", "m-1", (async () => ({ ok: false, error: "no agent" })) as never)).rejects.toThrow("no agent")
    await expect(askDaemonToAnswerLetter("slugger", "m-1", (async () => ({ ok: false })) as never)).rejects.toThrow("the daemon refused")
  })

  it("asks the real daemon socket by default, which tests never reach", async () => {
    expect(await askDaemonToAnswerLetter("slugger", "m-1")).toBe(false)
  })
})
