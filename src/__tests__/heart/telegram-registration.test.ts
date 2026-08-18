import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

import { DEFAULT_AGENT_SENSES, normalizeSenses, type SenseName } from "../../heart/identity"
import { getSenseInventory } from "../../heart/sense-truth"

describe("Telegram sense registration", () => {
  it("is a closed SenseName entry with disabled default and normalized config", () => {
    const sense: SenseName = "telegram"
    expect(sense).toBe("telegram")
    expect(DEFAULT_AGENT_SENSES.telegram).toEqual({ enabled: false })
    expect(normalizeSenses({ telegram: { enabled: true } }, "/tmp/agent.json").telegram).toEqual({ enabled: true })
  })

  it("is daemon-managed and reports readiness from runtime configuration", () => {
    const enabled = normalizeSenses({ telegram: { enabled: true } }, "/tmp/agent.json")
    const ready = getSenseInventory({ senses: enabled }, { telegram: { configured: true } })
      .find((entry) => entry.sense === "telegram")
    const missing = getSenseInventory({ senses: enabled }, { telegram: { configured: false } })
      .find((entry) => entry.sense === "telegram")
    expect(ready).toMatchObject({ label: "Telegram", enabled: true, daemonManaged: true, status: "ready" })
    expect(missing).toMatchObject({ status: "needs_config" })
  })

  it("ships the daemon entrypoint that waits for credential bootstrap before polling", () => {
    const entry = path.resolve(__dirname, "../../senses/telegram-entry.ts")
    expect(fs.existsSync(entry)).toBe(true)
    const source = fs.readFileSync(entry, "utf8")
    expect(source).toContain("waitForRuntimeCredentialBootstrap")
    expect(source).toContain("await app.run()")
  })
})
