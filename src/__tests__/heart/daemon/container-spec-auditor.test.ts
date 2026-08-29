import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { auditSanctuaryContainerSpec, auditSanctuaryStagedFiles } from "../../../heart/daemon/container-spec-auditor"
import { runContainerSpecAuditorCli, runContainerSpecAuditorMain } from "../../../heart/daemon/container-spec-auditor-main"

function validInspect() {
  return {
    Path: "node",
    Args: ["/opt/ouro/dist/heart/daemon/daemon-entry.js"],
    Config: {
      User: "10001:10001",
      Image: "sha256:" + "a".repeat(64),
      Entrypoint: ["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"],
      Cmd: [],
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.18.0", "HOME=/home/ouro"],
      ExposedPorts: null,
    },
    HostConfig: {
      NetworkMode: "host",
      PidMode: "",
      IpcMode: "private",
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: null,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Binds: [
        "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
        "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
        "/boot/config/custom/ouro-events/spool:/run/ouro-events:ro",
        "/mnt/user/appdata/sabnzbd/sabnzbd.ini:/run/sanctuary/sabnzbd.ini:ro",
      ],
      PortBindings: {},
      Devices: [],
      CapAdd: null,
      CapDrop: null,
      PublishAllPorts: false,
    },
    Mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", Destination: "/home/ouro/.ouro-cli", RW: true },
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", Destination: "/home/ouro/AgentBundles/sanctuary.ouro", RW: true },
      { Type: "bind", Source: "/boot/config/custom/ouro-events/spool", Destination: "/run/ouro-events", RW: false },
      { Type: "bind", Source: "/mnt/user/appdata/sabnzbd/sabnzbd.ini", Destination: "/run/sanctuary/sabnzbd.ini", RW: false },
    ],
    NetworkSettings: { Ports: {} },
  }
}

function validImageInspect() {
  return {
    Id: "sha256:" + "a".repeat(64),
    Config: {
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.18.0", "HOME=/home/ouro"],
    },
  }
}

const expectedEnvironment = validImageInspect().Config.Env

function stagedTemplate(): string {
  return [
    "<Container>",
    `<Repository>sha256:${"a".repeat(64)}</Repository>`,
    "<Network>host</Network>",
    "<Privileged>false</Privileged>",
    "<ExtraParams>--restart=unless-stopped --user=10001:10001</ExtraParams>",
    "<PostArgs></PostArgs>",
    '<Config Target="/home/ouro/.ouro-cli" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/runtime/.ouro-cli</Config>',
    '<Config Target="/home/ouro/AgentBundles/sanctuary.ouro" Mode="rw" Type="Path">/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro</Config>',
    '<Config Target="/run/ouro-events" Mode="ro" Type="Path">/boot/config/custom/ouro-events/spool</Config>',
    '<Config Target="/run/sanctuary/sabnzbd.ini" Mode="ro" Type="Path">/mnt/user/appdata/sabnzbd/sabnzbd.ini</Config>',
    "</Container>",
  ].join("\n")
}

