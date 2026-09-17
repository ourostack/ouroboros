import { createHash, generateKeyPairSync } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const kernel = vi.hoisted(() => ({
  prepareCgroup: vi.fn(async () => "/cgroup/permit"),
  launch: vi.fn(async () => ({
    pid: 44,
    bootId: "boot-default",
    processStartTime: "789",
    ready: Promise.resolve(),
    completion: Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      outputOverflow: false,
      migrationSuspected: false,
    }),
    drained: Promise.resolve({
      stdout: "",
      stderr: "",
      stdoutDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      stderrDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      stdoutBytes: 0,
      stderrBytes: 0,
    }),
    signalGroup: vi.fn(),
  })),
  waitForCgroupEmpty: vi.fn(async () => true),
  killCgroup: vi.fn(async () => undefined),
  removeCgroup: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
  now: vi.fn()
    .mockReturnValueOnce("2026-09-16T20:00:00.000Z")
    .mockReturnValue("2026-09-16T20:00:01.000Z"),
  verify: vi.fn(async () => null),
}))

vi.mock("../../../heart/daemon/sanctuary-host-linux-kernel", () => ({
  LinuxSanctuaryHostSupervisorKernel: class {
    constructor() {
      return kernel
    }
  },
}))

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    readFileSync: (filePath: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
      if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-default"
      if (filePath === `/proc/${process.pid}/stat`) return "short"
      return original.readFileSync(filePath, options as never)
    },
  }
})

import * as fs from "node:fs"
import { runSanctuaryHostSupervisor } from "../../../heart/daemon/sanctuary-host-supervisor-entry"
import { signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { sanctuaryAuthorityPublicKeyDigest } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`

describe("Sanctuary host supervisor entry production defaults", () => {
  it("uses default process identity and Linux kernel construction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-supervisor-defaults-"))
    const files = Object.fromEntries(["program", "launcher", "prlimit", "setsid", "shell"].map((name) => {
      const filePath = path.join(root, name)
      fs.writeFileSync(filePath, name, { mode: 0o755 })
      return [name, filePath]
    })) as Record<string, string>
    const stateRoot = path.join(root, "state")
    fs.mkdirSync(stateRoot, { mode: 0o700 })
    const permitId = `permit-${"a".repeat(43)}`
    const keys = generateKeyPairSync("ed25519")
    const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
    const specPath = path.join(stateRoot, "spec.json")
    const startPath = path.join(stateRoot, "start.json")
    const specBytes = `${JSON.stringify({
      schemaVersion: 1,
      permitId,
      permitArtifact: signAuthorityPayload({
        domain: "ouro.sanctuary.host-permit.v1",
        keyId: "issuer-1",
        privateKey: keys.privateKey,
        payload: { permitId, verification: null, publicKeyDigest },
      }),
      keyId: "issuer-1",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/",
      environment: { PATH: "/usr/bin" },
      timeoutMs: 60_000,
      cgroupRoot: path.join(root, "cgroup"),
      launcherPath: files.launcher,
      launcherDigest: digest("launcher"),
      prlimitPath: files.prlimit,
      prlimitDigest: digest("prlimit"),
      setsidPath: files.setsid,
      setsidDigest: digest("setsid"),
      shellPath: files.shell,
      shellDigest: digest("shell"),
      supervisorProgramPath: files.program,
      supervisorProgramDigest: digest("program"),
      readyPath: path.join(stateRoot, "ready.json"),
      terminalPath: path.join(stateRoot, "terminal.json"),
      lockPath: path.join(stateRoot, "supervisor.lock"),
      spawnPath: path.join(stateRoot, "spawn.json"),
      startPath,
    })}\n`
    fs.writeFileSync(specPath, specBytes, { mode: 0o600 })
    fs.writeFileSync(startPath, `${JSON.stringify({ schemaVersion: 1, permitId, specDigest: digest(specBytes) })}\n`, { mode: 0o600 })
    await expect(runSanctuaryHostSupervisor(specPath, {
      expectedUid: process.getuid?.() ?? 0,
    })).resolves.toMatchObject({ exitCode: 0 })
  })
})
