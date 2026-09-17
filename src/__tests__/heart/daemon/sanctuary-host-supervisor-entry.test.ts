import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  runSanctuaryHostSupervisor,
  runSanctuaryHostSupervisorCli,
} from "../../../heart/daemon/sanctuary-host-supervisor-entry"
import type { SanctuaryHostSupervisorKernel } from "../../../heart/daemon/sanctuary-host-supervisor"
import { signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { sanctuaryAuthorityPublicKeyDigest } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-supervisor-entry-"))
  const files = Object.fromEntries(["program", "launcher", "prlimit", "setsid", "shell"].map((name) => {
    const filePath = path.join(root, name)
    fs.writeFileSync(filePath, name, { mode: 0o755 })
    return [name, filePath]
  })) as Record<"program" | "launcher" | "prlimit" | "setsid" | "shell", string>
  const stateRoot = path.join(root, "state")
  fs.mkdirSync(stateRoot, { mode: 0o700 })
  const specPath = path.join(stateRoot, "spec.json")
  const readyPath = path.join(stateRoot, "ready.json")
  const terminalPath = path.join(stateRoot, "terminal.json")
  const lockPath = path.join(stateRoot, "supervisor.lock")
  const spawnPath = path.join(stateRoot, "spawn.json")
  const startPath = path.join(stateRoot, "start.json")
  const permitId = `permit-${"a".repeat(43)}`
  const keys = generateKeyPairSync("ed25519")
  const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
  const permitArtifact = signAuthorityPayload({
    domain: "ouro.sanctuary.host-permit.v1",
    keyId: "issuer-1",
    privateKey: keys.privateKey,
    payload: { permitId, verification: null, publicKeyDigest },
  })
  const spec = {
    schemaVersion: 1,
    permitId,
    permitArtifact,
    keyId: "issuer-1",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    executable: "/usr/bin/id",
    arguments: ["-u"],
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
    readyPath,
    terminalPath,
    lockPath,
    spawnPath,
    startPath,
  }
  const specBytes = `${JSON.stringify(spec)}\n`
  fs.writeFileSync(specPath, specBytes, { mode: 0o600 })
  fs.writeFileSync(startPath, `${JSON.stringify({ schemaVersion: 1, permitId, specDigest: digest(specBytes) })}\n`, { mode: 0o600 })
  const kernel: SanctuaryHostSupervisorKernel = {
    prepareCgroup: vi.fn(async () => path.join(root, "cgroup", permitId)),
    launch: vi.fn(async () => ({
      pid: 44,
      bootId: "boot-1",
      processStartTime: "456",
      ready: Promise.resolve(),
      completion: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "0\n",
        stderr: "",
        outputOverflow: false,
        migrationSuspected: false,
      }),
      drained: Promise.resolve({
        stdout: "0\n",
        stderr: "",
        stdoutDigest: digest("0\n"),
        stderrDigest: digest(""),
        stdoutBytes: 2,
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
  }
  return { files, kernel, keys, lockPath, readyPath, root, spec, specPath, terminalPath }
}

describe("Sanctuary host supervisor entry", () => {
  it.each(["shellPath", "prlimitPath", "setsidPath"] as const)("verifies system alias %s without changing the recorded invocation path", async (field) => {
    const f = fixture()
    const target = `${f.spec[field]}.real`
    fs.renameSync(f.spec[field], target)
    fs.symlinkSync(target, f.spec[field])
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: process.getuid?.() ?? 0, processId: 321, bootId: () => "boot-1", processStartTime: () => "456", kernel: f.kernel,
    })).resolves.toMatchObject({ exitCode: 0, cleanup: "cgroup_empty" })
    expect(JSON.parse(fs.readFileSync(f.specPath, "utf8"))[field]).toBe(f.spec[field])
  })

  it("loads root-owned supervisor JavaScript without requiring an executable bit", async () => {
    const f = fixture()
    fs.chmodSync(f.spec.supervisorProgramPath, 0o600)
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: process.getuid?.() ?? 0, processId: 321, bootId: () => "boot-1", processStartTime: () => "456", kernel: f.kernel,
    })).resolves.toMatchObject({ exitCode: 0, cleanup: "cgroup_empty" })
  })

  it("pins its private spec and programs, holds readiness identity, and writes a terminal attempt", async () => {
    const f = fixture()
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      processId: 321,
      bootId: () => "boot-1",
      processStartTime: () => "456",
      kernel: f.kernel,
    })).resolves.toMatchObject({ exitCode: 0, cleanup: "cgroup_empty" })
    expect(JSON.parse(fs.readFileSync(f.readyPath, "utf8"))).toMatchObject({
      permitId: f.spec.permitId,
      supervisorPid: 321,
      bootId: "boot-1",
      processStartTime: "456",
    })
    expect(JSON.parse(fs.readFileSync(f.terminalPath, "utf8"))).toMatchObject({
      permitId: f.spec.permitId,
      attempt: { exitCode: 0, stdout: "0\n" },
    })
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it("refuses non-owner execution, malformed specs, and changed or unsafe primitives", async () => {
    const f = fixture()
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      getuid: () => 1,
      kernel: f.kernel,
    })).rejects.toThrow(/root/u)
    await expect(runSanctuaryHostSupervisor("relative", {
      expectedUid: process.getuid?.() ?? 0,
      kernel: f.kernel,
    })).rejects.toThrow(/absolute/u)
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: (process.getuid?.() ?? 0) + 1,
      kernel: f.kernel,
    })).rejects.toThrow(/root/u)
    fs.chmodSync(f.specPath, 0o644)
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      kernel: f.kernel,
    })).rejects.toThrow(/metadata/u)
    fs.chmodSync(f.specPath, 0o600)
    fs.writeFileSync(f.files.prlimit, "changed", { mode: 0o755 })
    await expect(runSanctuaryHostSupervisor(f.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      kernel: f.kernel,
    })).rejects.toThrow(/digest/u)

    const changedPermitKey = fixture()
    changedPermitKey.spec.permitArtifact = signAuthorityPayload({
      domain: "ouro.sanctuary.host-permit.v1",
      keyId: changedPermitKey.spec.keyId,
      privateKey: changedPermitKey.keys.privateKey,
      payload: {
        ...changedPermitKey.spec.permitArtifact.payload,
        publicKeyDigest: `sha256:${"0".repeat(64)}`,
      },
    })
    fs.writeFileSync(changedPermitKey.specPath, `${JSON.stringify(changedPermitKey.spec)}\n`, { mode: 0o600 })
    await expect(runSanctuaryHostSupervisor(changedPermitKey.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      kernel: changedPermitKey.kernel,
    })).rejects.toThrow(/key digest/u)

    for (const replacement of [
      { schemaVersion: 2 },
      { permitId: `permit-${"z".repeat(43)}` },
      { arguments: "bad" },
      { cwd: "/tmp" },
      { timeoutMs: "60000" },
      { timeoutMs: 999 },
      { timeoutMs: 900_001 },
    ]) {
      const malformed = fixture()
      fs.writeFileSync(malformed.specPath, `${JSON.stringify({ ...malformed.spec, ...replacement })}\n`, { mode: 0o600 })
      await expect(runSanctuaryHostSupervisor(malformed.specPath, {
        expectedUid: process.getuid?.() ?? 0,
        kernel: malformed.kernel,
      })).rejects.toThrow(/spec is invalid/u)
    }

    const unsafe = fixture()
    fs.chmodSync(unsafe.files.launcher, 0o644)
    await expect(runSanctuaryHostSupervisor(unsafe.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      kernel: unsafe.kernel,
    })).rejects.toThrow(/metadata/u)
  })

  it("enforces the CLI spec argument", async () => {
    await expect(runSanctuaryHostSupervisorCli(["node", "entry"])).rejects.toThrow(/--spec/u)
    const run = vi.fn(async () => ({}) as never)
    await runSanctuaryHostSupervisorCli(["node", "entry", "--spec", "/root/spec.json"], run)
    expect(run).toHaveBeenCalledWith("/root/spec.json")
    const originalArgv = process.argv
    process.argv = ["node", "entry"]
    await expect(runSanctuaryHostSupervisorCli()).rejects.toThrow(/--spec/u)
    process.argv = originalArgv
  })

  it("refuses an invalid or missing private start gate before execution", async () => {
    const invalid = fixture()
    fs.writeFileSync(invalid.spec.startPath, "{}\n", { mode: 0o600 })
    await expect(runSanctuaryHostSupervisor(invalid.specPath, {
      expectedUid: process.getuid?.() ?? 0,
      processId: 321,
      bootId: () => "boot-1",
      processStartTime: () => "456",
      kernel: invalid.kernel,
    })).rejects.toThrow(/start gate is invalid/u)

    vi.useFakeTimers()
    try {
      const missing = fixture()
      fs.unlinkSync(missing.spec.startPath)
      const pending = runSanctuaryHostSupervisor(missing.specPath, {
        expectedUid: process.getuid?.() ?? 0,
        processId: 321,
        bootId: () => "boot-1",
        processStartTime: () => "456",
        kernel: missing.kernel,
      })
      const rejection = expect(pending).rejects.toThrow(/start gate timed out/u)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
