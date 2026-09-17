import { createHash, generateKeyPairSync } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const controls = vi.hoisted(() => ({
  writeReady: true,
  writeTerminal: true,
  shortStat: false,
}))

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    readFileSync: (filePath: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
      if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-1"
      if (typeof filePath === "string" && filePath.startsWith("/proc/") && filePath.endsWith("/stat")) {
        return controls.shortStat ? "short" : `${Array.from({ length: 21 }, () => "0").join(" ")} 456`
      }
      return original.readFileSync(filePath, options as never)
    },
  }
})

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  const fs = await import("node:fs")
  return {
    ...original,
    spawn: vi.fn((_program: string, argv: string[]) => {
      const specPath = argv[2]!
      const specBytes = fs.readFileSync(specPath, "utf8")
      const spec = JSON.parse(specBytes)
      if (controls.writeReady) {
        const binding = {
          schemaVersion: 1,
          permitId: spec.permitId,
          specDigest: `sha256:${createHash("sha256").update(specBytes).digest("hex")}`,
          supervisorPid: process.pid,
          bootId: "boot-1",
          processStartTime: "456",
        }
        fs.writeFileSync(spec.lockPath, JSON.stringify({
          schemaVersion: 1,
          permitId: spec.permitId,
          supervisorPid: process.pid,
        }), { mode: 0o600 })
        fs.writeFileSync(spec.readyPath, JSON.stringify(binding), { mode: 0o600 })
        if (controls.writeTerminal) {
          fs.writeFileSync(spec.terminalPath, JSON.stringify({
            ...binding,
            attempt: {
              startedAt: "2026-09-16T20:00:00.000Z",
              completedAt: "2026-09-16T20:00:01.000Z",
              exitCode: 0,
              signal: null,
              timedOut: false,
              cancelled: false,
              outputOverflow: false,
              stdout: "",
              stderr: "",
              stdoutDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              stderrDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              stdoutBytes: 0,
              stderrBytes: 0,
              cleanup: "cgroup_empty",
              containment: "approved_root_may_escape",
              verificationBefore: null,
              verificationAfter: null,
            },
          }), { mode: 0o600 })
        }
      }
      return { pid: process.pid, unref: vi.fn() }
    }),
  }
})

import * as fs from "node:fs"
import { DetachedSanctuaryHostSupervisor } from "../../../heart/daemon/sanctuary-host-detached-supervisor"
import type { HostExecutionPermitPayloadV1 } from "../../../heart/daemon/sanctuary-host-executor"
import { signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-detached-defaults-"))
  const files = Object.fromEntries(["program", "launcher", "prlimit", "setsid", "shell"].map((name) => {
    const filePath = path.join(root, name)
    fs.writeFileSync(filePath, name, { mode: 0o755 })
    return [name, filePath]
  })) as Record<string, string>
  const options = {
    stateRoot: path.join(root, "state"),
    cgroupRoot: path.join(root, "cgroup"),
    programPath: files.program!,
    programDigest: digest("program"),
    launcherPath: files.launcher!,
    launcherDigest: digest("launcher"),
    prlimitPath: files.prlimit!,
    prlimitDigest: digest("prlimit"),
    setsidPath: files.setsid!,
    setsidDigest: digest("setsid"),
    shellPath: files.shell!,
    shellDigest: digest("shell"),
    expectedUid: process.getuid?.() ?? 0,
    keyId: "issuer-1",
    publicKeyPem: "",
    signalProcess: vi.fn(),
    sleep: vi.fn(async () => {
      const lockPath = path.join(options.stateRoot, permit.permitId, "supervisor.lock")
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
    }),
  }
  const keys = generateKeyPairSync("ed25519")
  options.publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  const permit = {
    permitId: `permit-${"a".repeat(43)}`,
    targetResource: "host",
    verification: null,
  } as HostExecutionPermitPayloadV1
  return {
    options,
    input: {
      permit,
      permitArtifact: signAuthorityPayload({
        domain: "ouro.sanctuary.host-permit.v1",
        keyId: "issuer-1",
        privateKey: keys.privateKey,
        payload: permit,
      }),
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/" as const,
      environment: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
    },
  }
}

