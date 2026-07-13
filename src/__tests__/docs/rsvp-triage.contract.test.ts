import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"

describe("docs/rsvp-triage contract", () => {
  it("documents the generic RSVP operational triage flow", () => {
    const guidePath = path.resolve(process.cwd(), "docs", "rsvp-triage.md")
    expect(fs.existsSync(guidePath)).toBe(true)

    const content = fs.readFileSync(guidePath, "utf-8")
    expect(content).toContain("ouro status --json")
    expect(content).toContain("ouro rsvp doctor --agent <agent> --json --strict")
    expect(content).toContain("ouro rsvp incident --agent <agent> --output")
    expect(content).toContain("ouro rsvp replay --fixture")
    expect(content).toContain("ouro rsvp legacy-render --legacy-root")
    expect(content).toContain("ouro rsvp refresh --agent <agent> --mode shadow --no-send")
    expect(content).toContain("ouro rsvp smoke --agent <agent> --mode preflight")
    expect(content).toContain("state/senses/context-packets")
    expect(content).toContain("state/senses/bluebubbles/outbound")
    expect(content).toContain("state/rsvp")
    expect(content).toContain("arc/flight-recorder")
    expect(content).toContain("Do not paste raw chat GUIDs, BlueBubbles URLs, cookies, or credentials")
    expect(content).toContain("searchIndex: false")
    expect(content).toContain("vectorIndex: false")
  })
})
