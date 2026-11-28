import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { delegationOptionsFor, escalationOptionsFor, RUNNING_HARNESS_VERSION, sendOwnerNoticeViaTelegram } from "../../a2a/escalation-wiring"
import { A2A_PRINCIPAL_PROFILE_ID } from "../../a2a/delegated-command"
import { getAgentRoot } from "../../heart/identity"
import { loadProduct } from "../../heart/product/active"
import { product as butlerProduct } from "../../products/butler"
import { BUTLER_PRODUCT_PATH } from "../test-helpers/butler-product"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"

const PATH = "/opt/example/dist/product.js"
const fixture = { seamVersion: 1 as const, id: "example", agents: ["helper"] as [string] }

const repoRoot = path.resolve(__dirname, "../../..")

describe("escalation wiring", () => {
  it("reports the harness's own package version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }
    expect(RUNNING_HARNESS_VERSION).toBe(pkg.version)
  })

  afterEach(() => { loadProduct(undefined) })

  it("passes escalation only for an agent whose product files and confirms failure reports", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    expect(escalationOptionsFor("helper", send)).toEqual({})
    loadProduct(PATH, () => ({ product: fixture }))
    expect(escalationOptionsFor("helper", send)).toEqual({})
    loadProduct(PATH, () => ({ product: { ...fixture, a2a: { escalation: true } } }))
    const options = escalationOptionsFor("helper", send)
    expect(options.escalation?.runningVersion).toBe(RUNNING_HARNESS_VERSION)
    await options.escalation!.notifyOwner({ noticeId: "n", text: "t" })
    expect(send).toHaveBeenCalledWith({ noticeId: "n", text: "t" })
    expect(escalationOptionsFor("slugger", send)).toEqual({})
  })

  it("passes delegation only for an agent whose product accepts delegated commands, announcing each through the product", async () => {
    expect(delegationOptionsFor("helper")).toEqual({})
    loadProduct(PATH, () => ({ product: { ...fixture, a2a: { escalation: true } } }))
    expect(delegationOptionsFor("helper")).toEqual({})
    const notifyPrincipal = vi.fn().mockResolvedValue(undefined)
    loadProduct(PATH, () => ({ product: { ...fixture, a2a: { delegation: { notifyPrincipal } } } }))
    const { delegation } = delegationOptionsFor("helper")
    expect(delegation).toMatchObject({ principalProfileId: A2A_PRINCIPAL_PROFILE_ID, agentRoot: getAgentRoot("helper") })
    await delegation!.notifyPrincipal({ noticeId: "n", text: "t" })
    expect(notifyPrincipal).toHaveBeenCalledWith("helper", { noticeId: "n", text: "t" })
    expect(delegationOptionsFor("slugger")).toEqual({})
    notifyPrincipal.mockRejectedValueOnce(new Error("telegram down"))
    const events: LogEvent[] = []
    onTestFinished(registerGlobalLogSink((entry) => { events.push(entry) }))
    await expect(delegation!.notifyPrincipal({ noticeId: "n", text: "t" })).rejects.toThrow("telegram down")
    expect(events).toContainEqual(expect.objectContaining({ event: "daemon.product_hook_error", meta: expect.objectContaining({ productId: "example", hook: "a2a.delegation.notifyPrincipal", agent: "helper", reason: "telegram down" }) }))
  })

  it("gives the Butler delegation, announced in the owner's own Telegram chat with a timeout, and escalation, under both its names", async () => {
    const sendTelegramDelegatedAuditNotice = vi.fn().mockResolvedValue(undefined)
    vi.doMock("../../senses/telegram", () => ({ sendTelegramDelegatedAuditNotice }))
    onTestFinished(() => { vi.doUnmock("../../senses/telegram") })
    const timeout = vi.spyOn(AbortSignal, "timeout")
    loadProduct(BUTLER_PRODUCT_PATH, () => ({ product: butlerProduct }))
    for (const name of ["butler", "sanctuary"]) {
      expect(escalationOptionsFor(name, vi.fn()).escalation?.runningVersion).toBe(RUNNING_HARNESS_VERSION)
      await delegationOptionsFor(name).delegation!.notifyPrincipal({ noticeId: "n", text: "t" })
      expect(sendTelegramDelegatedAuditNotice).toHaveBeenLastCalledWith(name, expect.objectContaining({ noticeId: "n", text: "t", signal: expect.any(AbortSignal) }))
      // Thirty seconds to reach the owner's chat: a shorter bound refuses every delegated command as notice_failed.
      expect(timeout).toHaveBeenLastCalledWith(30_000)
    }
    timeout.mockRestore()
  })

  it("confirms the Butler's failure reports through the owner-notice sender it is given, and no other agent's", async () => {
    loadProduct(BUTLER_PRODUCT_PATH, () => ({ product: butlerProduct }))
    const send = vi.fn().mockResolvedValue(undefined)
    const options = escalationOptionsFor("sanctuary", send)
    expect(options.escalation?.runningVersion).toBe(RUNNING_HARNESS_VERSION)
    await options.escalation!.notifyOwner({ noticeId: "n", text: "t" })
    expect(send).toHaveBeenCalledWith({ noticeId: "n", text: "t" })
    expect(escalationOptionsFor("slugger", send)).toEqual({})
    // The Butler's name after the rename (M2) wires the same way.
    expect(escalationOptionsFor("butler", send).escalation?.runningVersion).toBe(RUNNING_HARNESS_VERSION)
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

  it("the A2A sense passes the product's delegation to the server", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/senses/a2a-entry.ts"), "utf8")
    const call = source.slice(source.indexOf("await startA2AServer({"))
    expect(call.slice(0, 1200)).toContain("...delegationOptionsFor(agentName)")
  })

  it.each(["src/senses/a2a-entry.ts", "src/heart/daemon/cli-exec.ts"])("%s passes escalation to the server", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8")
    const call = source.slice(source.indexOf("await startA2AServer({"))
    expect(call.slice(0, 1200)).toContain("...escalationOptionsFor(")
  })
})
