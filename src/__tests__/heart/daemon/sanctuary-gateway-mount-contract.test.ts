import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import { auditSanctuaryContainerSpec, auditSanctuaryPersistentTemplate, auditSanctuaryStagedFiles } from "../../../heart/daemon/container-spec-auditor"
import { runContainerSpecAuditorCli } from "../../../heart/daemon/container-spec-auditor-main"
import { sanctuaryContainerInspectFixture } from "../../fixtures/sanctuary-container"

const image = `sha256:${"a".repeat(64)}`
const reference = "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.816"
const icon = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
const socketMount = { Type: "bind", Source: "/run/ouro-authority", Destination: "/run/ouro-authority", RW: false, Propagation: "rprivate" }
const socketBind = "/run/ouro-authority:/run/ouro-authority:ro"
const policy = '{"scheduler":"supercronic","updates":"disabled"}'

function spec(gateway: boolean) {
  const value = sanctuaryContainerInspectFixture()
  value.Config.Image = reference
  value.Mounts.splice(3)
  if (gateway) value.Mounts.push({ ...socketMount })
  return value
}

function template(gateway: boolean, repository = image) {
  return `<?xml version="1.0"?>
<Container version="2">
<Name>ouro-butler</Name><Repository>${repository}</Repository>
<Network>host</Network><Privileged>false</Privileged>
<TemplateURL>https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml</TemplateURL>
<Icon>${icon}</Icon><WebUI/><ExtraParams>--restart=unless-stopped --user=10001:10001</ExtraParams><PostArgs></PostArgs>
<Config Target="/home/ouro/.ouro-cli" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/runtime/.ouro-cli</Config>
<Config Target="/home/ouro/AgentBundles/sanctuary.ouro" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro</Config>
<Config Target="/run/ouro-events" Mode="ro" Type="Path">/boot/config/custom/ouro-events/spool</Config>
${gateway ? '<Config Target="/run/ouro-authority" Mode="ro" Type="Path">/run/ouro-authority</Config>' : ""}
</Container>`
}

