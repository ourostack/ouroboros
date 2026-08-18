import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf8")
}

describe("doctor and bounded-repair documentation contract", () => {
  it("exposes standard BlueBubbles, mail-cache, and log repairs from the main setup guide", () => {
    const readme = readRepoFile("README.md")

    expect(readme).toContain("quiet is not delivery-failure proof")
    expect(readme).toContain("ouro mail sync-cache --agent <name>")
    expect(readme).toContain("ouro logs prune --agent <name>")
    expect(readme).toContain("reconstructible local cache")
  })

  it("documents evidence boundaries and exact bounded recovery commands", () => {
    const recovery = readRepoFile("docs", "known-issues-and-recovery.md")

    expect(recovery).toContain("upstream and exact webhook are healthy")
    expect(recovery).toContain("quiet/unverified")
    expect(recovery).toContain("directories without `agent.json`")
    expect(recovery).toContain("ouro mail sync-cache --agent <name>")
    expect(recovery).toContain("does not mutate hosted mail")
    expect(recovery).toContain("ouro logs prune --agent <name>")
    expect(recovery).toContain("present `agent.json`")
  })

  it("keeps the auth/setup guide explicit about standard BlueBubbles diagnosis", () => {
    const authGuide = readRepoFile("docs", "auth-and-providers.md")

    expect(authGuide).toContain("quiet/unverified")
    expect(authGuide).toContain("does not synthesize an inbound message")
    expect(authGuide).toContain("ouro connect bluebubbles --agent <agent>")
  })

  it("documents hosted authority comparison and local-only cache repair in mail recovery", () => {
    const mailRecovery = readRepoFile("docs", "agent-mail-recovery.md")

    expect(mailRecovery).toContain("hosted index authority")
    expect(mailRecovery).toContain("ouro mail sync-cache --agent <agent>")
    expect(mailRecovery).toContain("read-only authority observation")
    expect(mailRecovery).toContain("reconstructible local search cache")
    expect(mailRecovery).toContain("does not mutate hosted mail")
  })
})
