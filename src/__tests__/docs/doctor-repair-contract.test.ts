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
    expect(readme).toContain("three authority passes")
    expect(readme).toContain("20 concurrent body reads")
    expect(readme).toContain("30-second heartbeat")
    expect(readme).toContain("durable per-message missing-key receipts")
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
    expect(recovery).toContain("three authority passes")
    expect(recovery).toContain("20 concurrent body reads")
    expect(recovery).toContain("30-second heartbeat")
    expect(recovery).toContain("missing-key receipts")
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
    expect(mailRecovery).toContain("consecutive equal authority fingerprints")
    expect(mailRecovery).toContain("missing-key receipts")
  })

  it("tracks raw-orphan debt with CI-enforced ownership, expiry, and removal criteria", () => {
    const debt = JSON.parse(readRepoFile("docs", "intentional-debt.json")) as {
      items: Array<Record<string, unknown>>
    }
    const item = debt.items.find((entry) => entry.id === "mailroom-encrypted-raw-orphans")
    expect(item).toEqual(expect.objectContaining({
      status: "open",
      owner: "Mailroom",
      due: "2026-09-30",
    }))
    expect(String(item?.removalCriteria)).toContain("transaction")
    expect(String(item?.removalCriteria)).toContain("orphan")

    const releasePreflight = readRepoFile("scripts", "release-preflight.cjs")
    expect(releasePreflight).toContain("validateIntentionalDebt")
    expect(releasePreflight).toContain("intentional debt gate")
  })

  it("aligns the next release metadata after the cache-truth implementation", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as { version: string }
    const wrapper = JSON.parse(readRepoFile("packages", "ouro.bot", "package.json")) as { version: string }
    const changelog = JSON.parse(readRepoFile("changelog.json")) as {
      versions: Array<{ version: string; changes: string[] }>
    }
    expect(packageJson.version).toBe("0.1.0-alpha.733")
    expect(wrapper.version).toBe(packageJson.version)
    expect(changelog.versions[0]?.version).toBe(packageJson.version)
    expect(changelog.versions[0]?.changes.join("\n")).toContain("create-once")
    expect(changelog.versions[0]?.changes.join("\n")).toContain("missing-key receipts")
    expect(changelog.versions[0]?.changes.join("\n")).toContain("stable")
  })
})
