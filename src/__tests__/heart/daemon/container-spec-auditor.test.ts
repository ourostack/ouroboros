import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { auditSanctuaryContainerSpec, auditSanctuaryStagedFiles } from "../../../heart/daemon/container-spec-auditor"
import { runContainerSpecAuditorCli } from "../../../heart/daemon/container-spec-auditor-main"

function validInspect() {
  return {
    Config: {
      User: "10001:10001",
      Image: "sha256:" + "a".repeat(64),
      Entrypoint: ["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"],
      Cmd: [],
      Env: ["HOME=/home/ouro"],
      ExposedPorts: null,
    },
    HostConfig: {
      NetworkMode: "host",
      Privileged: false,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Binds: [
        "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
        "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
      ],
      PortBindings: {},
      Devices: [],
      CapAdd: null,
    },
    Mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", Destination: "/home/ouro/.ouro-cli", RW: true },
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", Destination: "/home/ouro/AgentBundles/sanctuary.ouro", RW: true },
    ],
  }
}

function stagedTemplate(): string {
  return [
    "<Container>",
    `<Repository>sha256:${"a".repeat(64)}</Repository>`,
    "<Network>host</Network>",
    "<Privileged>false</Privileged>",
    "<ExtraParams>--restart=unless-stopped --user=10001:10001</ExtraParams>",
    '<Config Target="/home/ouro/.ouro-cli" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/runtime/.ouro-cli</Config>',
    '<Config Target="/home/ouro/AgentBundles/sanctuary.ouro" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro</Config>',
    "</Container>",
  ].join("\n")
}

