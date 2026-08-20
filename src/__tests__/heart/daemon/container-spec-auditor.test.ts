import { describe, expect, it } from "vitest"

import { auditSanctuaryContainerSpec } from "../../../heart/daemon/container-spec-auditor"
import { runContainerSpecAuditorCli } from "../../../heart/daemon/container-spec-auditor-main"

function validInspect() {
  return {
    Config: {
      User: "10001:10001",
      Image: "ouro-butler@sha256:" + "a".repeat(64),
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

describe("Sanctuary pre-activation container auditor", () => {
  it("accepts only the exact released effective spec", () => {
    expect(auditSanctuaryContainerSpec(validInspect(), {
      expectedImage: "ouro-butler@sha256:" + "a".repeat(64),
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
    const result = auditSanctuaryContainerSpec(spec, { expectedImage: "ouro-butler@sha256:" + "a".repeat(64) })
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it.each([null, [], {}, "not-json"])("fails closed for malformed inspect shape %#", (spec) => {
    expect(auditSanctuaryContainerSpec(spec, { expectedImage: "ouro-butler@sha256:" + "a".repeat(64) }).ok).toBe(false)
  })

  it("runs the packaged file-based auditor without echoing the inspect payload", () => {
    const output: string[] = []
    const exitCode = runContainerSpecAuditorCli([
      "--inspect", "/tmp/inspect.json",
      "--expected-image", "ouro-butler@sha256:" + "a".repeat(64),
    ], {
      readFile: () => JSON.stringify(validInspect()),
      write: (text) => output.push(text),
    })

    expect(exitCode).toBe(0)
    expect(output.join("")).toContain('"ok":true')
    expect(output.join("")).not.toContain("HOME=/home/ouro")
  })

  it("fails closed for missing arguments and unreadable JSON", () => {
    expect(runContainerSpecAuditorCli([], { readFile: () => "{}", write: () => undefined })).toBe(2)
    expect(runContainerSpecAuditorCli([
      "--inspect", "/tmp/inspect.json",
      "--expected-image", "ouro-butler@sha256:" + "a".repeat(64),
    ], { readFile: () => "not json", write: () => undefined })).toBe(2)
  })
})