describe("detached supervisor production defaults", () => {
  it("spawns through Node and binds current boot and process identity", async () => {
    controls.writeReady = true
    controls.writeTerminal = true
    controls.shortStat = false
    const f = fixture()
    await expect(new DetachedSanctuaryHostSupervisor(f.options).execute(f.input)).resolves.toMatchObject({ exitCode: 0 })
  })

  it("fails closed when the default process identity or readiness changes", async () => {
    const short = fixture()
    controls.writeReady = true
    controls.writeTerminal = true
    controls.shortStat = true
    await expect(new DetachedSanctuaryHostSupervisor(short.options).execute(short.input)).rejects.toThrow(/start time/u)
    controls.shortStat = false

    vi.useFakeTimers()
    try {
      const timeout = fixture()
      controls.writeReady = false
      controls.writeTerminal = false
      const pending = new DetachedSanctuaryHostSupervisor({
        ...timeout.options,
        readyTimeoutMs: 1,
        sleep: undefined,
      }).execute(timeout.input)
      const rejection = expect(pending).rejects.toThrow(/readiness/u)
      await vi.advanceTimersByTimeAsync(25)
      await rejection
    } finally {
      controls.writeReady = true
      controls.writeTerminal = true
      vi.useRealTimers()
    }

    vi.useFakeTimers()
    try {
      const timeout = fixture()
      controls.writeReady = true
      controls.writeTerminal = false
      const pending = new DetachedSanctuaryHostSupervisor({
        ...timeout.options,
        sleep: undefined,
      }).execute({
        ...timeout.input,
        timeoutMs: -19_999,
      })
      await vi.advanceTimersByTimeAsync(25)
      await expect(pending).resolves.toMatchObject({
        cleanup: "cleanup_unproven",
        containment: "unprovable_after_approved_root_migration",
      })
    } finally {
      controls.writeTerminal = true
      vi.useRealTimers()
    }

    const eperm = fixture()
    controls.writeReady = true
    controls.writeTerminal = true
    await new DetachedSanctuaryHostSupervisor(eperm.options).execute(eperm.input)
    const permitRoot = path.join(eperm.options.stateRoot, eperm.input.permit.permitId)
    fs.rmSync(path.join(permitRoot, "terminal.json"))
    const ready = JSON.parse(fs.readFileSync(path.join(permitRoot, "ready.json"), "utf8"))
    ready.supervisorPid = 999
    fs.writeFileSync(path.join(permitRoot, "ready.json"), JSON.stringify(ready), { mode: 0o600 })
    fs.writeFileSync(path.join(permitRoot, "supervisor.lock"), JSON.stringify({
      schemaVersion: 1,
      permitId: eperm.input.permit.permitId,
      supervisorPid: 999,
    }), { mode: 0o600 })
    const originalKill = process.kill
    process.kill = (() => { throw Object.assign(new Error("denied"), { code: "EPERM" }) }) as typeof process.kill
    const resumeOptions = {
      ...eperm.options,
      sleep: vi.fn(async () => {
        fs.writeFileSync(path.join(permitRoot, "terminal.json"), JSON.stringify({
          ...ready,
          attempt: {
            startedAt: "2026-09-16T20:00:00.000Z",
            completedAt: "2026-09-16T20:00:01.000Z",
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            outputOverflow: false,
            stdout: "",
            stderr: "",
            stdoutDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stderrDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stdoutBytes: 0,
            stderrBytes: 0,
            cleanup: "cgroup_empty",
            containment: "approved_root_may_escape",
            verificationBefore: null,
            verificationAfter: null,
          },
        }), { mode: 0o600 })
        fs.unlinkSync(path.join(permitRoot, "supervisor.lock"))
      }),
    }
    try {
      await expect(new DetachedSanctuaryHostSupervisor(resumeOptions).resume({
        ...eperm.input,
      })).resolves.toMatchObject({ exitCode: 0 })
    } finally {
      process.kill = originalKill
    }

    const dead = fixture()
    await new DetachedSanctuaryHostSupervisor(dead.options).execute(dead.input)
    fs.rmSync(path.join(dead.options.stateRoot, dead.input.permit.permitId, "terminal.json"))
    const deadKill = process.kill
    process.kill = (() => { throw Object.assign(new Error("missing"), { code: "ESRCH" }) }) as typeof process.kill
    try {
      await expect(new DetachedSanctuaryHostSupervisor(dead.options).resume(dead.input)).resolves.toMatchObject({
        containment: "unprovable_after_approved_root_migration",
      })
    } finally {
      process.kill = deadKill
    }
  })
})
