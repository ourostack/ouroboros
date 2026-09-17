import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { DetachedSanctuaryHostSupervisor } from "../../../heart/daemon/sanctuary-host-detached-supervisor"
import type { HostExecutionPermitPayloadV1, HostSupervisorAttempt } from "../../../heart/daemon/sanctuary-host-executor"
import { signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const permit = {
  permitId: `permit-${"a".repeat(43)}`,
  targetResource: "host",
  verification: null,
} as HostExecutionPermitPayloadV1
const keys = generateKeyPairSync("ed25519")
const permitArtifact = signAuthorityPayload({
  domain: "ouro.sanctuary.host-permit.v1",
  keyId: "issuer-1",
  privateKey: keys.privateKey,
  payload: permit,
})
const attempt: HostSupervisorAttempt = {
  startedAt: "2026-09-16T20:00:00.000Z",
  completedAt: "2026-09-16T20:00:01.000Z",
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  outputOverflow: false,
  stdout: "ok\n",
  stderr: "",
  stdoutDigest: digest("ok\n"),
  stderrDigest: digest(""),
  stdoutBytes: 3,
  stderrBytes: 0,
  cleanup: "cgroup_empty",
  containment: "approved_root_may_escape",
  verificationBefore: null,
  verificationAfter: null,
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-detached-supervisor-"))
  const programPath = path.join(root, "supervisor.js")
  const launcherPath = path.join(root, "launcher.sh")
  const prlimitPath = path.join(root, "prlimit")
  const setsidPath = path.join(root, "setsid")
  const shellPath = path.join(root, "shell")
  const cgroupRoot = path.join(root, "cgroup")
  fs.mkdirSync(cgroupRoot)
  for (const [filePath, bytes] of [
    [programPath, "program"],
    [launcherPath, "launcher"],
    [prlimitPath, "prlimit"],
    [setsidPath, "setsid"],
    [shellPath, "shell"],
  ]) fs.writeFileSync(filePath, bytes, { mode: 0o755 })
  const spawn = vi.fn((input: { specPath: string; readyPath: string; terminalPath: string }) => {
    fs.writeFileSync(input.readyPath, JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
      specDigest: digest(fs.readFileSync(input.specPath, "utf8")),
      supervisorPid: 321,
      bootId: "boot-1",
      processStartTime: "456",
    }), { mode: 0o600 })
    fs.writeFileSync(path.join(path.dirname(input.readyPath), "supervisor.lock"), JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
      supervisorPid: 321,
    }), { mode: 0o600 })
    fs.writeFileSync(input.terminalPath, JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
      specDigest: digest(fs.readFileSync(input.specPath, "utf8")),
      supervisorPid: 321,
      bootId: "boot-1",
      processStartTime: "456",
      attempt,
    }), { mode: 0o600 })
    return { pid: 321, unref: vi.fn() }
  })
  const stateRoot = path.join(root, "state")
  const sleep = vi.fn(async () => {
    const permitRoot = path.join(stateRoot, permit.permitId)
    const terminalPath = path.join(permitRoot, "terminal.json")
    const lockPath = path.join(permitRoot, "supervisor.lock")
    if (fs.existsSync(terminalPath) && fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
  })
  const options = {
    stateRoot,
    cgroupRoot,
    programPath,
    programDigest: digest("program"),
    launcherPath,
    launcherDigest: digest("launcher"),
    prlimitPath,
    prlimitDigest: digest("prlimit"),
    setsidPath,
    setsidDigest: digest("setsid"),
    shellPath,
    shellDigest: digest("shell"),
    expectedUid: process.getuid?.() ?? 0,
    keyId: "issuer-1",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    bootId: () => "boot-1",
    processStartTime: () => "456",
    processAlive: () => true,
    signalProcess: vi.fn(),
    spawn,
    sleep,
    readyTimeoutMs: 1_000,
    now: () => "2026-09-16T20:00:02.000Z",
  }
  return { root, options, spawn }
}

const input = {
  permit,
  permitArtifact,
  executable: "/usr/bin/id",
  arguments: ["-u"],
  cwd: "/" as const,
  environment: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  timeoutMs: 60_000,
}

