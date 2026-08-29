import * as fs from "node:fs"

import { describe, expect, it } from "vitest"

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }

describe("Mendelow Cloud Butler Community Apps release", () => {
  it("publishes one complete versioned Community Apps template", () => {
    const template = fs.readFileSync("deploy/unraid/sanctuary.xml", "utf8")

    expect(template).toContain(`<Repository>ghcr.io/ourostack/ouroboros-butler:${packageVersion.version}</Repository>`)
    expect(template).toContain("<Registry>https://github.com/ourostack/ouroboros/pkgs/container/ouroboros-butler</Registry>")
    expect(template).toContain("<Support>https://github.com/ourostack/ouroboros/issues</Support>")
    expect(template).toContain("<Project>https://ouroboros.bot</Project>")
    expect(template).toContain("<TemplateURL>https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml</TemplateURL>")
    expect(template).toContain("<Icon>https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png</Icon>")
    expect(template).not.toContain("REPLACE_WITH_EXACT_LOCAL_IMAGE_ID")
    expect(template).not.toMatch(/<Registry\s*\/>/u)
    expect(template).not.toMatch(/<Support\s*\/>/u)
    expect(template).not.toMatch(/<Project\s*\/>/u)
    expect(template).not.toMatch(/<TemplateURL\s*\/>/u)
    expect(template).not.toMatch(/<Icon\s*\/>/u)
  })

  it("mounts the root-owned privileged event spool read-only without adding secrets", () => {
    const template = fs.readFileSync("deploy/unraid/sanctuary.xml", "utf8")

    expect(template).toContain('Target="/run/ouro-events"')
    expect(template).toContain('Default="/boot/config/custom/ouro-events/spool"')
    expect(template).toContain('Mode="ro"')
    expect(template).not.toMatch(/TELEGRAM_BOT_TOKEN|MINIMAX_API_KEY|API_KEY|PASSWORD/u)
  })

  it("builds the scheduler for both published image architectures", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")

    expect(dockerfile).toContain("ARG TARGETARCH")
    expect(dockerfile).toContain("supercronic-linux-${TARGETARCH}")
    expect(dockerfile).toContain("5adff01c5a797663948e656d2b61d10932369ee437eb5cb54fa872b2960f222b")
    expect(dockerfile).toContain("c0576a8eb092e3f79108ed0a2155a25c7766af78456e5a6070e54757ef513bfe")
    expect(dockerfile).not.toContain("supercronic-linux-amd64 \\")
  })

  it("publishes the same image version for amd64 and arm64", () => {
    const workflow = fs.readFileSync(".github/workflows/container-publish.yml", "utf8")

    expect(workflow).toContain("packages: write")
    expect(workflow).toContain("linux/amd64,linux/arm64")
    expect(workflow).toContain("ghcr.io/ourostack/ouroboros-butler")
    expect(workflow).toContain("deploy/unraid/Dockerfile")
    expect(workflow).toContain("/orgs/ourostack/packages/container/ouroboros-butler")
    expect(workflow).toContain("visibility=public")
  })
})
