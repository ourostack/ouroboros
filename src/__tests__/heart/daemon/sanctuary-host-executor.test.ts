import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { authorityArtifactDigest, signAuthorityPayload, verifyAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { FileSanctuaryAuthorityLedger } from "../../../heart/daemon/sanctuary-authority-ledger"
import {
  SanctuaryHostPermitExecutor,
  type HostExecutionPermitPayloadV1,
  type HostSupervisorAttempt,
} from "../../../heart/daemon/sanctuary-host-executor"
import { sanctuaryAuthorityPublicKeyDigest } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"

const keys = generateKeyPairSync("ed25519")
const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`

function payload(overrides: Partial<HostExecutionPermitPayloadV1> = {}): HostExecutionPermitPayloadV1 {
  return {
    targetHost: "sanctuary",
    permitId: `permit-${"a".repeat(43)}`,
    registrationId: `hostreg-${"b".repeat(43)}`,
    registrationDigest: `sha256:${"c".repeat(64)}`,
    ownerUserId: "42",
    ownerChatId: "42",
    ownerObservationDigest: `sha256:${"d".repeat(64)}`,
    callbackObservationDigest: `sha256:${"e".repeat(64)}`,
    residentFriendId: "friend-owner",
    relationshipProfileId: "sanctuary-owner",
    relationshipProfileVersion: 7,
    requestId: "request-1",
    sessionKey: "telegram:123456:42",
    sessionEventId: "evt_1234567890",
    residentApprovalId: "approval-1",
    effectClass: "owner_approved_arbitrary_host",
    executionProfile: "host.owner_approved.v1",
    targetResource: "host",
    command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
    scriptDigest: null,
    workingDirectoryProfile: "host.root.v1",
    environmentProfile: "host.clean.v1",
    environmentProfileDigest: `sha256:${createHash("sha256").update("host.clean.v1").digest("hex")}`,
    timeoutMs: 60_000,
    stewardPolicy: null,
    verification: null,
    issuedAt: "2026-09-16T20:01:00.000Z",
    expiresAt: "2026-09-16T20:03:00.000Z",
    nonce: "1".repeat(64),
    publicKeyDigest,
    ...overrides,
  }
}

function permit(value = payload(), privateKey = keys.privateKey) {
  return signAuthorityPayload({
    domain: "ouro.sanctuary.host-permit.v1",
    keyId: "issuer-1",
    payload: value,
    privateKey,
  })
}

function successfulAttempt(overrides: Partial<HostSupervisorAttempt> = {}): HostSupervisorAttempt {
  return {
    startedAt: "2026-09-16T20:01:01.000Z",
    completedAt: "2026-09-16T20:01:02.000Z",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    stdout: "0\n",
    stderr: "",
    stdoutDigest: digest("0\n"),
    stderrDigest: digest(""),
    stdoutBytes: 2,
    stderrBytes: 0,
    cleanup: "cgroup_empty",
    containment: "approved_root_may_escape",
    verificationBefore: null,
    verificationAfter: null,
    ...overrides,
  }
}

function fixture(execute: (input: any) => Promise<HostSupervisorAttempt> = async () => successfulAttempt()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-host-executor-"))
  const ledger = new FileSanctuaryAuthorityLedger(root)
  const supervisor = { execute: vi.fn(execute) }
  const options = {
    ledger,
    expectedTargetHost: "sanctuary",
    expectedOwnerUserId: "42",
    expectedOwnerChatId: "42",
    expectedKeyId: "issuer-1",
    expectedPublicKeyDigest: publicKeyDigest,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    stagingRoot: path.join(root, "staging"),
    stateRoot: path.join(root, "execution-state"),
    now: () => "2026-09-16T20:01:30.000Z",
    supervisor,
  }
  const executor = new SanctuaryHostPermitExecutor(options)
  return { executor, ledger, options, root, supervisor }
}

describe("Sanctuary host permit executor", () => {
  it("refuses a signed non-string executable before spawn", async () => {
    const f = fixture()
    await expect(f.executor.execute(permit(payload({ command: { kind: "executable", executable: 1, arguments: [] } as never })))).rejects.toThrow(/executable is invalid/u)
    expect(f.supervisor.execute).not.toHaveBeenCalled()
  })

  it.each([
    ["/bin/sh", "-ec", "printf unapproved"],
    ["/usr/bin/node", "--eval=process.exit()", ""],
    ["/usr/bin/node", "-p1+1", ""],
    ["/usr/bin/perl", "-E", "say 1"],
  ])("refuses signed inline-code arguments at execution for %s %s", async (interpreter, flag, source) => {
    const f = fixture()
    const script = "printf safe\n"
    await expect(f.executor.execute(permit(payload({
      command: { kind: "script", interpreter, arguments: [flag, source].filter(Boolean), script },
      scriptDigest: digest(script),
    })))).rejects.toThrow(/command is invalid/u)
    expect(f.supervisor.execute).not.toHaveBeenCalled()
  })

  it("verifies, durably reserves before spawn, and terminalizes one signed executable permit", async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture(async (input) => {
      expect(f.ledger.read(input.permit.permitId)).toMatchObject({ state: "reserved" })
      expect(input).toMatchObject({
        executable: "/usr/bin/id",
        arguments: ["-u"],
        cwd: "/",
        environment: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        timeoutMs: 60_000,
      })
      return successfulAttempt()
    })
    const artifact = permit()
    const receipt = await f.executor.execute(artifact)
    const receiptPayload = verifyAuthorityPayload<Record<string, unknown>>({
      artifact: receipt,
      expectedDomain: "ouro.sanctuary.host-receipt.v1",
      expectedKeyId: "issuer-1",
      publicKey: keys.publicKey,
    })
    expect(receiptPayload).toMatchObject({
      permitId: payload().permitId,
      permitDigest: authorityArtifactDigest(artifact.domain, artifact.payload),
      state: "verified",
      exitCode: 0,
      stdoutExcerpt: "0\n",
      cleanup: "cgroup_empty",
      containment: "approved_root_may_escape",
    })
    expect(f.ledger.read(payload().permitId)).toMatchObject({ state: "verified" })
    await expect(f.executor.execute(artifact)).rejects.toThrow(/already exists/u)
    expect(f.supervisor.execute).toHaveBeenCalledOnce()
  })

  it("finishes an acknowledgement interrupted after the atomic state-directory rename", async () => {
    const f = fixture()
    const artifact = permit()
    await f.executor.execute(artifact)
    const root = path.join(f.options.stateRoot, artifact.payload.permitId)
    const acknowledgedRoot = `${root}.acknowledged`
    fs.renameSync(root, acknowledgedRoot)

    expect(() => f.executor.acknowledge(artifact.payload.permitId)).not.toThrow()
    expect(fs.existsSync(acknowledgedRoot)).toBe(false)

    const reconciled = fixture()
    const reconciledArtifact = permit()
    await reconciled.executor.execute(reconciledArtifact)
    const reconciledRoot = path.join(reconciled.options.stateRoot, reconciledArtifact.payload.permitId)
    const reconciledAcknowledgedRoot = `${reconciledRoot}.acknowledged`
    fs.renameSync(reconciledRoot, reconciledAcknowledgedRoot)
    await expect(reconciled.executor.reconcile()).resolves.toEqual([])
    expect(fs.existsSync(reconciledAcknowledgedRoot)).toBe(false)

    const changed = fixture()
    const changedArtifact = permit()
    await changed.executor.execute(changedArtifact)
    const changedRoot = path.join(changed.options.stateRoot, changedArtifact.payload.permitId)
    const changedAcknowledgedRoot = `${changedRoot}.acknowledged`
    fs.renameSync(changedRoot, changedAcknowledgedRoot)
    fs.writeFileSync(path.join(changedAcknowledgedRoot, "unexpected"), "changed")
    await expect(changed.executor.reconcile()).rejects.toThrow(/contents changed/u)
  })

  it("recovers atomic journal publications without replaying an executed permit", async () => {
    const unreserved = fixture()
    const unreservedArtifact = permit()
    const unreservedRoot = path.join(unreserved.options.stateRoot, unreservedArtifact.payload.permitId)
    fs.mkdirSync(unreservedRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(unreservedRoot, "permit.json.tmp"), `${JSON.stringify(unreservedArtifact)}\n`, { mode: 0o600 })
    await expect(unreserved.executor.reconcile()).resolves.toEqual([])
    expect(fs.existsSync(unreservedRoot)).toBe(false)
    expect(unreserved.supervisor.execute).not.toHaveBeenCalled()

    const changedUnreserved = fixture()
    const changedRoot = path.join(changedUnreserved.options.stateRoot, unreservedArtifact.payload.permitId)
    fs.mkdirSync(changedRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(changedRoot, "unexpected"), "changed")
    await expect(changedUnreserved.executor.reconcile()).rejects.toThrow(/ledger is missing/u)

    const receiptPublication = fixture()
    const receiptArtifact = permit()
    const receipt = await receiptPublication.executor.execute(receiptArtifact)
    const receiptPath = path.join(receiptPublication.options.stateRoot, receiptArtifact.payload.permitId, "receipt.json")
    fs.renameSync(receiptPath, `${receiptPath}.tmp`)
    const resume = vi.fn(async () => { throw new Error("must not replay after receipt publication") })
    const recovered = new SanctuaryHostPermitExecutor({
      ...receiptPublication.options,
      supervisor: { execute: vi.fn(), resume },
    })
    await expect(recovered.reconcile()).resolves.toEqual([receipt])
    expect(fs.existsSync(receiptPath)).toBe(true)
    expect(resume).not.toHaveBeenCalled()

    const reservedPublication = fixture()
    const reservedArtifact = permit()
    const reservedReceipt = receipt
    const reservedRoot = path.join(reservedPublication.options.stateRoot, reservedArtifact.payload.permitId)
    fs.mkdirSync(reservedRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(reservedRoot, "permit.json"), `${JSON.stringify(reservedArtifact)}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(reservedRoot, "receipt.json.tmp"), `${JSON.stringify(reservedReceipt)}\n`, { mode: 0o600 })
    reservedPublication.ledger.reserve({
      permitId: reservedArtifact.payload.permitId,
      nonce: reservedArtifact.payload.nonce,
      permitDigest: authorityArtifactDigest(reservedArtifact.domain, reservedArtifact.payload),
      reservedAt: reservedArtifact.payload.issuedAt,
    })
    await expect(reservedPublication.executor.reconcile()).resolves.toHaveLength(1)
    expect(reservedPublication.ledger.read(reservedArtifact.payload.permitId)).toMatchObject({ state: "verified" })

    const unsafeTemporary = fixture()
    const unsafeRoot = path.join(unsafeTemporary.options.stateRoot, reservedArtifact.payload.permitId)
    fs.mkdirSync(unsafeRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(unsafeRoot, "permit.json"), `${JSON.stringify(reservedArtifact)}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(unsafeRoot, "receipt.json.tmp"), `${JSON.stringify(reservedReceipt)}\n`, { mode: 0o644 })
    unsafeTemporary.ledger.reserve({
      permitId: reservedArtifact.payload.permitId,
      nonce: reservedArtifact.payload.nonce,
      permitDigest: authorityArtifactDigest(reservedArtifact.domain, reservedArtifact.payload),
      reservedAt: reservedArtifact.payload.issuedAt,
    })
    await expect(unsafeTemporary.executor.reconcile()).rejects.toThrow(/temporary artifact metadata/u)

    const partial = fixture()
    const partialArtifact = permit()
    await partial.executor.execute(partialArtifact)
    const partialReceipt = path.join(partial.options.stateRoot, partialArtifact.payload.permitId, "receipt.json")
    fs.renameSync(partialReceipt, `${partialReceipt}.tmp`)
    fs.writeFileSync(`${partialReceipt}.tmp`, "{\"schemaVersion\":1", { mode: 0o600 })
    await expect(partial.executor.reconcile()).rejects.toThrow()
    expect(partial.supervisor.execute).toHaveBeenCalledOnce()
  })

  it("refuses wrong signature, key, host, digest, profile, expiry, command, and script binding before spawn", async () => {
    const otherKeys = generateKeyPairSync("ed25519")
    const cases = [
      permit(payload(), otherKeys.privateKey),
      signAuthorityPayload({ domain: "wrong.domain", keyId: "issuer-1", payload: payload(), privateKey: keys.privateKey }),
      signAuthorityPayload({ domain: "ouro.sanctuary.host-permit.v1", keyId: "wrong-key", payload: payload(), privateKey: keys.privateKey }),
      permit(payload({ targetHost: "other" })),
      permit(payload({ ownerUserId: "84" })),
      permit(payload({ ownerChatId: "84" })),
      permit(payload({ publicKeyDigest: `sha256:${"0".repeat(64)}` })),
      permit(payload({ executionProfile: "other" as "host.owner_approved.v1" })),
      permit(payload({ expiresAt: "2026-09-16T20:01:29.999Z" })),
      permit(payload({ command: { kind: "executable", executable: "id", arguments: [] } })),
      permit(payload({
        command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo hi\n" },
        scriptDigest: `sha256:${"0".repeat(64)}`,
      })),
    ]
    for (const candidate of cases) {
      const f = fixture()
      await expect(f.executor.execute(candidate)).rejects.toThrow()
      expect(f.supervisor.execute).not.toHaveBeenCalled()
    }
  })

  it("independently mirrors the issuer command grammar before reserving or spawning", async () => {
    const invalidCommands = [
      { kind: "executable", executable: "/bin/sh", arguments: ["-c", "id"] },
      { kind: "executable", executable: "/usr/bin/id", arguments: Array.from({ length: 65 }, () => "x") },
      { kind: "script", interpreter: "/bin/sh", arguments: ["--eval"], script: "echo ok\n" },
      { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo ok\r\n" },
      { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo\tok\n" },
      { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo café\n" },
      { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo ok \n" },
    ] as const
    for (const command of invalidCommands) {
      const value = payload({
        command: command as HostExecutionPermitPayloadV1["command"],
        scriptDigest: command.kind === "script" ? `sha256:${createHash("sha256").update(command.script).digest("hex")}` : null,
      })
      const f = fixture()
      await expect(f.executor.execute(permit(value))).rejects.toThrow()
      expect(f.ledger.read(value.permitId)).toBeNull()
      expect(f.supervisor.execute).not.toHaveBeenCalled()
    }
  })

  it("stages exact script bytes with no-follow ownership and removes them after terminal receipt", async () => {
    const script = "printf 'safe\\n'\n"
    let stagedPath = ""
    const f = fixture(async (input) => {
      stagedPath = input.arguments[0]
      expect(fs.readFileSync(stagedPath, "utf8")).toBe(script)
      expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o700)
      expect(input.arguments).toEqual([stagedPath])
      expect(input.executable).toBe("/bin/sh")
      return successfulAttempt()
    })
    const scriptPayload = payload({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script },
      scriptDigest: `sha256:${createHash("sha256").update(script).digest("hex")}`,
    })
    await f.executor.execute(permit(scriptPayload))
    expect(fs.existsSync(stagedPath)).toBe(false)
  })

  it("reuses exact retained staged script bytes while resuming a reserved execution", async () => {
    const scriptValue = payload({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo resume\n" },
      scriptDigest: digest("echo resume\n"),
    })
    const interrupted = fixture(async () => { throw new Error("supervisor interrupted") })
    await expect(interrupted.executor.execute(permit(scriptValue))).rejects.toThrow(/reconciliation/u)
    const stagedPath = path.join(interrupted.options.stagingRoot, `${scriptValue.permitId}.script`)
    expect(fs.readFileSync(stagedPath, "utf8")).toBe("echo resume\n")

    const resume = vi.fn(async (input) => {
      expect(input.arguments.at(-1)).toBe(stagedPath)
      return successfulAttempt()
    })
    const recovered = new SanctuaryHostPermitExecutor({
      ...interrupted.options,
      supervisor: { execute: vi.fn(), resume },
    })
    await expect(recovered.reconcile()).resolves.toMatchObject([{ payload: { state: "verified" } }])
    expect(resume).toHaveBeenCalledOnce()

    const absent = fixture(async () => { throw new Error("supervisor interrupted") })
    await expect(absent.executor.execute(permit(scriptValue))).rejects.toThrow(/reconciliation/u)
    fs.unlinkSync(path.join(absent.options.stagingRoot, `${scriptValue.permitId}.script`))
    const absentResume = vi.fn(async () => successfulAttempt())
    await expect(new SanctuaryHostPermitExecutor({
      ...absent.options,
      supervisor: { execute: vi.fn(), resume: absentResume },
    }).reconcile()).resolves.toHaveLength(1)

    for (const mutation of [
      (target: string) => fs.chmodSync(target, 0o600),
      (target: string) => fs.writeFileSync(target, "changed\n"),
    ]) {
      const changed = fixture(async () => { throw new Error("supervisor interrupted") })
      await expect(changed.executor.execute(permit(scriptValue))).rejects.toThrow(/reconciliation/u)
      mutation(path.join(changed.options.stagingRoot, `${scriptValue.permitId}.script`))
      await expect(new SanctuaryHostPermitExecutor({
        ...changed.options,
        supervisor: { execute: vi.fn(), resume: vi.fn() },
      }).reconcile()).rejects.toThrow(/staged script/u)
    }
  })

  it("returns failed or ambiguous terminal receipts without reopening reserved authority", async () => {
    for (const [attempt, state] of [
      [successfulAttempt({ exitCode: 1, stderr: "failed" }), "failed"],
      [successfulAttempt({ timedOut: true, exitCode: null, signal: "SIGTERM" }), "failed"],
      [successfulAttempt({ outputOverflow: true, stdout: "x".repeat(70_000) }), "failed"],
      [successfulAttempt({ verificationAfter: { matches: null, digest: `sha256:${"9".repeat(64)}` } }), "ambiguous"],
      [successfulAttempt({ containment: "unprovable_after_approved_root_migration" }), "verified"],
    ] as const) {
      const unique = payload({
        permitId: `permit-${String(state[0]).padEnd(43, "x").slice(0, 43)}`,
        nonce: String(state[0]).padEnd(64, "1").slice(0, 64),
        verification: state === "ambiguous" ? { profile: "file.digest.v1", expectedStateDigest: `sha256:${"8".repeat(64)}` } : null,
      })
      const f = fixture(async () => attempt)
      const receipt = await f.executor.execute(permit(unique))
      expect((receipt.payload as Record<string, unknown>).state).toBe(state)
      expect(f.ledger.read(unique.permitId)).toMatchObject({ state })
    }
  })

  it("retains reserved authority after a supervisor dependency failure and enforces one active execution", async () => {
    const failed = fixture(async () => { throw new Error("spawn failed") })
    await expect(failed.executor.execute(permit())).rejects.toThrow(/cleanup requires reconciliation/u)
    expect(failed.ledger.read(payload().permitId)).toMatchObject({ state: "reserved" })

    let release!: () => void
    const blocked = new Promise<HostSupervisorAttempt>((resolve) => { release = () => resolve(successfulAttempt()) })
    const active = fixture(async () => blocked)
    const first = active.executor.execute(permit())
    await expect(active.executor.execute(permit(payload({
      permitId: `permit-${"z".repeat(43)}`,
      nonce: "2".repeat(64),
    })))).rejects.toThrow(/active/u)
    release()
    await first
  })

  it("retains reserved authority when supervisor evidence is malformed", async () => {
    for (const attempt of [
      successfulAttempt({ completedAt: "2026-09-16T20:01:00.000Z" }),
      successfulAttempt({ verificationBefore: { digest: "bad" } }),
      successfulAttempt({ verificationAfter: { matches: "yes" as never, digest: `sha256:${"a".repeat(64)}` } }),
    ]) {
      const f = fixture(async () => attempt)
      await expect(f.executor.execute(permit())).rejects.toThrow(/cleanup requires reconciliation/u)
      expect(f.ledger.read(payload().permitId)).toMatchObject({ state: "reserved" })
    }
  })

  it("refuses every malformed permit field before reserving authority", async () => {
    const malformed = [
      null,
      { ...payload(), extra: true },
      { ...payload(), targetHost: "other" },
      { ...payload(), ownerUserId: "84" },
      { ...payload(), ownerChatId: "84" },
      { ...payload(), permitId: "bad" },
      { ...payload(), registrationId: "bad" },
      { ...payload(), registrationDigest: "bad" },
      { ...payload(), ownerObservationDigest: "bad" },
      { ...payload(), callbackObservationDigest: "bad" },
      { ...payload(), effectClass: "bad" },
      { ...payload(), executionProfile: "bad" },
      { ...payload(), workingDirectoryProfile: "bad" },
      { ...payload(), environmentProfile: "bad" },
      { ...payload(), environmentProfileDigest: "bad" },
      { ...payload(), publicKeyDigest: "bad" },
      { ...payload(), timeoutMs: "60000" },
      { ...payload(), timeoutMs: 999 },
      { ...payload(), timeoutMs: 900_001 },
      { ...payload(), issuedAt: 42 },
      { ...payload(), issuedAt: "bad" },
      { ...payload(), expiresAt: 42 },
      { ...payload(), expiresAt: "bad" },
      { ...payload(), issuedAt: "2026-09-16T20:00:00.000Z", expiresAt: "2026-09-16T20:02:00.001Z" },
      { ...payload(), expiresAt: "2026-09-16T20:01:29.999Z" },
      { ...payload(), issuedAt: "2026-09-16T20:01:30.001Z" },
      { ...payload(), nonce: "bad" },
      { ...payload(), residentFriendId: "" },
      { ...payload(), relationshipProfileVersion: "1" },
      { ...payload(), relationshipProfileVersion: 0 },
      { ...payload(), verification: "bad" },
      { ...payload(), verification: {} },
      { ...payload(), verification: { profile: "", expectedStateDigest: `sha256:${"a".repeat(64)}` } },
      { ...payload(), verification: { profile: "file.digest.v1", expectedStateDigest: "bad" } },
      { ...payload(), stewardPolicy: "bad" },
      { ...payload(), stewardPolicy: {} },
      { ...payload(), stewardPolicy: { key: "", version: 1, digest: `sha256:${"a".repeat(64)}` } },
      { ...payload(), stewardPolicy: { key: "policy", version: "1", digest: `sha256:${"a".repeat(64)}` } },
      { ...payload(), stewardPolicy: { key: "policy", version: 0, digest: `sha256:${"a".repeat(64)}` } },
      { ...payload(), stewardPolicy: { key: "policy", version: 1, digest: "bad" } },
    ]
    for (const value of malformed) {
      const f = fixture()
      await expect(f.executor.execute(permit(value as never))).rejects.toThrow()
      expect(f.ledger.read(payload().permitId)).toBeNull()
      expect(f.supervisor.execute).not.toHaveBeenCalled()
    }
  })

  it("retains reserved authority and staged evidence when staging or terminal persistence is uncertain", async () => {
    const relative = fixture()
    expect(() => new SanctuaryHostPermitExecutor({
      ...relative.options,
      stagingRoot: "relative",
    })).toThrow(/absolute/u)

    const wrongMode = fixture()
    fs.mkdirSync(path.join(wrongMode.root, "staging"), { recursive: true, mode: 0o755 })
    const scriptValue = payload({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo ok\n" },
      scriptDigest: `sha256:${createHash("sha256").update("echo ok\n").digest("hex")}`,
    })
    await expect(wrongMode.executor.execute(permit(scriptValue))).rejects.toThrow(/metadata/u)
    expect(wrongMode.ledger.read(payload().permitId)).toMatchObject({ state: "reserved" })
    expect(wrongMode.supervisor.execute).not.toHaveBeenCalled()

    const collision = fixture()
    fs.mkdirSync(path.join(collision.root, "staging"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(collision.root, "staging", `${scriptValue.permitId}.script`), "occupied", { mode: 0o700 })
    await expect(collision.executor.execute(permit(scriptValue))).rejects.toThrow()
    expect(collision.ledger.read(scriptValue.permitId)).toMatchObject({ state: "reserved" })
    expect(collision.supervisor.execute).not.toHaveBeenCalled()

    const persistence = fixture()
    const terminalize = vi.spyOn(persistence.ledger, "terminalize").mockImplementation(() => { throw new Error("disk failed") })
    await expect(persistence.executor.execute(permit(scriptValue))).rejects.toThrow("disk failed")
    expect(terminalize).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(persistence.root, "staging", `${scriptValue.permitId}.script`))).toBe(true)
    terminalize.mockRestore()
    const resumedSupervisor = {
      execute: vi.fn(async () => { throw new Error("must not execute") }),
      resume: vi.fn(async () => { throw new Error("must not resume after a durable receipt") }),
    }
    const recovered = new SanctuaryHostPermitExecutor({
      ...persistence.options,
      supervisor: resumedSupervisor,
    })
    const recoveredReceipts = await recovered.reconcile()
    expect(recoveredReceipts).toHaveLength(1)
    expect(recoveredReceipts[0]!.payload).toMatchObject({ permitId: scriptValue.permitId, state: "verified" })
    expect(resumedSupervisor.execute).not.toHaveBeenCalled()
    expect(resumedSupervisor.resume).not.toHaveBeenCalled()
    expect(persistence.ledger.read(scriptValue.permitId)).toMatchObject({ state: "verified" })
    expect(fs.existsSync(path.join(persistence.root, "staging", `${scriptValue.permitId}.script`))).toBe(false)
    recovered.acknowledge(scriptValue.permitId)
    expect(fs.existsSync(path.join(persistence.options.stateRoot, scriptValue.permitId))).toBe(false)

    const symlink = fixture()
    const target = path.join(symlink.root, "real-staging")
    fs.mkdirSync(target, { mode: 0o700 })
    fs.symlinkSync(target, path.join(symlink.root, "staging"))
    await expect(symlink.executor.execute(permit(scriptValue))).rejects.toThrow(/metadata/u)
    expect(symlink.ledger.read(scriptValue.permitId)).toMatchObject({ state: "reserved" })

    const invalidTime = fixture()
    const badClock = new SanctuaryHostPermitExecutor({ ...invalidTime.options, now: () => "bad" })
    await expect(badClock.execute(permit())).rejects.toThrow(/time/u)

    const live = new Date()
    const issuedAt = new Date(live.getTime() - 1_000).toISOString()
    const expiresAt = new Date(live.getTime() + 60_000).toISOString()
    const defaultClock = fixture()
    const withoutClock = new SanctuaryHostPermitExecutor({ ...defaultClock.options, now: undefined })
    await expect(withoutClock.execute(permit(payload({ issuedAt, expiresAt })))).resolves.toMatchObject({ domain: "ouro.sanctuary.host-receipt.v1" })
  })

  it("fails closed across every durable execution journal and resume state", async () => {
    const absent = fixture()
    const reconcileOrphans = vi.fn(async () => undefined)
    absent.options.supervisor.reconcileOrphans = reconcileOrphans
    await expect(absent.executor.reconcile()).resolves.toEqual([])
    expect(reconcileOrphans).toHaveBeenCalledWith([])
    expect(() => new SanctuaryHostPermitExecutor({ ...absent.options, stateRoot: "relative" })).toThrow(/state root/u)

    const notDirectory = fixture()
    fs.writeFileSync(notDirectory.options.stateRoot, "file")
    await expect(notDirectory.executor.reconcile()).rejects.toThrow()

    const invalidEntry = fixture()
    fs.mkdirSync(path.join(invalidEntry.options.stateRoot, "bad"), { recursive: true })
    await expect(invalidEntry.executor.reconcile()).rejects.toThrow(/entry/u)

    const artifact = permit()
    const invalidAcknowledgement = fixture()
    fs.mkdirSync(path.join(invalidAcknowledgement.options.stateRoot, "bad.acknowledged"), { recursive: true })
    await expect(invalidAcknowledgement.executor.reconcile()).rejects.toThrow(/acknowledgement entry/u)

    const unknownAcknowledgement = fixture()
    fs.mkdirSync(path.join(unknownAcknowledgement.options.stateRoot, `${payload().permitId}.acknowledged`), { recursive: true })
    await expect(unknownAcknowledgement.executor.reconcile()).rejects.toThrow(/not terminal/u)

    const reservedAcknowledgement = fixture()
    reservedAcknowledgement.ledger.reserve({
      permitId: payload().permitId,
      nonce: payload().nonce,
      permitDigest: authorityArtifactDigest(artifact.domain, artifact.payload),
      reservedAt: "2026-09-16T20:01:30.000Z",
    })
    fs.mkdirSync(path.join(reservedAcknowledgement.options.stateRoot, `${payload().permitId}.acknowledged`), { recursive: true })
    await expect(reservedAcknowledgement.executor.reconcile()).rejects.toThrow(/not terminal/u)
    const missingLedger = fixture()
    const permitRoot = path.join(missingLedger.options.stateRoot, payload().permitId)
    fs.mkdirSync(permitRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(permitRoot, "permit.json"), `${JSON.stringify(artifact)}\n`, { mode: 0o600 })
    await expect(missingLedger.executor.reconcile()).resolves.toEqual([])
    expect(fs.existsSync(permitRoot)).toBe(false)

    const missingResume = fixture()
    const missingResumeRoot = path.join(missingResume.options.stateRoot, payload().permitId)
    fs.mkdirSync(missingResumeRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(missingResumeRoot, "permit.json"), `${JSON.stringify(artifact)}\n`, { mode: 0o600 })
    missingResume.ledger.reserve({
      permitId: payload().permitId,
      nonce: payload().nonce,
      permitDigest: authorityArtifactDigest(artifact.domain, artifact.payload),
      reservedAt: "2026-09-16T20:01:30.000Z",
    })
    await expect(missingResume.executor.reconcile()).rejects.toThrow(/cleanup requires reconciliation/u)
    expect(missingResume.ledger.read(payload().permitId)).toMatchObject({ state: "reserved" })
    expect(missingResume.supervisor.execute).not.toHaveBeenCalled()

    const terminal = fixture()
    const terminalReceipt = await terminal.executor.execute(artifact)
    await expect(terminal.executor.reconcile()).resolves.toEqual([terminalReceipt])
    fs.unlinkSync(path.join(terminal.options.stateRoot, payload().permitId, "receipt.json"))
    await expect(terminal.executor.reconcile()).rejects.toThrow(/receipt is missing/u)
    terminal.executor.acknowledge(payload().permitId)

    const reserved = fixture()
    reserved.ledger.reserve({
      permitId: payload().permitId,
      nonce: payload().nonce,
      permitDigest: authorityArtifactDigest(artifact.domain, artifact.payload),
      reservedAt: "2026-09-16T20:01:30.000Z",
    })
    const reservedRoot = path.join(reserved.options.stateRoot, payload().permitId)
    fs.mkdirSync(reservedRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(reservedRoot, "permit.json"), `${JSON.stringify(artifact)}\n`, { mode: 0o600 })
    const resume = vi.fn(async () => successfulAttempt())
    const resumed = new SanctuaryHostPermitExecutor({
      ...reserved.options,
      supervisor: { execute: vi.fn(), resume },
    })
    await expect(resumed.reconcile()).resolves.toMatchObject([{ payload: { state: "verified" } }])
    expect(resume).toHaveBeenCalledOnce()

    const reservedOnly = fixture()
    const reservedArtifact = permit()
    reservedOnly.ledger.reserve({
      permitId: payload().permitId,
      nonce: payload().nonce,
      permitDigest: authorityArtifactDigest(reservedArtifact.domain, reservedArtifact.payload),
      reservedAt: "2026-09-16T20:01:30.000Z",
    })
    expect(() => reservedOnly.executor.acknowledge(payload().permitId)).toThrow(/not terminal/u)
    expect(() => reservedOnly.executor.acknowledge("bad")).toThrow(/permit id/u)

    const absentTerminalState = fixture()
    await absentTerminalState.executor.execute(artifact)
    fs.rmSync(path.join(absentTerminalState.options.stateRoot, payload().permitId), { recursive: true })
    expect(() => absentTerminalState.executor.acknowledge(payload().permitId)).not.toThrow()

    const temporaryPublication = fixture()
    const temporaryRoot = path.join(temporaryPublication.options.stateRoot, payload().permitId)
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(temporaryRoot, "permit.json.tmp"), "pending", { mode: 0o600 })
    await expect(temporaryPublication.executor.execute(artifact)).rejects.toThrow(/temporary publication exists/u)

    const changedBinding = fixture()
    const changedBindingRoot = path.join(changedBinding.options.stateRoot, payload().permitId)
    fs.mkdirSync(changedBindingRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(changedBindingRoot, "permit.json"), `${JSON.stringify(artifact)}\n`, { mode: 0o600 })
    changedBinding.ledger.reserve({
      permitId: payload().permitId,
      nonce: payload().nonce,
      permitDigest: `sha256:${"0".repeat(64)}`,
      reservedAt: "2026-09-16T20:01:30.000Z",
    })
    await expect(changedBinding.executor.reconcile()).rejects.toThrow(/binding changed/u)
  })

  it("rejects changed journal bytes, metadata, receipt bindings, and cleanup ambiguity", async () => {
    const changed = fixture()
    const first = permit()
    await changed.executor.execute(first)
    const changedArtifact = permit(payload({ timeoutMs: 61_000 }))
    await expect(changed.executor.execute(changedArtifact)).rejects.toThrow(/permit.json changed/u)

    const metadata = fixture()
    await metadata.executor.execute(permit())
    fs.chmodSync(path.join(metadata.options.stateRoot, payload().permitId, "permit.json"), 0o644)
    await expect(metadata.executor.reconcile()).rejects.toThrow(/metadata/u)

    for (const replacement of [
      { permitId: `permit-${"z".repeat(43)}` },
      { permitDigest: `sha256:${"0".repeat(64)}` },
      { state: "other" },
      { completedAt: "bad" },
    ]) {
      const f = fixture()
      const receipt = await f.executor.execute(permit())
      const tampered = signAuthorityPayload({
        domain: "ouro.sanctuary.host-receipt.v1",
        keyId: "issuer-1",
        privateKey: keys.privateKey,
        payload: { ...receipt.payload, ...replacement },
      })
      fs.writeFileSync(
        path.join(f.options.stateRoot, payload().permitId, "receipt.json"),
        `${JSON.stringify(tampered)}\n`,
        { mode: 0o600 },
      )
      await expect(f.executor.reconcile()).rejects.toThrow(/binding/u)
    }

    const cleanup = fixture()
    const cleanupReceipt = await cleanup.executor.execute(permit())
    const stagedPath = path.join(cleanup.options.stagingRoot, `${payload().permitId}.script`)
    fs.mkdirSync(stagedPath, { recursive: true })
    await expect(cleanup.executor.reconcile()).rejects.toThrow()
    fs.rmdirSync(stagedPath)
    expect(cleanupReceipt.payload).toMatchObject({ state: "verified" })

    const acknowledgeFailure = fixture()
    await acknowledgeFailure.executor.execute(permit())
    const receiptPath = path.join(acknowledgeFailure.options.stateRoot, payload().permitId, "receipt.json")
    fs.unlinkSync(receiptPath)
    fs.mkdirSync(receiptPath)
    expect(() => acknowledgeFailure.executor.acknowledge(payload().permitId)).toThrow()
  })
})