describe("versioned Sanctuary gateway deployment mounts", () => {
  it("runs packaged-image CI against the exact gateway mounts and every explicit audit mode", () => {
    const workflow = fs.readFileSync(".github/workflows/coverage.yml", "utf8")
    const create = workflow.match(/docker create --pull=never --name ouro-butler[\s\S]*?"\$AUDIT_VERSION_IMAGE"/u)?.[0] ?? ""
    expect(create.match(/--mount type=bind,/gu)).toHaveLength(4)
    expect(create).toContain("--mount type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly")
    const preparation = workflow.slice(workflow.indexOf("for AUDIT_SOURCE in"), workflow.indexOf('AUDIT_ICON='))
    expect(preparation.match(/\/run\/ouro-authority/gu)).toHaveLength(3)
    for (const mode of ["--inspect", "--persistent-template", "--template"]) {
      const call = workflow.split("\n").find(line => line.trimStart().startsWith(`${mode} `))
      expect(call).toContain("--mount-contract canonical-gateway")
    }
  })

  it("packages the gateway image contract and the one narrow read-only socket mount", () => {
    const xml = fs.readFileSync("deploy/unraid/sanctuary.xml", "utf8")
    const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version
    expect(auditSanctuaryPersistentTemplate({ templateXml: xml, runtimePolicyText: policy, expectedImageReference: `ghcr.io/ourostack/ouroboros-butler:${packageVersion}`, mountContract: "canonical-gateway" }).ok).toBe(true)
    expect(fs.readFileSync("deploy/unraid/Dockerfile", "utf8")).toContain('bot.ouro.sanctuary.mount-contract="canonical-gateway"')
  })
  it.each(["canonical-pre-gateway", "canonical-gateway"] as const)("requires exactly the %s image contract through upgrade and rollback", (mountContract) => {
    const gateway = mountContract === "canonical-gateway"
    const options = { mountContract, expectedImage: image, expectedImageReference: reference, expectedIcon: icon, expectedEnvironment: spec(gateway).Config.Env }
    expect(auditSanctuaryContainerSpec(spec(gateway), options)).toEqual({ ok: true, violations: [] })
    expect(auditSanctuaryContainerSpec(spec(!gateway), options).ok).toBe(false)
    expect(auditSanctuaryStagedFiles({ templateXml: template(gateway), runtimePolicyText: policy, expectedImage: image, mountContract }).ok).toBe(true)
    expect(auditSanctuaryStagedFiles({ templateXml: template(!gateway), runtimePolicyText: policy, expectedImage: image, mountContract }).ok).toBe(false)
    expect(auditSanctuaryPersistentTemplate({ templateXml: template(gateway, reference), runtimePolicyText: policy, expectedImageReference: reference, mountContract }).ok).toBe(true)
    expect(auditSanctuaryPersistentTemplate({ templateXml: template(!gateway, reference), runtimePolicyText: policy, expectedImageReference: reference, mountContract }).ok).toBe(false)
    for (const mutate of [
      (value: ReturnType<typeof spec>) => { value.Name = "/other" },
      (value: ReturnType<typeof spec>) => { value.Args = [] },
      (value: ReturnType<typeof spec>) => { value.Config.Entrypoint = ["sh"] },
      (value: ReturnType<typeof spec>) => { value.Config.Image = "latest" },
      (value: ReturnType<typeof spec>) => { value.Config.Labels["net.unraid.docker.managed"] = "" },
      (value: ReturnType<typeof spec>) => { value.Config.Labels["net.unraid.docker.icon"] = "" },
    ]) {
      const value = spec(gateway)
      mutate(value)
      expect(auditSanctuaryContainerSpec(value, options).ok).toBe(false)
    }
  })

  it("refuses omitted, retired, unknown and mismatched contracts rather than choosing an image implicitly", () => {
    for (const mountContract of [undefined, "canonical", "", "other"]) {
      const options = { mountContract, expectedImage: image, expectedImageReference: reference, expectedIcon: icon, expectedEnvironment: spec(false).Config.Env }
      expect(auditSanctuaryContainerSpec(spec(false), options as never).ok).toBe(false)
      expect(auditSanctuaryStagedFiles({ templateXml: template(false), runtimePolicyText: policy, expectedImage: image, mountContract } as never).ok).toBe(false)
      expect(auditSanctuaryPersistentTemplate({ templateXml: template(false, reference), runtimePolicyText: policy, expectedImageReference: reference, mountContract } as never).ok).toBe(false)
    }
  })

  it("refuses socket write access, broad filesystem access, duplicate mounts and changed propagation", () => {
    for (const patch of [{ RW: true }, { Source: "/" }, { Destination: "/host" }, { Propagation: "rshared" }]) {
      const value = spec(true)
      Object.assign(value.Mounts[3]!, patch)
      expect(auditSanctuaryContainerSpec(value, { mountContract: "canonical-gateway", expectedImage: image, expectedImageReference: reference, expectedIcon: icon, expectedEnvironment: value.Config.Env }).ok).toBe(false)
    }
    expect(socketBind).toBe("/run/ouro-authority:/run/ouro-authority:ro")
  })

  it.each(["canonical-pre-gateway", "canonical-gateway"] as const)("carries %s explicitly through all CLI modes", (mountContract) => {
    const gateway = mountContract === "canonical-gateway"
    const files: Record<string, string> = {
      inspect: JSON.stringify([spec(gateway)]),
      image: JSON.stringify([{ Id: image, Config: { Env: spec(gateway).Config.Env } }]),
      staged: template(gateway),
      persistent: template(gateway, reference),
      policy,
    }
    for (const args of [
      ["--inspect", "inspect", "--image-inspect", "image", "--expected-image", image, "--expected-image-reference", reference, "--expected-icon", icon],
      ["--template", "staged", "--runtime-policy", "policy", "--expected-image", image],
      ["--persistent-template", "persistent", "--runtime-policy", "policy", "--expected-image-reference", reference],
    ]) {
      const deps = { readFile: (name: string) => files[name]!, write: () => undefined }
      expect(runContainerSpecAuditorCli([...args, "--mount-contract", mountContract], deps)).toBe(0)
      expect(runContainerSpecAuditorCli(args, deps)).toBe(2)
    }
  })
})