describe("Sanctuary pre-activation container auditor", () => {
  it("accepts only the exact released effective spec", () => {
    expect(auditSanctuaryContainerSpec(validInspect(), {
      expectedImage: "sha256:" + "a".repeat(64),
    })).toEqual({ ok: true, violations: [] })
  })

  it.each([
    ["wrong user", (spec: any) => { spec.Config.User = "root" }],
    ["mutable image", (spec: any) => { spec.Config.Image = "ouro-butler:latest" }],
    ["wrong entrypoint", (spec: any) => { spec.Config.Entrypoint = ["sh"] }],
    ["extra command", (spec: any) => { spec.Config.Cmd = ["sleep", "infinity"] }],
    ["wrong home", (spec: any) => { spec.Config.Env = ["HOME=/tmp"] }],
    ["published port", (spec: any) => { spec.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "8080" }] } }],
    ["exposed port", (spec: any) => { spec.Config.ExposedPorts = { "80/tcp": {} } }],
    ["bridge network", (spec: any) => { spec.HostConfig.NetworkMode = "bridge" }],
    ["privileged", (spec: any) => { spec.HostConfig.Privileged = true }],
    ["wrong restart", (spec: any) => { spec.HostConfig.RestartPolicy.Name = "always" }],
    ["device", (spec: any) => { spec.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }] }],
    ["capability", (spec: any) => { spec.HostConfig.CapAdd = ["SYS_ADMIN"] }],
    ["Docker socket", (spec: any) => { spec.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock:rw") }],
    ["host root", (spec: any) => { spec.HostConfig.Binds.push("/:/host:ro") }],
    ["missing bind", (spec: any) => { spec.HostConfig.Binds.pop(); spec.Mounts.pop() }],
    ["read-only bind", (spec: any) => { spec.Mounts[0].RW = false }],
  ])("rejects %s", (_label, mutate) => {
    const spec = validInspect()
    mutate(spec)
    const result = auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64) })
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it("fails closed across malformed optional inspect fields", () => {
    const mutations: Array<(spec: any) => void> = [
      (spec) => { spec.Config.Env = ["HOME=/home/ouro", 7] },
      (spec) => { spec.HostConfig.Binds = [7] },
      (spec) => { spec.Mounts = "not-an-array" },
      (spec) => { spec.Mounts[0] = null },
      (spec) => { spec.Config.ExposedPorts = [] },
    ]
    for (const mutate of mutations) {
      const spec = validInspect()
      mutate(spec)
      expect(auditSanctuaryContainerSpec(spec, { expectedImage: "mutable" }).ok).toBe(false)
    }
  })

  it.each([null, [], {}, "not-json"])("fails closed for malformed inspect shape %#", (spec) => {
    expect(auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64) }).ok).toBe(false)
  })

  it.each([
    "ouro-butler:latest",
    "ouro-butler:0.1.0-alpha.734",
    "ouro-butler@sha256:" + "a".repeat(64),
    "sha256:" + "A".repeat(64),
    "sha256:" + "a".repeat(63),
  ])("rejects non-local or malformed expected image identity: %s", (expectedImage) => {
    const spec = validInspect()
    spec.Config.Image = expectedImage

    expect(auditSanctuaryContainerSpec(spec, { expectedImage })).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["expected image must be an exact local Docker image ID"]),
    }))
  })

  it("rejects an effective image that differs from the reviewed local image ID", () => {
    const spec = validInspect()
    spec.Config.Image = "sha256:" + "b".repeat(64)

    expect(auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64) })).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["image does not match the reviewed exact local Docker image ID"]),
    }))
  })

  it("runs the packaged file-based auditor without echoing the inspect payload", () => {
    const output: string[] = []
    const exitCode = runContainerSpecAuditorCli([
      "--template", "/tmp/template.xml",
      "--runtime-policy", "/tmp/runtime.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => filePath.endsWith(".xml") ? stagedTemplate() : JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      write: (text) => output.push(text),
    })

    expect(exitCode).toBe(0)
    expect(output.join("")).toContain('"ok":true')
    expect(output.join("")).not.toContain("/mnt/user")

    expect(runContainerSpecAuditorCli([
      "--template", "/tmp/template.xml",
      "--runtime-policy", "/tmp/runtime.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => filePath.endsWith(".xml") ? "<Container />" : "{}",
      write: () => undefined,
    })).toBe(1)
  })

  it("fails closed for missing arguments and unreadable JSON", () => {
    expect(runContainerSpecAuditorCli([], { readFile: () => "{}", write: () => undefined })).toBe(2)
    expect(runContainerSpecAuditorCli([
      "--template", "/tmp/template.xml",
      "--runtime-policy", "/tmp/runtime.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], { readFile: () => { throw new Error("missing") }, write: () => undefined })).toBe(2)
    expect(runContainerSpecAuditorCli([
      "--template", "/tmp/template.xml",
      "--runtime-policy", "/tmp/runtime.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], { readFile: () => { throw "missing" }, write: () => undefined })).toBe(2)
  })

  it("uses filesystem/stdout adapters when dependencies are omitted", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-staged-audit-"))
    const templatePath = path.join(directory, "template.xml")
    const policyPath = path.join(directory, "runtime.json")
    fs.writeFileSync(templatePath, stagedTemplate())
    fs.writeFileSync(policyPath, JSON.stringify({ scheduler: "supercronic", updates: "disabled" }))
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      expect(runContainerSpecAuditorCli([
        "--template", templatePath,
        "--runtime-policy", policyPath,
        "--expected-image", "sha256:" + "a".repeat(64),
      ])).toBe(0)
      expect(write).toHaveBeenCalled()
    } finally {
      write.mockRestore()
      fs.rmSync(directory, { recursive: true })
    }
  })

  it("audits staged template equality and updater-off policy before creation", () => {
    const expectedImage = "sha256:" + "a".repeat(64)
    expect(auditSanctuaryStagedFiles({
      templateXml: stagedTemplate(),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage,
    })).toEqual({ ok: true, violations: [] })
    expect(auditSanctuaryStagedFiles({
      templateXml: stagedTemplate(),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "enabled" }),
      expectedImage,
    }).ok).toBe(false)
    expect(auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace("Type=\"Path\"", "Type=\"Port\""),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage,
    }).ok).toBe(false)
    expect(auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace('Target="/home/ouro/.ouro-cli" ', ""),
      runtimePolicyText: "not-json",
      expectedImage,
    }).ok).toBe(false)
  })

  it.each([
    "--privileged",
    "--cap-add=SYS_ADMIN",
    "-p 8080:8080",
    "--device=/dev/sda",
    "-v /mnt/user:/host",
  ])("rejects unapproved staged ExtraParams authority: %s", (extra) => {
    const result = auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace(
        "--restart=unless-stopped --user=10001:10001",
        `--restart=unless-stopped --user=10001:10001 ${extra}`,
      ),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage: "sha256:" + "a".repeat(64),
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["template ExtraParams must equal the canonical user and restart flags"]),
    }))
  })
})