describe("Sanctuary pre-activation container auditor", () => {
  it("runs the CLI only when invoked as the packaged entrypoint", () => {
    const runner = vi.fn(() => 7)
    process.exitCode = undefined

    runContainerSpecAuditorMain(false, ["ignored"], runner)
    expect(runner).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()

    runContainerSpecAuditorMain(true, ["audit"], runner)
    expect(runner).toHaveBeenCalledWith(["audit"])
    expect(process.exitCode).toBe(7)
    process.exitCode = undefined
  })

  it("accepts only the exact released effective spec", () => {
    expect(auditSanctuaryContainerSpec(validInspect(), {
      expectedImage: "sha256:" + "a".repeat(64),
      expectedEnvironment,
    })).toEqual({ ok: true, violations: [] })
  })

  it.each([
    ["wrong user", (spec: any) => { spec.Config.User = "root" }],
    ["mutable image", (spec: any) => { spec.Config.Image = "ouro-butler:latest" }],
    ["wrong entrypoint", (spec: any) => { spec.Config.Entrypoint = ["sh"] }],
    ["extra command", (spec: any) => { spec.Config.Cmd = ["sleep", "infinity"] }],
    ["effective path override", (spec: any) => { spec.Path = "sh" }],
    ["effective argument override", (spec: any) => { spec.Args = ["-c", "sleep infinity"] }],
    ["wrong home", (spec: any) => { spec.Config.Env = ["HOME=/tmp"] }],
    ["environment injection", (spec: any) => { spec.Config.Env.push("NODE_OPTIONS=--require=/mounted/state/injected.js") }],
    ["published port", (spec: any) => { spec.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "8080" }] } }],
    ["exposed port", (spec: any) => { spec.Config.ExposedPorts = { "80/tcp": {} } }],
    ["bridge network", (spec: any) => { spec.HostConfig.NetworkMode = "bridge" }],
    ["host pid namespace", (spec: any) => { spec.HostConfig.PidMode = "host" }],
    ["host IPC namespace", (spec: any) => { spec.HostConfig.IpcMode = "host" }],
    ["privileged", (spec: any) => { spec.HostConfig.Privileged = true }],
    ["read-only root override", (spec: any) => { spec.HostConfig.ReadonlyRootfs = true }],
    ["security option", (spec: any) => { spec.HostConfig.SecurityOpt = ["seccomp=unconfined"] }],
    ["wrong restart", (spec: any) => { spec.HostConfig.RestartPolicy.Name = "always" }],
    ["device", (spec: any) => { spec.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }] }],
    ["capability", (spec: any) => { spec.HostConfig.CapAdd = ["SYS_ADMIN"] }],
    ["dropped capability", (spec: any) => { spec.HostConfig.CapDrop = ["NET_RAW"] }],
    ["publish all ports", (spec: any) => { spec.HostConfig.PublishAllPorts = true }],
    ["effective network port", (spec: any) => { spec.NetworkSettings.Ports = { "80/tcp": [{ HostPort: "8080" }] } }],
    ["Docker socket", (spec: any) => { spec.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock:rw") }],
    ["host root", (spec: any) => { spec.HostConfig.Binds.push("/:/host:ro") }],
    ["missing bind", (spec: any) => { spec.HostConfig.Binds.pop(); spec.Mounts.pop() }],
    ["read-only bind", (spec: any) => { spec.Mounts[0].RW = false }],
  ])("rejects %s", (_label, mutate) => {
    const spec = validInspect()
    mutate(spec)
    const result = auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64), expectedEnvironment })
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it("allows only the pinned alpha.742 mount exception while retaining every other invariant", () => {
    const legacyImage = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
    const legacy = validInspect()
    legacy.Config.Image = legacyImage
    legacy.HostConfig.Binds.pop()
    legacy.Mounts.pop()
    expect(auditSanctuaryContainerSpec(legacy, {
      expectedImage: legacyImage,
      expectedEnvironment,
      mountContract: "legacy-alpha742",
    })).toEqual({ ok: true, violations: [] })

    const wrongImage = structuredClone(legacy)
    wrongImage.Config.Image = "sha256:" + "b".repeat(64)
    expect(auditSanctuaryContainerSpec(wrongImage, {
      expectedImage: "sha256:" + "b".repeat(64),
      expectedEnvironment,
      mountContract: "legacy-alpha742",
    }).ok).toBe(false)

    for (const mutate of [
      (spec: any) => { spec.Config.Cmd = ["sleep"] },
      (spec: any) => { spec.Config.Env.push("INJECTED=yes") },
      (spec: any) => { spec.HostConfig.PidMode = "host" },
      (spec: any) => { spec.HostConfig.SecurityOpt = ["seccomp=unconfined"] },
      (spec: any) => { spec.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock:rw") },
    ]) {
      const changed = structuredClone(legacy)
      mutate(changed)
      expect(auditSanctuaryContainerSpec(changed, {
        expectedImage: legacyImage,
        expectedEnvironment,
        mountContract: "legacy-alpha742",
      }).ok).toBe(false)
    }
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
      expect(auditSanctuaryContainerSpec(spec, { expectedImage: "mutable", expectedEnvironment }).ok).toBe(false)
    }
  })

  it.each([null, [], {}, "not-json"])("fails closed for malformed inspect shape %#", (spec) => {
    expect(auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64), expectedEnvironment }).ok).toBe(false)
  })

  it.each([
    "ouro-butler:latest",
    "ouro-butler:0.1.0-alpha.735",
    "ouro-butler@sha256:" + "a".repeat(64),
    "sha256:" + "A".repeat(64),
    "sha256:" + "a".repeat(63),
  ])("rejects non-local or malformed expected image identity: %s", (expectedImage) => {
    const spec = validInspect()
    spec.Config.Image = expectedImage

    expect(auditSanctuaryContainerSpec(spec, { expectedImage, expectedEnvironment })).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["expected image must be an exact local Docker image ID"]),
    }))
  })

  it("rejects an effective image that differs from the reviewed local image ID", () => {
    const spec = validInspect()
    spec.Config.Image = "sha256:" + "b".repeat(64)

    expect(auditSanctuaryContainerSpec(spec, { expectedImage: "sha256:" + "a".repeat(64), expectedEnvironment })).toEqual(expect.objectContaining({
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

  it("audits exactly one effective container against exactly one reviewed image without echoing either payload", () => {
    const output: string[] = []
    const container = validInspect()
    container.Config.Env = [...expectedEnvironment]
    const files: Record<string, string> = {
      "/audit/container.json": JSON.stringify([container]),
      "/audit/image.json": JSON.stringify([validImageInspect()]),
    }

    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => files[filePath]!,
      write: (text) => output.push(text),
    })).toBe(0)
    expect(output.join("")).toBe('{"ok":true,"violations":[]}\n')
    expect(output.join("")).not.toContain("NODE_VERSION")
  })

  it("exposes the pinned alpha.742 exception only through an explicit effective mount contract", () => {
    const legacyImage = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
    const container = validInspect()
    container.Config.Image = legacyImage
    container.HostConfig.Binds.pop()
    container.Mounts.pop()
    const image = validImageInspect()
    image.Id = legacyImage
    const files: Record<string, string> = {
      "/audit/container.json": JSON.stringify([container]),
      "/audit/image.json": JSON.stringify([image]),
    }
    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", legacyImage,
      "--mount-contract", "legacy-alpha742",
    ], { readFile: (filePath) => files[filePath]!, write: () => undefined })).toBe(0)
    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", legacyImage,
    ], { readFile: (filePath) => files[filePath]!, write: () => undefined })).toBe(1)
  })

  it.each([
    ["multiple containers", JSON.stringify([validInspect(), validInspect()]), JSON.stringify([validImageInspect()])],
    ["multiple images", JSON.stringify([validInspect()]), JSON.stringify([validImageInspect(), validImageInspect()])],
    ["malformed container JSON", "not-json", JSON.stringify([validImageInspect()])],
    ["malformed image JSON", JSON.stringify([validInspect()]), "not-json"],
    ["null container record", JSON.stringify([null]), JSON.stringify([validImageInspect()])],
    ["scalar container record", JSON.stringify(["secret"]), JSON.stringify([validImageInspect()])],
    ["array container record", JSON.stringify([[]]), JSON.stringify([validImageInspect()])],
    ["missing image config", JSON.stringify([validInspect()]), JSON.stringify([{ Id: validImageInspect().Id }])],
    ["scalar image config", JSON.stringify([validInspect()]), JSON.stringify([{ Id: validImageInspect().Id, Config: "secret" }])],
    ["array image config", JSON.stringify([validInspect()]), JSON.stringify([{ Id: validImageInspect().Id, Config: [] }])],
    ["non-array image environment", JSON.stringify([validInspect()]), JSON.stringify([{ Id: validImageInspect().Id, Config: { Env: "secret" } }])],
    ["non-string image environment", JSON.stringify([validInspect()]), JSON.stringify([{ Id: validImageInspect().Id, Config: { Env: ["HOME=/home/ouro", 7] } }])],
  ])("fails closed for %s without printing inspect contents", (_label, containerJson, imageJson) => {
    const output: string[] = []
    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => filePath.includes("image") ? imageJson : containerJson,
      write: (text) => output.push(text),
    })).not.toBe(0)
    expect(output.join("")).not.toContain("HOME=/home/ouro")
  })

  it("rejects mixed, duplicate, and incomplete CLI modes", () => {
    const invalidArguments = [
      ["--inspect", "/audit/container.json", "--expected-image", "sha256:" + "a".repeat(64)],
      ["--inspect", "/audit/container.json", "--inspect", "/audit/other.json", "--expected-image", "sha256:" + "a".repeat(64)],
      ["--template", "/audit/template.xml", "--image-inspect", "/audit/image.json", "--expected-image", "sha256:" + "a".repeat(64)],
      ["--inspect", "", "--image-inspect", "/audit/image.json", "--expected-image", "sha256:" + "a".repeat(64)],
    ]
    for (const args of invalidArguments) {
      expect(runContainerSpecAuditorCli(args, { readFile: () => "secret", write: () => undefined })).toBe(2)
    }
  })

  it("rejects image-inspect identity drift without printing image metadata", () => {
    const output: string[] = []
    const image = validImageInspect()
    image.Id = "sha256:" + "b".repeat(64)
    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => JSON.stringify(filePath.includes("image") ? [image] : [validInspect()]),
      write: (text) => output.push(text),
    })).toBe(1)
    expect(output.join("")).toContain("reviewed image inspect identity")
    expect(output.join("")).not.toContain(image.Id)
  })

  it("rejects an injected effective environment using the reviewed image environment", () => {
    const container = validInspect()
    container.Config.Env = [...expectedEnvironment, "NODE_OPTIONS=--require=/state/secret.js"]
    const output: string[] = []
    expect(runContainerSpecAuditorCli([
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ], {
      readFile: (filePath) => JSON.stringify(filePath.includes("image") ? [validImageInspect()] : [container]),
      write: (text) => output.push(text),
    })).toBe(1)
    expect(output.join("")).toContain("environment must exactly match")
    expect(output.join("")).not.toContain("NODE_OPTIONS")
    expect(output.join("")).not.toContain("secret.js")
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
    const effectiveArguments = [
      "--inspect", "/audit/container.json",
      "--image-inspect", "/audit/image.json",
      "--expected-image", "sha256:" + "a".repeat(64),
    ]
    expect(runContainerSpecAuditorCli(effectiveArguments, {
      readFile: () => { throw new Error("private path") },
      write: () => undefined,
    })).toBe(2)
    expect(runContainerSpecAuditorCli(effectiveArguments, {
      readFile: () => { throw "private path" },
      write: () => undefined,
    })).toBe(2)
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
      templateXml: stagedTemplate().replace("<PostArgs></PostArgs>", "<PostArgs/>"),
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
    expect(auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace(expectedImage, "mutable"),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage: "mutable",
    })).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["expected image must be an exact local Docker image ID"]),
    }))
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

  it.each([
    ["environment variable", '<Config Target="NODE_OPTIONS" Mode="" Type="Variable">--require=/home/ouro/AgentBundles/sanctuary.ouro/state/injected.js</Config>'],
    ["unknown Config type", '<Config Target="com.example.label" Mode="" Type="Label">unsafe</Config>'],
    ["untyped Config", '<Config Target="NODE_OPTIONS" Mode="">--inspect=0.0.0.0:9229</Config>'],
  ])("rejects staged %s inputs instead of synthesizing a safe environment", (_label, config) => {
    const result = auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace("</Container>", `${config}\n</Container>`),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage: "sha256:" + "a".repeat(64),
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["template Config entries must equal the canonical four path binds"]),
    }))
  })

  it.each([
    ["post arguments", "<PostArgs>--inspect=0.0.0.0:9229</PostArgs>"],
    ["missing post arguments", ""],
    ["duplicate post arguments", "<PostArgs></PostArgs>\n<PostArgs></PostArgs>"],
  ])("rejects %s", (_label, postArgs) => {
    const result = auditSanctuaryStagedFiles({
      templateXml: stagedTemplate().replace("<PostArgs></PostArgs>", postArgs),
      runtimePolicyText: JSON.stringify({ scheduler: "supercronic", updates: "disabled" }),
      expectedImage: "sha256:" + "a".repeat(64),
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      violations: expect.arrayContaining(["template PostArgs must be present exactly once and empty"]),
    }))
  })
})
