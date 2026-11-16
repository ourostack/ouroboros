import { describe, expect, it } from "vitest"
import { guardInvocation } from "../../repertoire/guardrails"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mailToolDefinitions, mailToolsEnabled } from "../../repertoire/tools-mail"
import { getToolsForChannel } from "../../repertoire/tools"
import { getChannelCapabilities } from "@ouro.bot/friends"

describe("mail tool registration and trust boundaries", () => {
  it("offers the mail tools only to an agent that turned the mail sense on", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-gate-"))
    const advertised = () => getToolsForChannel(getChannelCapabilities("cli"), undefined, undefined, undefined, undefined, undefined, { agentRoot: root } as any)
      .some((tool) => tool.function.name === "mail_recent")
    expect(mailToolsEnabled(undefined)).toBe(false)
    expect(mailToolsEnabled(root)).toBe(false)
    expect(advertised()).toBe(false)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { mail: { enabled: true } } }))
    expect(mailToolsEnabled(root)).toBe(true)
    expect(advertised()).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("registers Mailroom tools in the mail tool set", () => {
    const toolNames = mailToolDefinitions.map((definition) => definition.tool.function.name)
    expect(toolNames).toEqual(expect.arrayContaining([
      "mail_status",
      "mail_recent",
      "mail_search",
      "mail_index_refresh",
      "mail_body",
      "mail_access_log",
      "mail_screener",
      "mail_decide",
      "mail_compose",
      "mail_send",
    ]))
  })

  it("keeps delegated human mail and Screener decisions at family trust", () => {
    expect(guardInvocation("mail_recent", { scope: "native" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    }).allowed).toBe(true)
    expect(guardInvocation("mail_search", {}, {
      readPaths: new Set(),
      trustLevel: "friend",
    }).allowed).toBe(true)

    const delegated = guardInvocation("mail_recent", { scope: "delegated" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(delegated.allowed).toBe(false)
    expect(delegated.reason).toContain("family")

    const screener = guardInvocation("mail_screener", {}, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(screener.allowed).toBe(false)
    expect(screener.reason).toContain("family")

    const indexRefresh = guardInvocation("mail_index_refresh", { scope: "delegated" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(indexRefresh.allowed).toBe(false)
    expect(indexRefresh.reason).toContain("family")

    const decision = guardInvocation("mail_decide", {
      candidate_id: "candidate_mail_1",
      action: "discard",
      reason: "unknown sender",
    }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain("family")

    expect(guardInvocation("mail_decide", {
      candidate_id: "candidate_mail_1",
      action: "discard",
      reason: "unknown sender",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
    }).allowed).toBe(true)
    expect(guardInvocation("mail_access_log", {}, {
      readPaths: new Set(),
    }).allowed).toBe(true)
    expect(guardInvocation("mail_search", { scope: "all" }, {
      readPaths: new Set(),
      trustLevel: "family",
    }).allowed).toBe(true)

    const send = guardInvocation("mail_send", {
      draft_id: "draft_1",
      confirmation: "CONFIRM_SEND",
      reason: "friend send attempt",
    }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(send.allowed).toBe(false)
    expect(send.reason).toContain("family")

    expect(guardInvocation("mail_send", {
      draft_id: "draft_1",
      confirmation: "CONFIRM_SEND",
      reason: "family confirmed",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
    }).allowed).toBe(true)
  })
})
