import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { escalationOptionsFor, RUNNING_HARNESS_VERSION, sendOwnerNoticeViaTelegram } from "../../a2a/escalation-wiring"

const repoRoot = path.resolve(__dirname, "../../..")

describe("escalation wiring", () => {
  it("reports the harness's own package version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }
    expect(RUNNING_HARNESS_VERSION).toBe(pkg.version)
  })

  it("passes escalation with an owner-notice sender for the Butler only", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const options = escalationOptionsFor("sanctuary", send)
    expect(options.escalation?.runningVersion).toBe(RUNNING_HARNESS_VERSION)
    await options.escalation!.notifyOwner({ noticeId: "n", text: "t" })
    expect(send).toHaveBeenCalledWith({ noticeId: "n", text: "t" })
    expect(escalationOptionsFor("slugger", send)).toEqual({})
  })

  it("sends the notice through the Telegram owner path with a timeout", async () => {
    const sendTelegramOwnerNotice = vi.fn().mockResolvedValue(undefined)
    vi.resetModules()
    vi.doMock("../../senses/telegram", () => ({ sendTelegramOwnerNotice }))
    const { sendOwnerNoticeViaTelegram: send } = await import("../../a2a/escalation-wiring")
    await send("sanctuary", { noticeId: "n", text: "t" })
    expect(sendTelegramOwnerNotice).toHaveBeenCalledWith("sanctuary", expect.objectContaining({ noticeId: "n", text: "t", signal: expect.any(AbortSignal) }))
    vi.doUnmock("../../senses/telegram")
    expect(typeof sendOwnerNoticeViaTelegram).toBe("function")
  })

  it.each(["src/senses/a2a-entry.ts", "src/heart/daemon/cli-exec.ts"])("%s passes escalation to the server", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8")
    const call = source.slice(source.indexOf("await startA2AServer({"))
    expect(call.slice(0, 1200)).toContain("...escalationOptionsFor(")
  })
})
