import * as fs from "node:fs"

import { describe, expect, it } from "vitest"

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }

describe("Mendelow Cloud Butler Community Apps release", () => {
  it("serializes repository container publications without cancelling an in-flight release", () => {
    const workflow = fs.readFileSync(".github/workflows/container-publish.yml", "utf8")
    const concurrencyIndex = workflow.indexOf("\nconcurrency:\n")
    const jobsIndex = workflow.indexOf("\njobs:\n")

    expect(concurrencyIndex).toBeGreaterThan(0)
    expect(concurrencyIndex).toBeLessThan(jobsIndex)
    expect(workflow).toContain("group: container-publish-${{ github.repository }}")
    expect(workflow).toContain("cancel-in-progress: false")
  })

  it("publishes the required repository profile from canonical project metadata", () => {
    const profile = fs.readFileSync("ca_profile.xml", "utf8")
    const profileBody = profile.match(/<Profile>([\s\S]*?)<\/Profile>/u)?.[1].trim()

    expect(profile).toContain("<CommunityApplications>")
    expect(profileBody).toBeTruthy()
    expect(profile).toContain("https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png")
    expect(profile).toContain("<WebPage>https://ouroboros.bot</WebPage>")
    expect(profile).toContain("<Forum>https://github.com/ourostack/ouroboros/issues</Forum>")
  })

  it("publishes one complete versioned Community Apps template", () => {
    const template = fs.readFileSync("deploy/unraid/sanctuary.xml", "utf8")

    expect(template).toContain("<Name>Mendelow Cloud Butler</Name>")
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

    expect(dockerfile).toContain('LABEL org.opencontainers.image.source="https://github.com/ourostack/ouroboros"')
    expect(dockerfile).toContain("ARG TARGETARCH")
    expect(dockerfile).toContain("supercronic-linux-${TARGETARCH}")
    expect(dockerfile).toContain("5adff01c5a797663948e656d2b61d10932369ee437eb5cb54fa872b2960f222b")
    expect(dockerfile).toContain("c0576a8eb092e3f79108ed0a2155a25c7766af78456e5a6070e54757ef513bfe")
    expect(dockerfile).not.toContain("supercronic-linux-amd64 \\")
  })

  it("publishes one immutable public multi-architecture image per release version", () => {
    const workflow = fs.readFileSync(".github/workflows/container-publish.yml", "utf8")

    expect(workflow).toContain("packages: write")
    expect(workflow).toContain("linux/amd64,linux/arm64")
    expect(workflow).toContain("ghcr.io/ourostack/ouroboros-butler")
    expect(workflow).toContain("deploy/unraid/Dockerfile")
    expect(workflow).toContain('scripts/container-image-release-gate.sh "$VERSION_IMAGE" "$SHA_IMAGE"')
    expect(workflow).toContain("steps.release-gate.outputs.publish == 'true'")
    expect(workflow).toContain("Verify exact immutable references")
    expect(workflow).toContain("Verify anonymous immutable references")
    expect(workflow).toContain("gh api /orgs/ourostack/packages/container/ouroboros-butler --jq .visibility")
    expect(workflow).toContain("docker logout ghcr.io")
    expect(workflow).not.toContain("--method PATCH")
    expect(workflow).not.toContain("visibility=public")
  })
})
