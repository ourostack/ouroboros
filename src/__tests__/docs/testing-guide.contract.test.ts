import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"

describe("docs/testing-guide contract", () => {
  it("documents the required end-to-end ouro workflow", () => {
    const guidePath = path.resolve(process.cwd(), "docs", "testing-guide.md")
    expect(fs.existsSync(guidePath)).toBe(true)

    const content = fs.readFileSync(guidePath, "utf-8")
    expect(content).toContain("npx ouro.bot")
    expect(content).toContain("ouro up")
    expect(content).toContain("ouro status")
    expect(content).toContain("ouro hatch")
    expect(content).toContain("ouro chat")
    expect(content).toContain("ouro msg")
    expect(content).toContain("ouro poke")
    expect(content).toContain("ouro stop")
    expect(content).toContain("Expected:")
    expect(content).toContain("Troubleshooting")
    expect(content).toContain("agent.json")
    expect(content).toContain("owning agent's vault")
    expect(content).toContain("ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>")
    expect(content).toContain("`ouro auth` stores credentials only")
  })
})
