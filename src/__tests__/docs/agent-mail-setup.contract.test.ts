import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

function readGuide(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "docs", "agent-mail-setup.md"), "utf-8")
}

describe("agent mail setup documentation contract", () => {
  it("documents the all-agent signup path and storage boundaries", () => {
    const guide = readGuide()

    expect(guide).toContain("ouro account ensure --agent <agent>")
    expect(guide).toContain("ouro connect mail --agent <agent>")
    expect(guide).toContain("ouro status")
    expect(guide).toContain("ouro doctor")
    expect(guide).not.toContain("ouro doctor --agent")
    expect(guide).toContain("Mail row is ready/running")
    expect(guide).toContain("<agent>@ouro.bot")
    expect(guide).toContain("runtime/config")
    expect(guide).toContain("~/AgentBundles/<agent>.ouro/state/mailroom/")
    expect(guide).toContain("Vault coupling")
    expect(guide).toContain("Bundle state")
  })

  it("keeps native agent mail, delegated human mail, and trust provenance distinct", () => {
    const guide = readGuide()

    expect(guide).toContain("Agent native mailbox")
    expect(guide).toContain("Delegated human-mail alias")
    expect(guide).toContain("family/friend/stranger remains the trust model")
    expect(guide).toContain("A friend may send email to the agent")
    expect(guide).toContain("a friend cannot create their own human-mail source")
    expect(guide).toContain("Delegated human mail requires family trust")
  })

  it("documents Screener recovery, human-only external actions, and Outlook audit expectations", () => {
    const guide = readGuide()

    expect(guide).toContain("discard")
    expect(guide).toContain("persist a discard policy for that sender")
    expect(guide).toContain("Discard does not reject, bounce, or return mail to sender")
    expect(guide).toContain("retained recovery drawer")
    expect(guide).toContain("Do not publish production MX records")
    expect(guide).toContain("HEY browser export")
    expect(guide).toContain("confirmation=CONFIRM_SEND")
    expect(guide).toContain("Ouro Outlook should feel like logging into the agent's mailbox")
    expect(guide).toContain("mail_access_log")
  })
})