describe("detached Sanctuary host supervisor", () => {
  it("accepts non-executable supervisor source but still requires executable host primitives", () => {
    const f = fixture()
    fs.chmodSync(f.options.programPath, 0o600)
    const supervisor = new DetachedSanctuaryHostSupervisor(f.options)
    expect(() => supervisor.verifyInstallation()).not.toThrow()
    fs.chmodSync(f.options.launcherPath, 0o600)
    expect(() => supervisor.verifyInstallation()).toThrow(/metadata/u)
  })

  it("refuses startup when an orphan cgroup cannot be emptied", async () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.options.cgroupRoot, permit.permitId))
    const supervisor = new DetachedSanctuaryHostSupervisor({
      ...f.options, killCgroup: vi.fn(), cgroupEmpty: () => false,
    })
    await expect(supervisor.reconcileOrphans([])).rejects.toThrow(/cleanup/u)
  })

  it("recovers a reservation without a cgroup even after host primitives change, without spawning", async () => {
    const f = fixture()
    fs.writeFileSync(f.options.prlimitPath, "updated by the OS")
    await expect(new DetachedSanctuaryHostSupervisor(f.options).resume(input)).resolves.toMatchObject({
      exitCode: null, cleanup: "cgroup_empty", containment: "unprovable_after_approved_root_migration",
    })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it("pins package and host primitives, writes a private spec, and adopts the bound terminal record", async () => {
    const f = fixture()
    const supervisor = new DetachedSanctuaryHostSupervisor(f.options)
    await expect(supervisor.execute(input)).resolves.toEqual(attempt)
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({
      programPath: f.options.programPath,
      specPath: expect.stringContaining(permit.permitId),
      detached: true,
    }))
    const specPath = f.spawn.mock.calls[0]![0].specPath
    expect(fs.statSync(specPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(specPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      permitId: permit.permitId,
      launcherPath: f.options.launcherPath,
      prlimitPath: f.options.prlimitPath,
      setsidPath: f.options.setsidPath,
      executable: "/usr/bin/id",
    })
    expect(f.spawn.mock.results[0]!.value.unref).toHaveBeenCalledOnce()

    await expect(new DetachedSanctuaryHostSupervisor(f.options).resume(input)).resolves.toEqual(attempt)
    expect(f.spawn).toHaveBeenCalledOnce()

    const missing = fixture()
    await expect(new DetachedSanctuaryHostSupervisor(missing.options).resume(input)).resolves.toMatchObject({
      exitCode: null,
      cleanup: "cgroup_empty",
      containment: "unprovable_after_approved_root_migration",
    })
    expect(missing.spawn).not.toHaveBeenCalled()

    const orphan = fixture()
    const orphanPermitId = `permit-${"z".repeat(43)}`
    const orphanCgroup = path.join(orphan.options.cgroupRoot, orphanPermitId)
    fs.mkdirSync(orphanCgroup)
    const killCgroup = vi.fn()
    const removeCgroup = vi.fn((cgroupPath: string) => fs.rmdirSync(cgroupPath))
    const reconciler = new DetachedSanctuaryHostSupervisor({
      ...orphan.options,
      killCgroup,
      cgroupEmpty: () => true,
      removeCgroup,
    })
    await reconciler.reconcileOrphans([])
    expect(killCgroup).toHaveBeenCalledWith(orphanCgroup)
    expect(removeCgroup).toHaveBeenCalledWith(orphanCgroup)

    const unmatched = fixture()
    await new DetachedSanctuaryHostSupervisor(unmatched.options).execute(input)
    await expect(new DetachedSanctuaryHostSupervisor(unmatched.options).reconcileOrphans([])).rejects.toThrow(/unmatched/u)
    await expect(new DetachedSanctuaryHostSupervisor(unmatched.options).reconcileOrphans([permit.permitId])).resolves.toBeUndefined()

    const invalidCgroup = fixture()
    fs.writeFileSync(path.join(invalidCgroup.options.cgroupRoot, "control"), "")
    fs.mkdirSync(path.join(invalidCgroup.options.cgroupRoot, "invalid"))
    await expect(new DetachedSanctuaryHostSupervisor(invalidCgroup.options).reconcileOrphans([])).rejects.toThrow(/cgroup entry/u)

    const knownCgroup = fixture()
    fs.mkdirSync(path.join(knownCgroup.options.cgroupRoot, permit.permitId))
    await expect(new DetachedSanctuaryHostSupervisor(knownCgroup.options).reconcileOrphans([permit.permitId])).resolves.toBeUndefined()

    const unavailableStateRoot = fixture()
    fs.writeFileSync(unavailableStateRoot.options.stateRoot, "not-a-directory")
    await expect(new DetachedSanctuaryHostSupervisor(unavailableStateRoot.options).reconcileOrphans([])).rejects.toThrow()

    const unreconciled = fixture()
    const unreconciledPath = path.join(unreconciled.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(unreconciledPath)
    fs.writeFileSync(path.join(unreconciledPath, "cgroup.events"), "populated 1\n")
    const recovered = await new DetachedSanctuaryHostSupervisor({
      ...unreconciled.options,
      now: undefined,
    }).resume(input)
    expect(recovered).toMatchObject({ cleanup: "cleanup_unproven" })
    expect(fs.readFileSync(path.join(unreconciledPath, "cgroup.kill"), "utf8")).toBe("1")

    const unavailableEvents = fixture()
    const unavailableEventsPath = path.join(unavailableEvents.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(unavailableEventsPath)
    fs.writeFileSync(path.join(unavailableEventsPath, "cgroup.events"), "frozen 0\n")
    await expect(new DetachedSanctuaryHostSupervisor(unavailableEvents.options).resume(input)).rejects.toThrow(/populated/u)

    vi.useFakeTimers()
    try {
      const defaultSleep = fixture()
      const defaultSleepPath = path.join(defaultSleep.options.cgroupRoot, permit.permitId)
      fs.mkdirSync(defaultSleepPath)
      let empty = false
      const pending = new DetachedSanctuaryHostSupervisor({
        ...defaultSleep.options,
        sleep: undefined,
        killCgroup: vi.fn(),
        cgroupEmpty: () => empty,
        removeCgroup: (cgroupPath) => fs.rmdirSync(cgroupPath),
      }).resume(input)
      empty = true
      await vi.advanceTimersByTimeAsync(25)
      await expect(pending).resolves.toMatchObject({ cleanup: "cgroup_empty" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses changed primitive bytes, unsafe metadata, and replaced live bindings", async () => {
    const changed = fixture()
    fs.writeFileSync(changed.options.prlimitPath, "changed")
    await expect(new DetachedSanctuaryHostSupervisor(changed.options).execute(input)).rejects.toThrow(/digest/u)
    expect(changed.spawn).not.toHaveBeenCalled()

    const unsafe = fixture()
    fs.chmodSync(unsafe.options.launcherPath, 0o777)
    await expect(new DetachedSanctuaryHostSupervisor(unsafe.options).execute(input)).rejects.toThrow(/metadata/u)
    expect(unsafe.spawn).not.toHaveBeenCalled()

    const replaced = fixture()
    const first = new DetachedSanctuaryHostSupervisor(replaced.options)
    await first.execute(input)
    fs.rmSync(path.join(replaced.options.stateRoot, permit.permitId, "terminal.json"))
    replaced.options.processStartTime = () => "different"
    await expect(new DetachedSanctuaryHostSupervisor(replaced.options).execute(input)).resolves.toMatchObject({
      exitCode: null,
      containment: "unprovable_after_approved_root_migration",
    })
    expect(replaced.spawn).toHaveBeenCalledOnce()

    const cleaned = fixture()
    const cleanedPath = path.join(cleaned.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(cleanedPath)
    const cleanedAttempt = await new DetachedSanctuaryHostSupervisor({
      ...cleaned.options,
      killCgroup: vi.fn(),
      cgroupEmpty: () => true,
      removeCgroup: (cgroupPath) => fs.rmdirSync(cgroupPath),
    }).resume(input)
    expect(cleanedAttempt).toMatchObject({ cleanup: "cgroup_empty" })

    const defaultRemoval = fixture()
    const defaultRemovalPath = path.join(defaultRemoval.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(defaultRemovalPath)
    await expect(new DetachedSanctuaryHostSupervisor({
      ...defaultRemoval.options,
      killCgroup: vi.fn(),
      cgroupEmpty: () => true,
    }).resume(input)).resolves.toMatchObject({ cleanup: "cgroup_empty" })
    expect(fs.existsSync(defaultRemovalPath)).toBe(false)
  })

  it("refuses every path, pin, metadata, spawn, and private-record ambiguity", async () => {
    const base = fixture()
    for (const field of ["stateRoot", "cgroupRoot", "programPath", "launcherPath", "prlimitPath", "setsidPath", "shellPath"] as const) {
      expect(() => new DetachedSanctuaryHostSupervisor({ ...base.options, [field]: "relative" })).toThrow(/absolute/u)
    }
    await expect(new DetachedSanctuaryHostSupervisor({ ...base.options, programDigest: "bad" }).execute(input)).rejects.toThrow(/digest/u)

    for (const mutate of [
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.options.launcherPath, 0o644),
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.options.programPath, 0o777),
      (f: ReturnType<typeof fixture>) => { fs.rmSync(f.options.programPath); fs.mkdirSync(f.options.programPath) },
      (f: ReturnType<typeof fixture>) => {
        fs.rmSync(f.options.programPath)
        fs.symlinkSync(f.options.launcherPath, f.options.programPath)
      },
    ]) {
      const f = fixture()
      mutate(f)
      await expect(new DetachedSanctuaryHostSupervisor(f.options).execute(input)).rejects.toThrow(/metadata/u)
    }
    const wrongOwner = fixture()
    await expect(new DetachedSanctuaryHostSupervisor({
      ...wrongOwner.options,
      expectedUid: wrongOwner.options.expectedUid + 1,
    }).execute(input)).rejects.toThrow(/metadata/u)

    const noPid = fixture()
    noPid.options.spawn = vi.fn(() => ({ unref: vi.fn() }))
    await expect(new DetachedSanctuaryHostSupervisor(noPid.options).execute(input)).rejects.toThrow(/failed to start/u)
    await expect(new DetachedSanctuaryHostSupervisor(base.options).execute({
      ...input,
      permit: { ...permit, permitId: "bad" },
    })).rejects.toThrow(/permit id/u)

    const wrongPid = fixture()
    wrongPid.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      return { ...child, pid: 999 }
    })
    await expect(new DetachedSanctuaryHostSupervisor(wrongPid.options).execute(input)).rejects.toThrow(/binding changed/u)

    const noReady = fixture()
    noReady.options.spawn = vi.fn(() => ({ pid: 321, unref: vi.fn() }))
    noReady.options.readyTimeoutMs = 1
    await expect(new DetachedSanctuaryHostSupervisor(noReady.options).execute(input)).rejects.toThrow(/readiness/u)

    const readyAtDeadline = fixture()
    readyAtDeadline.options.spawn = vi.fn(() => ({ pid: 321, unref: vi.fn() }))
    readyAtDeadline.options.readyTimeoutMs = 1
    readyAtDeadline.options.sleep = vi.fn(async () => {
      const permitRoot = path.join(readyAtDeadline.options.stateRoot, permit.permitId)
      const terminalPath = path.join(permitRoot, "terminal.json")
      const lockPath = path.join(permitRoot, "supervisor.lock")
      if (fs.existsSync(terminalPath) && fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath)
        return
      }
      const specBytes = fs.readFileSync(path.join(permitRoot, "spec.json"), "utf8")
      const binding = {
        schemaVersion: 1,
        permitId: permit.permitId,
        specDigest: digest(specBytes),
        supervisorPid: 321,
        bootId: "boot-1",
        processStartTime: "456",
      }
      fs.writeFileSync(path.join(permitRoot, "supervisor.lock"), JSON.stringify({
        schemaVersion: 1,
        permitId: permit.permitId,
        supervisorPid: 321,
      }), { mode: 0o600 })
      fs.writeFileSync(path.join(permitRoot, "ready.json"), JSON.stringify(binding), { mode: 0o600 })
      fs.writeFileSync(path.join(permitRoot, "terminal.json"), JSON.stringify({ ...binding, attempt }), { mode: 0o600 })
    })
    await expect(new DetachedSanctuaryHostSupervisor(readyAtDeadline.options).execute(input)).resolves.toEqual(attempt)

    const noTerminal = fixture()
    noTerminal.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.rmSync(value.terminalPath)
      return child
    })
    await expect(new DetachedSanctuaryHostSupervisor(noTerminal.options).execute({
      ...input,
      timeoutMs: -19_999,
    })).resolves.toMatchObject({
      exitCode: null,
      cleanup: "cleanup_unproven",
      containment: "unprovable_after_approved_root_migration",
    })

    const invalidTerminal = fixture()
    await new DetachedSanctuaryHostSupervisor(invalidTerminal.options).execute(input)
    const terminalPath = path.join(invalidTerminal.options.stateRoot, permit.permitId, "terminal.json")
    fs.writeFileSync(terminalPath, JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
      specDigest: JSON.parse(fs.readFileSync(terminalPath, "utf8")).specDigest,
      supervisorPid: 321,
      bootId: "boot-1",
      processStartTime: "456",
    }), { mode: 0o600 })
    await expect(new DetachedSanctuaryHostSupervisor(invalidTerminal.options).resume(input)).rejects.toThrow(/terminal record/u)

    const unsafeReady = fixture()
    unsafeReady.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.chmodSync(value.readyPath, 0o644)
      return child
    })
    await expect(new DetachedSanctuaryHostSupervisor(unsafeReady.options).execute(input)).rejects.toThrow(/metadata/u)

    const malformedReady = fixture()
    malformedReady.options.spawn = vi.fn((value) => {
      fs.writeFileSync(value.readyPath, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 })
      return { pid: 321, unref: vi.fn() }
    })
    await expect(new DetachedSanctuaryHostSupervisor(malformedReady.options).execute(input)).rejects.toThrow(/binding/u)

    const changedSpec = fixture()
    await new DetachedSanctuaryHostSupervisor(changedSpec.options).execute(input)
    await expect(new DetachedSanctuaryHostSupervisor(changedSpec.options).resume({
      ...input,
      arguments: ["changed"],
    })).rejects.toThrow(/specification changed/u)
  })

  it("binds the active slot and exercises production process liveness defaults", async () => {
    let release!: () => void
    const active = fixture()
    active.options.spawn = vi.fn((value) => {
      fs.writeFileSync(value.readyPath, JSON.stringify({
        schemaVersion: 1,
        permitId: permit.permitId,
        specDigest: digest(fs.readFileSync(value.specPath, "utf8")),
        supervisorPid: 321,
        bootId: "boot-1",
        processStartTime: "456",
      }), { mode: 0o600 })
      fs.writeFileSync(path.join(path.dirname(value.readyPath), "supervisor.lock"), JSON.stringify({
        schemaVersion: 1,
        permitId: permit.permitId,
        supervisorPid: 321,
      }), { mode: 0o600 })
      return { pid: 321, unref: vi.fn() }
    })
    active.options.sleep = vi.fn(() => new Promise<void>((resolve) => {
      release = () => {
        const lockPath = path.join(active.options.stateRoot, permit.permitId, "supervisor.lock")
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
        resolve()
      }
    }))
    const first = new DetachedSanctuaryHostSupervisor(active.options)
    const running = first.execute({ ...input, timeoutMs: -19_999 })
    await expect(first.execute(input)).rejects.toThrow(/active/u)
    fs.writeFileSync(path.join(active.options.stateRoot, permit.permitId, "terminal.json"), JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
      specDigest: digest(fs.readFileSync(path.join(active.options.stateRoot, permit.permitId, "spec.json"), "utf8")),
      supervisorPid: 321,
      bootId: "boot-1",
      processStartTime: "456",
      attempt,
    }), { mode: 0o600 })
    release()
    await expect(running).resolves.toEqual(attempt)

  })

  it("acknowledges only safely terminal supervisor state and resumes interrupted cleanup", async () => {
    const f = fixture()
    const supervisor = new DetachedSanctuaryHostSupervisor(f.options)
    await supervisor.execute(input)
    const permitRoot = path.join(f.options.stateRoot, permit.permitId)
    for (const name of ["spec.json", "spawn.json", "start.json", "ready.json", "terminal.json"]) {
      expect(fs.existsSync(path.join(permitRoot, name))).toBe(true)
    }

    fs.unlinkSync(path.join(permitRoot, "start.json"))
    fs.unlinkSync(path.join(permitRoot, "ready.json"))
    expect(() => supervisor.acknowledge(permit.permitId)).not.toThrow()
    expect(fs.existsSync(permitRoot)).toBe(false)
    expect(() => supervisor.acknowledge(permit.permitId)).not.toThrow()

    const live = fixture()
    const liveSupervisor = new DetachedSanctuaryHostSupervisor(live.options)
    await liveSupervisor.execute(input)
    const liveRoot = path.join(live.options.stateRoot, permit.permitId)
    fs.writeFileSync(path.join(liveRoot, "supervisor.lock"), "live", { mode: 0o600 })
    expect(() => liveSupervisor.acknowledge(permit.permitId)).toThrow(/safely terminal/u)
    fs.unlinkSync(path.join(liveRoot, "supervisor.lock"))
    fs.mkdirSync(path.join(live.options.cgroupRoot, permit.permitId))
    expect(() => liveSupervisor.acknowledge(permit.permitId)).toThrow(/safely terminal/u)

    expect(() => liveSupervisor.acknowledge("invalid")).toThrow(/permit id/u)
    const missing = fixture()
    fs.mkdirSync(path.join(missing.options.cgroupRoot, permit.permitId))
    expect(() => new DetachedSanctuaryHostSupervisor(missing.options).acknowledge(permit.permitId)).toThrow(/cgroup is still present/u)

    const acknowledged = fixture()
    const acknowledgedSupervisor = new DetachedSanctuaryHostSupervisor(acknowledged.options)
    await acknowledgedSupervisor.execute(input)
    const acknowledgedRoot = path.join(acknowledged.options.stateRoot, permit.permitId)
    fs.writeFileSync(path.join(acknowledgedRoot, "acknowledgement.json"), JSON.stringify({
      schemaVersion: 1,
      permitId: permit.permitId,
    }), { mode: 0o600 })
    expect(() => acknowledgedSupervisor.acknowledge(permit.permitId)).not.toThrow()

    const changedAcknowledgement = fixture()
    const changedSupervisor = new DetachedSanctuaryHostSupervisor(changedAcknowledgement.options)
    await changedSupervisor.execute(input)
    fs.writeFileSync(path.join(changedAcknowledgement.options.stateRoot, permit.permitId, "acknowledgement.json"), "{}", { mode: 0o600 })
    expect(() => changedSupervisor.acknowledge(permit.permitId)).toThrow(/acknowledgement changed/u)

    const empty = fixture()
    const emptyRoot = path.join(empty.options.stateRoot, permit.permitId)
    fs.mkdirSync(emptyRoot, { recursive: true, mode: 0o700 })
    expect(() => new DetachedSanctuaryHostSupervisor(empty.options).acknowledge(permit.permitId)).not.toThrow()
  })

  it("adopts a durably bound pre-readiness spawn and fails closed on supervisor signal errors", async () => {
    const adopted = fixture()
    adopted.options.spawn = vi.fn(() => ({ pid: 321, unref: vi.fn() }))
    adopted.options.readyTimeoutMs = 1
    adopted.options.sleep = vi.fn(async () => undefined)
    const supervisor = new DetachedSanctuaryHostSupervisor(adopted.options)
    await expect(supervisor.execute(input)).rejects.toThrow(/readiness/u)
    const permitRoot = path.join(adopted.options.stateRoot, permit.permitId)
    fs.unlinkSync(path.join(permitRoot, "start.json"))
    adopted.options.sleep = vi.fn(async () => {
      const binding = JSON.parse(fs.readFileSync(path.join(permitRoot, "spawn.json"), "utf8"))
      const readyPath = path.join(permitRoot, "ready.json")
      const terminalPath = path.join(permitRoot, "terminal.json")
      const lockPath = path.join(permitRoot, "supervisor.lock")
      if (!fs.existsSync(readyPath)) {
        fs.writeFileSync(readyPath, JSON.stringify(binding), { mode: 0o600 })
        fs.writeFileSync(lockPath, JSON.stringify({
          schemaVersion: 1,
          permitId: permit.permitId,
          supervisorPid: 321,
        }), { mode: 0o600 })
        fs.writeFileSync(terminalPath, JSON.stringify({ ...binding, attempt }), { mode: 0o600 })
      } else if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath)
      }
    })
    await expect(new DetachedSanctuaryHostSupervisor(adopted.options).resume(input)).resolves.toEqual(attempt)
    expect(adopted.options.spawn).toHaveBeenCalledOnce()

    const alreadyStarted = fixture()
    alreadyStarted.options.spawn = vi.fn(() => ({ pid: 321, unref: vi.fn() }))
    alreadyStarted.options.readyTimeoutMs = 1
    alreadyStarted.options.sleep = vi.fn(async () => undefined)
    await expect(new DetachedSanctuaryHostSupervisor(alreadyStarted.options).execute(input)).rejects.toThrow(/readiness/u)
    const startedRoot = path.join(alreadyStarted.options.stateRoot, permit.permitId)
    alreadyStarted.options.sleep = vi.fn(async () => {
      const binding = JSON.parse(fs.readFileSync(path.join(startedRoot, "spawn.json"), "utf8"))
      const readyPath = path.join(startedRoot, "ready.json")
      const lockPath = path.join(startedRoot, "supervisor.lock")
      if (!fs.existsSync(readyPath)) {
        fs.writeFileSync(readyPath, JSON.stringify(binding), { mode: 0o600 })
        fs.writeFileSync(lockPath, JSON.stringify({
          schemaVersion: 1,
          permitId: permit.permitId,
          supervisorPid: 321,
        }), { mode: 0o600 })
        fs.writeFileSync(path.join(startedRoot, "terminal.json"), JSON.stringify({ ...binding, attempt }), { mode: 0o600 })
      } else if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath)
      }
    })
    await expect(new DetachedSanctuaryHostSupervisor(alreadyStarted.options).resume(input)).resolves.toEqual(attempt)

    const unbound = fixture()
    await new DetachedSanctuaryHostSupervisor(unbound.options).execute(input)
    const unboundRoot = path.join(unbound.options.stateRoot, permit.permitId)
    for (const name of ["terminal.json", "ready.json", "spawn.json", "start.json"]) fs.unlinkSync(path.join(unboundRoot, name))
    await expect(new DetachedSanctuaryHostSupervisor(unbound.options).resume(input)).resolves.toMatchObject({
      cleanup: "cgroup_empty",
      containment: "unprovable_after_approved_root_migration",
    })
    fs.writeFileSync(path.join(unboundRoot, "supervisor.lock"), "unidentified supervisor", { mode: 0o600 })
    await expect(new DetachedSanctuaryHostSupervisor(unbound.options).resume(input)).resolves.toMatchObject({ cleanup: "cleanup_unproven" })

    const changedLock = fixture()
    changedLock.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.writeFileSync(path.join(path.dirname(value.readyPath), "supervisor.lock"), "{}", { mode: 0o600 })
      return child
    })
    await expect(new DetachedSanctuaryHostSupervisor(changedLock.options).execute(input)).rejects.toThrow(/live binding changed/u)

    const signalFailure = fixture()
    signalFailure.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.rmSync(value.terminalPath)
      return child
    })
    signalFailure.options.signalProcess = vi.fn(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }) })
    await expect(new DetachedSanctuaryHostSupervisor(signalFailure.options).execute({
      ...input,
      timeoutMs: -19_999,
    })).rejects.toThrow("denied")

    const vanished = fixture()
    vanished.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.rmSync(value.terminalPath)
      return child
    })
    vanished.options.signalProcess = undefined
    const originalDefaultKill = process.kill
    process.kill = vi.fn(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) }) as typeof process.kill
    try {
      await expect(new DetachedSanctuaryHostSupervisor(vanished.options).execute({
        ...input,
        timeoutMs: -19_999,
      })).resolves.toMatchObject({ cleanup: "cleanup_unproven" })
    } finally {
      process.kill = originalDefaultKill
    }

    const recovered = fixture()
    const recoveredCgroup = path.join(recovered.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(recoveredCgroup)
    recovered.options.spawn = vi.fn((value) => {
      const child = fixture().options.spawn!(value)
      fs.rmSync(value.terminalPath)
      return child
    })
    recovered.options.cgroupEmpty = () => true
    recovered.options.killCgroup = vi.fn()
    recovered.options.removeCgroup = vi.fn(() => fs.rmdirSync(recoveredCgroup))
    recovered.options.processAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const recoveredSupervisor = new DetachedSanctuaryHostSupervisor(recovered.options)
    await expect(recoveredSupervisor.execute({ ...input, timeoutMs: -19_999 })).resolves.toMatchObject({
      cleanup: "cgroup_empty",
    })
    expect(() => recoveredSupervisor.acknowledge(permit.permitId)).not.toThrow()

    const badRecovery = fixture()
    const badCgroup = path.join(badRecovery.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(badCgroup)
    badRecovery.options.spawn = recovered.options.spawn
    badRecovery.options.cgroupEmpty = () => true
    badRecovery.options.killCgroup = vi.fn()
    badRecovery.options.removeCgroup = vi.fn(() => fs.rmdirSync(badCgroup))
    badRecovery.options.processAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const badSupervisor = new DetachedSanctuaryHostSupervisor(badRecovery.options)
    await badSupervisor.execute({ ...input, timeoutMs: -19_999 })
    fs.writeFileSync(path.join(badRecovery.options.stateRoot, permit.permitId, "recovery.json"), "{}", { mode: 0o600 })
    expect(() => badSupervisor.acknowledge(permit.permitId)).toThrow(/recovery acknowledgement changed/u)

    const persistent = fixture()
    const persistentCgroup = path.join(persistent.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(persistentCgroup)
    persistent.options.spawn = recovered.options.spawn
    persistent.options.cgroupEmpty = () => true
    persistent.options.killCgroup = vi.fn()
    persistent.options.removeCgroup = vi.fn(() => fs.rmdirSync(persistentCgroup))
    persistent.options.processAlive = () => true
    await expect(new DetachedSanctuaryHostSupervisor(persistent.options).execute({
      ...input,
      timeoutMs: -19_999,
    })).resolves.toMatchObject({ cleanup: "cleanup_unproven" })

    const changedLockRecovery = fixture()
    const changedLockCgroup = path.join(changedLockRecovery.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(changedLockCgroup)
    changedLockRecovery.options.spawn = recovered.options.spawn
    changedLockRecovery.options.cgroupEmpty = () => true
    changedLockRecovery.options.killCgroup = vi.fn()
    changedLockRecovery.options.removeCgroup = vi.fn(() => fs.rmdirSync(changedLockCgroup))
    let changedLockAlive = true
    changedLockRecovery.options.processAlive = vi.fn(() => changedLockAlive)
    changedLockRecovery.options.signalProcess = vi.fn(() => {
      changedLockAlive = false
      fs.writeFileSync(
        path.join(changedLockRecovery.options.stateRoot, permit.permitId, "supervisor.lock"),
        "{}",
        { mode: 0o600 },
      )
    })
    await expect(new DetachedSanctuaryHostSupervisor(changedLockRecovery.options).execute({
      ...input,
      timeoutMs: -19_999,
    })).rejects.toThrow(/recovery lock changed/u)

    const noLockRecovery = fixture()
    const noLockCgroup = path.join(noLockRecovery.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(noLockCgroup)
    noLockRecovery.options.spawn = recovered.options.spawn
    noLockRecovery.options.cgroupEmpty = () => true
    noLockRecovery.options.killCgroup = vi.fn()
    noLockRecovery.options.removeCgroup = vi.fn(() => fs.rmdirSync(noLockCgroup))
    let noLockAlive = true
    noLockRecovery.options.processAlive = vi.fn(() => noLockAlive)
    noLockRecovery.options.signalProcess = vi.fn(() => {
      noLockAlive = false
      fs.unlinkSync(path.join(noLockRecovery.options.stateRoot, permit.permitId, "supervisor.lock"))
    })
    await expect(new DetachedSanctuaryHostSupervisor(noLockRecovery.options).execute({
      ...input,
      timeoutMs: -19_999,
    })).resolves.toMatchObject({ cleanup: "cgroup_empty" })

    const defaultLiveness = fixture()
    const defaultLivenessCgroup = path.join(defaultLiveness.options.cgroupRoot, permit.permitId)
    fs.mkdirSync(defaultLivenessCgroup)
    defaultLiveness.options.spawn = recovered.options.spawn
    defaultLiveness.options.cgroupEmpty = () => true
    defaultLiveness.options.killCgroup = vi.fn()
    defaultLiveness.options.removeCgroup = vi.fn(() => fs.rmdirSync(defaultLivenessCgroup))
    defaultLiveness.options.processAlive = undefined
    let defaultAlive = true
    defaultLiveness.options.signalProcess = vi.fn(() => { defaultAlive = false })
    const originalKill = process.kill
    process.kill = vi.fn((_pid, signal) => {
      if (signal === 0 && !defaultAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      return true
    }) as typeof process.kill
    try {
      await expect(new DetachedSanctuaryHostSupervisor(defaultLiveness.options).execute({
        ...input,
        timeoutMs: -19_999,
      })).resolves.toMatchObject({ cleanup: "cgroup_empty" })
    } finally {
      process.kill = originalKill
    }

    vi.useFakeTimers()
    try {
      const defaultRecoverySleep = fixture()
      const defaultRecoverySleepCgroup = path.join(defaultRecoverySleep.options.cgroupRoot, permit.permitId)
      fs.mkdirSync(defaultRecoverySleepCgroup)
      defaultRecoverySleep.options.spawn = recovered.options.spawn
      defaultRecoverySleep.options.cgroupEmpty = () => true
      defaultRecoverySleep.options.killCgroup = vi.fn()
      defaultRecoverySleep.options.removeCgroup = vi.fn(() => fs.rmdirSync(defaultRecoverySleepCgroup))
      defaultRecoverySleep.options.sleep = undefined
      let recoverySignalled = false
      let postSignalChecks = 0
      defaultRecoverySleep.options.processAlive = vi.fn(() => !recoverySignalled || postSignalChecks++ === 0)
      defaultRecoverySleep.options.signalProcess = vi.fn(() => { recoverySignalled = true })
      const pending = new DetachedSanctuaryHostSupervisor(defaultRecoverySleep.options).execute({
        ...input,
        timeoutMs: -19_999,
      })
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ cleanup: "cgroup_empty" })
    } finally {
      vi.useRealTimers()
    }
  })
})
