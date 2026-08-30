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

    expect(template).toContain("<Name>ouro-butler</Name>")
    expect(template).toContain("<Overview>Mendelow Cloud Butler")
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
    expect(workflow).toContain("provenance: mode=max")
    expect(workflow).toContain("sbom: true")
    const attestationCalls = [...workflow.matchAll(/verify_exact_attestations "\$EXACT_IMAGE"/gu)].map((match) => match.index)
    const logoutIndex = workflow.indexOf("docker logout ghcr.io")
    expect(attestationCalls).toHaveLength(2)
    expect(attestationCalls[0]).toBeLessThan(logoutIndex)
    expect(attestationCalls[1]).toBeGreaterThan(logoutIndex)
    expect(workflow).toContain('EXACT_IMAGE="$VERSION_IMAGE@${{ steps.exact-references.outputs.digest }}"')
    expect(workflow).toContain("--format '{{json .Provenance}}'")
    expect(workflow).toContain("--format '{{json .SBOM}}'")
    expect(workflow).toContain('["linux/amd64", "linux/arm64"]')
    expect(workflow).toContain("gh api /orgs/ourostack/packages/container/ouroboros-butler --jq .visibility")
    expect(workflow).toContain("docker logout ghcr.io")
    const publishIndex = workflow.indexOf("uses: docker/build-push-action@v6")
    const visibilityVerificationIndex = workflow.indexOf("VISIBILITY=$(gh api /orgs/ourostack/packages/container/ouroboros-butler --jq .visibility)")
    const anonymousVerificationIndex = workflow.indexOf("docker logout ghcr.io")
    expect(workflow).not.toContain("--method PATCH")
    expect(workflow).not.toContain("visibility=public")
    expect(visibilityVerificationIndex).toBeGreaterThan(publishIndex)
    expect(anonymousVerificationIndex).toBeGreaterThan(visibilityVerificationIndex)
  })

  it("installs privileged event assets from the exact reviewed image before Butler mutation", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const installer = fs.readFileSync("deploy/unraid/ouro-events/install-usenet-guard.sh", "utf8")
    const defaultInstallRoot = installer.match(/^INSTALL_ROOT="([^"]+)"$/mu)?.[1]
    expect(defaultInstallRoot).toBeTruthy()
    const bootHook = `/bin/bash ${defaultInstallRoot}/ouro-events/install-usenet-guard.sh --boot --install-root ${defaultInstallRoot}`
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("\nBackup:"))
    const extractIndex = update.indexOf('docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/ouro-events/." "$EVENT_SCRIPT_STAGE/"')
    const templateExtractIndex = update.indexOf('docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/sanctuary.xml" "$STAGED_TEMPLATE"')
    const policyExtractIndex = update.indexOf('docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/container-runtime.json" "$STAGED_RUNTIME_POLICY"')
    const installIndex = update.indexOf('/bin/bash "$EVENT_SCRIPT_STAGE/install-usenet-guard.sh" --source-root "$EVENT_SCRIPT_STAGE"')
    const verifyIndex = update.indexOf("\n    verify_installed_usenet_guard\n")
    const repositoryStageIndex = update.indexOf('const repositories = [...source.matchAll(/<Repository>[^<]*<\\/Repository>/g)];')
    const stagedAuditIndex = update.indexOf('"$IMAGE_ID" --template /audit/sanctuary.xml --runtime-policy /audit/container-runtime.json --expected-image "$IMAGE_ID"')
    const cleanupIndex = update.indexOf("\n    cleanup_event_asset_stage\n")
    const firstButlerStopIndex = update.indexOf("docker stop ouro-butler")
    const firstButlerCreateIndex = update.indexOf("docker create --name ouro-butler")

    expect(update).toContain('docker create --pull=never --network none --read-only --entrypoint /bin/false "$IMAGE_ID"')
    expect(update).toContain('test "$(docker inspect --format \'{{.Image}}\' "$EVENT_ASSET_CONTAINER")" = "$IMAGE_ID"')
    expect(update).toContain("EXPECTED_EVENT_ASSETS=")
    expect(update).toContain("usenet-health.sh")
    expect(update).toContain("install-usenet-guard.sh")
    expect(update).toContain(`    ${bootHook}\n`)
    expect(update).toContain(`grep -Fxc '${bootHook}' /boot/config/go`)
    expect(update).toContain("/bin/bash /boot/config/custom/usenet_health.sh # ouro:usenet-health")
    expect(update).toContain("findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool")
    expect(update).toContain("nodev nosuid noexec")
    expect(update).not.toContain("cp deploy/unraid/ouro-events")
    expect(update).not.toContain("REPLACE_WITH_EXACT_LOCAL_IMAGE_ID")
    expect(runbook).not.toMatch(/^\s+\/boot\/config\/custom\/ouro-events\/[^ ]+\.sh(?:\s|$)/gmu)
    expect(extractIndex).toBeGreaterThan(0)
    expect(templateExtractIndex).toBeGreaterThan(extractIndex)
    expect(policyExtractIndex).toBeGreaterThan(templateExtractIndex)
    expect(installIndex).toBeGreaterThan(extractIndex)
    expect(verifyIndex).toBeGreaterThan(installIndex)
    expect(repositoryStageIndex).toBeGreaterThan(verifyIndex)
    expect(stagedAuditIndex).toBeGreaterThan(repositoryStageIndex)
    expect(cleanupIndex).toBeGreaterThan(stagedAuditIndex)
    expect(firstButlerStopIndex).toBeGreaterThan(verifyIndex)
    expect(firstButlerCreateIndex).toBeGreaterThan(verifyIndex)
  })

  it("keeps installed guard scripts root-executable and verifies the same exact modes", () => {
    const installer = fs.readFileSync("deploy/unraid/ouro-events/install-usenet-guard.sh", "utf8")
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const targetNames = installer.match(/^ASSET_NAMES=\(([^)]+)\)$/mu)?.[1].split(/\s+/u) ?? []
    const verifiedModes = [...runbook.matchAll(/stat -c '%u:%g:%a' \/boot\/config\/custom\/(?:ouro-events\/)?(?:usenet_health\.sh|bootstrap-spool\.sh|emit-event\.mjs|emit-usenet-event\.sh|install-usenet-guard\.sh)\)" = ([0-9:]+)/gu)].map((match) => match[1])

    expect(targetNames).toEqual(["usenet-health.sh", "bootstrap-spool.sh", "emit-event.mjs", "emit-usenet-event.sh", "install-usenet-guard.sh"])
    expect(installer).toContain('atomic_install "$stage/${ASSET_NAMES[$index]}" "${TARGET_PATHS[$index]}" 0700')
    expect(installer).not.toMatch(/TARGET_PATHS=.*(?:credential|secret|token|\.ini)/iu)
    expect(verifiedModes).toEqual(Array(5).fill("0:0:700"))
  })

  it("documents the exact two read-write and two read-only production mounts", () => {
    const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")

    expect(runbook).toContain("mounts the runtime and sanctuary.ouro bundle read-write plus")
    expect(runbook).toContain("the privileged event spool and SAB configuration read-only")
    expect(runbook).not.toContain("mounts only the runtime and sanctuary.ouro bundle paths")
  })
})
