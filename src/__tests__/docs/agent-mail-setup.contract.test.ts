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
    expect(guide).toContain("ouro account ensure --agent <agent> --owner-email <email> --source hey")
    expect(guide).toContain("ouro account ensure --agent <agent> --no-delegated-source")
    expect(guide).toContain("ouro connect mail --agent <agent>")
    expect(guide).toContain("ouro connect mail --agent <agent> --owner-email <email> --source hey")
    expect(guide).toContain("ouro status")
    expect(guide).toContain("ouro doctor")
    expect(guide).not.toContain("ouro doctor --agent")
    expect(guide).toContain("Mail row is ready/running")
    expect(guide).toContain("<agent>@ouro.bot")
    expect(guide).toContain("runtime/config")
    expect(guide).toContain("~/AgentBundles/<agent>.ouro/state/mailroom/")
    expect(guide).toContain("Vault coupling")
    expect(guide).toContain("Bundle state")
    expect(guide).toContain("ouroborosbot/ouro-work-substrate")
    expect(guide).toContain("Hosted service source")
  })

  it("locks setup as an agent-guided workflow instead of a human CLI checklist", () => {
    const guide = readGuide()

    expect(guide).toContain("The human should not be the CLI operator for Agent Mail setup")
    expect(guide).toContain("Do not turn this into a terminal checklist for the human")
    expect(guide).toContain("the agent must not tell the human to run `ouro account ensure`, `ouro connect mail`, `ouro mail import-mbox`, `ouro status`, or `ouro doctor` for setup")
    expect(guide).toContain("the next step is a tool-capable Ouro setup session or companion, not shifting CLI operation to the human")
    expect(guide).toContain("The agent runs agent-runnable commands itself")
    expect(guide).toContain("The agent verifies each step before asking for the next one")
    expect(guide).toContain("Agent command after the human provides the file path")
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

  it("keeps HEY forwarding as a Slugger-managed browser workflow with explicit delegated alias recovery", () => {
    const guide = readGuide()

    expect(guide).toContain("Slugger drives the browser-automation portion")
    expect(guide).toContain("The human remains at the keyboard for HEY login, MFA, CAPTCHA, export download, and final forwarding confirmation")
    expect(guide).toContain("me.mendelow.ari.slugger@ouro.bot")
    expect(guide).toContain("Do not forward Ari's HEY mailbox to `slugger@ouro.bot`")
    expect(guide).toContain("sourceFreshThrough")
    expect(guide).toContain("Archive imports are historical backfill")
    expect(guide).toContain("Forwarding status can be `blocked_by_human`, `pending_propagation`, `ready`, or `failed_recoverable`")
  })
})
