import { createHash, type KeyLike } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import {
  authorityArtifactDigest,
  signAuthorityPayload,
  verifyAuthorityPayload,
  type SignedAuthorityPayload,
} from "./sanctuary-authority-codec"
import type { HostCommandV1 } from "./sanctuary-host-authority"
import type { FileSanctuaryAuthorityLedger } from "./sanctuary-authority-ledger"

const PERMIT_DOMAIN = "ouro.sanctuary.host-permit.v1"
const RECEIPT_DOMAIN = "ouro.sanctuary.host-receipt.v1"
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const PERMIT_ID = /^permit-[A-Za-z0-9_-]{43}$/u
const REGISTRATION_ID = /^hostreg-[A-Za-z0-9_-]{43}$/u
const NONCE = /^[A-Za-z0-9_-]{64}$/u
const PRINTABLE = /^[\x20-\x7e]+$/u
const SCRIPT_BYTES = /^[\x0a\x20-\x7e]+$/u
const INLINE_CODE_SWITCHES = new Set(["-c", "-e", "--eval", "--evaluate"])
const OUTPUT_LIMIT = 64 * 1024
const EXCERPT_LIMIT = 4_096
const ACKNOWLEDGED_SUFFIX = ".acknowledged"
const CLEAN_ENVIRONMENT = Object.freeze({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
})

export interface HostExecutionPermitPayloadV1 {
  targetHost: string
  permitId: string
  registrationId: string
  registrationDigest: string
  ownerUserId: string
  ownerChatId: string
  ownerObservationDigest: string
  callbackObservationDigest: string
  residentFriendId: string
  relationshipProfileId: string
  relationshipProfileVersion: number
  requestId: string
  sessionKey: string
  sessionEventId: string
  residentApprovalId: string
  effectClass: "owner_approved_arbitrary_host"
  executionProfile: "host.owner_approved.v1"
  targetResource: string
  command: HostCommandV1
  scriptDigest: string | null
  workingDirectoryProfile: "host.root.v1"
  environmentProfile: "host.clean.v1"
  environmentProfileDigest: string
  timeoutMs: number
  stewardPolicy: null | {
    key: string
    version: number
    digest: string
  }
  verification: null | {
    profile: string
    expectedStateDigest: string
  }
  issuedAt: string
  expiresAt: string
  nonce: string
  publicKeyDigest: string
}

export interface HostSupervisorAttempt {
  startedAt: string
  completedAt: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  outputOverflow: boolean
  stdout: string
  stderr: string
  stdoutDigest: string
  stderrDigest: string
  stdoutBytes: number
  stderrBytes: number
  cleanup: "cgroup_empty" | "cleanup_unproven"
  containment: "approved_root_may_escape" | "unprovable_after_approved_root_migration"
  verificationBefore: null | { digest: string }
  verificationAfter: null | { matches: boolean | null; digest: string }
}

export interface HostSupervisor {
  execute(input: {
    permit: HostExecutionPermitPayloadV1
    permitArtifact: SignedAuthorityPayload<HostExecutionPermitPayloadV1>
    executable: string
    arguments: string[]
    cwd: "/"
    environment: typeof CLEAN_ENVIRONMENT
    timeoutMs: number
  }): Promise<HostSupervisorAttempt>
  resume?(input: {
    permit: HostExecutionPermitPayloadV1
    permitArtifact: SignedAuthorityPayload<HostExecutionPermitPayloadV1>
    executable: string
    arguments: string[]
    cwd: "/"
    environment: typeof CLEAN_ENVIRONMENT
    timeoutMs: number
  }): Promise<HostSupervisorAttempt>
  reconcileOrphans?(knownPermitIds: readonly string[]): Promise<void>
  acknowledge?(permitId: string): void
}

export interface SanctuaryHostPermitExecutorOptions {
  ledger: FileSanctuaryAuthorityLedger
  expectedTargetHost: string
  expectedOwnerUserId: string
  expectedOwnerChatId: string
  expectedKeyId: string
  expectedPublicKeyDigest: string
  publicKey: KeyLike
  privateKey: KeyLike
  stagingRoot: string
  stateRoot: string
  supervisor: HostSupervisor
  now?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  const instant = new Date(value)
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value
}

function printable(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && PRINTABLE.test(value)
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function absoluteExecutable(value: unknown): value is string {
  return printable(value, 512)
    && path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && !value.includes("/../")
    && !value.endsWith("/..")
}

function validateCommand(command: unknown, scriptDigest: unknown): asserts command is HostCommandV1 {
  if (
    !isObject(command)
    || !Array.isArray(command.arguments)
    || command.arguments.length > 64
    || !command.arguments.every((argument) => printable(argument, 512))
    || command.arguments.some((argument) => INLINE_CODE_SWITCHES.has(argument))
  ) {
    throw new Error("Sanctuary host permit command is invalid")
  }
  if (command.kind === "executable") {
    if (
      !exactKeys(command, ["kind", "executable", "arguments"])
      || !absoluteExecutable(command.executable)
      || scriptDigest !== null
    ) {
      throw new Error("Sanctuary host permit executable is invalid")
    }
    return
  }
  if (
    command.kind !== "script"
    || !exactKeys(command, ["kind", "interpreter", "arguments", "script"])
    || !absoluteExecutable(command.interpreter)
    || typeof command.script !== "string"
    || Buffer.byteLength(command.script, "utf8") === 0
    || Buffer.byteLength(command.script, "utf8") > 2_048
    || !SCRIPT_BYTES.test(command.script)
    || command.script.split("\n").some((line) => line.endsWith(" "))
    || typeof scriptDigest !== "string"
    || scriptDigest !== digest(command.script)
  ) {
    throw new Error("Sanctuary host permit script is invalid")
  }
}

function validatePermit(
  value: unknown,
  options: SanctuaryHostPermitExecutorOptions,
  now: string,
): asserts value is HostExecutionPermitPayloadV1 {
  if (!isObject(value) || !exactKeys(value, [
    "targetHost",
    "permitId",
    "registrationId",
    "registrationDigest",
    "ownerUserId",
    "ownerChatId",
    "ownerObservationDigest",
    "callbackObservationDigest",
    "residentFriendId",
    "relationshipProfileId",
    "relationshipProfileVersion",
    "requestId",
    "sessionKey",
    "sessionEventId",
    "residentApprovalId",
    "effectClass",
    "executionProfile",
    "targetResource",
    "command",
    "scriptDigest",
    "workingDirectoryProfile",
    "environmentProfile",
    "environmentProfileDigest",
    "timeoutMs",
    "stewardPolicy",
    "verification",
    "issuedAt",
    "expiresAt",
    "nonce",
    "publicKeyDigest",
  ])) {
    throw new Error("Sanctuary host permit payload is malformed")
  }
  if (
    value.targetHost !== options.expectedTargetHost
    || value.ownerUserId !== options.expectedOwnerUserId
    || value.ownerChatId !== options.expectedOwnerChatId
    || !PERMIT_ID.test(String(value.permitId))
    || !REGISTRATION_ID.test(String(value.registrationId))
    || !DIGEST.test(String(value.registrationDigest))
    || !DIGEST.test(String(value.ownerObservationDigest))
    || !DIGEST.test(String(value.callbackObservationDigest))
    || value.effectClass !== "owner_approved_arbitrary_host"
    || value.executionProfile !== "host.owner_approved.v1"
    || value.workingDirectoryProfile !== "host.root.v1"
    || value.environmentProfile !== "host.clean.v1"
    || value.environmentProfileDigest !== digest("host.clean.v1")
    || value.publicKeyDigest !== options.expectedPublicKeyDigest
    || !Number.isSafeInteger(value.timeoutMs)
    || (value.timeoutMs as number) < 1_000
    || (value.timeoutMs as number) > 900_000
    || !validTime(value.issuedAt)
    || !validTime(value.expiresAt)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 120_000
    || Date.parse(value.expiresAt) < Date.parse(now)
    || Date.parse(value.issuedAt) > Date.parse(now)
    || !NONCE.test(String(value.nonce))
  ) {
    throw new Error("Sanctuary host permit payload is invalid")
  }
  for (const [field, maximum] of [
    ["ownerUserId", 64],
    ["ownerChatId", 64],
    ["residentFriendId", 512],
    ["relationshipProfileId", 256],
    ["requestId", 512],
    ["sessionKey", 1_024],
    ["sessionEventId", 512],
    ["residentApprovalId", 512],
    ["targetResource", 256],
  ] as const) {
    if (!printable(value[field], maximum)) throw new Error(`Sanctuary host permit ${field} is invalid`)
  }
  if (!Number.isSafeInteger(value.relationshipProfileVersion) || (value.relationshipProfileVersion as number) < 1) {
    throw new Error("Sanctuary host permit relationship profile is invalid")
  }
  validateCommand(value.command, value.scriptDigest)
  if (value.verification !== null && (
    !isObject(value.verification)
    || !exactKeys(value.verification, ["profile", "expectedStateDigest"])
    || !printable(value.verification.profile, 128)
    || !DIGEST.test(String(value.verification.expectedStateDigest))
  )) {
    throw new Error("Sanctuary host permit verification is invalid")
  }
  if (value.stewardPolicy !== null && (
    !isObject(value.stewardPolicy)
    || !exactKeys(value.stewardPolicy, ["key", "version", "digest"])
    || !printable(value.stewardPolicy.key, 256)
    || !Number.isSafeInteger(value.stewardPolicy.version)
    || (value.stewardPolicy.version as number) < 1
    || !DIGEST.test(String(value.stewardPolicy.digest))
  )) {
    throw new Error("Sanctuary host permit steward policy is invalid")
  }
}

function validateAttempt(value: unknown): asserts value is HostSupervisorAttempt {
  if (
    !isObject(value)
    || !exactKeys(value, [
      "startedAt",
      "completedAt",
      "exitCode",
      "signal",
      "timedOut",
      "cancelled",
      "outputOverflow",
      "stdout",
      "stderr",
      "stdoutDigest",
      "stderrDigest",
      "stdoutBytes",
      "stderrBytes",
      "cleanup",
      "containment",
      "verificationBefore",
      "verificationAfter",
    ])
    || !validTime(value.startedAt)
    || !validTime(value.completedAt)
    || Date.parse(value.completedAt as string) < Date.parse(value.startedAt as string)
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || (value.signal !== null && !printable(value.signal, 32))
    || typeof value.timedOut !== "boolean"
    || typeof value.cancelled !== "boolean"
    || typeof value.outputOverflow !== "boolean"
    || typeof value.stdout !== "string"
    || typeof value.stderr !== "string"
    || !DIGEST.test(String(value.stdoutDigest))
    || !DIGEST.test(String(value.stderrDigest))
    || !Number.isSafeInteger(value.stdoutBytes)
    || (value.stdoutBytes as number) < 0
    || !Number.isSafeInteger(value.stderrBytes)
    || (value.stderrBytes as number) < 0
    || !["cgroup_empty", "cleanup_unproven"].includes(String(value.cleanup))
    || !["approved_root_may_escape", "unprovable_after_approved_root_migration"].includes(String(value.containment))
    || (value.verificationBefore !== null && (
      !isObject(value.verificationBefore)
      || !exactKeys(value.verificationBefore, ["digest"])
      || !DIGEST.test(String(value.verificationBefore.digest))
    ))
    || (value.verificationAfter !== null && (
      !isObject(value.verificationAfter)
      || !exactKeys(value.verificationAfter, ["matches", "digest"])
      || (value.verificationAfter.matches !== null && typeof value.verificationAfter.matches !== "boolean")
      || !DIGEST.test(String(value.verificationAfter.digest))
    ))
  ) {
    throw new Error("Sanctuary host supervisor attempt is invalid")
  }
}

export class SanctuaryHostPermitExecutor {
  readonly #options: SanctuaryHostPermitExecutorOptions
  #active = false

  constructor(options: SanctuaryHostPermitExecutorOptions) {
    if (!path.isAbsolute(options.stagingRoot)) throw new Error("Sanctuary host staging root must be absolute")
    if (!path.isAbsolute(options.stateRoot)) throw new Error("Sanctuary host execution state root must be absolute")
    this.#options = options
  }

  async execute(artifact: unknown): Promise<SignedAuthorityPayload<Record<string, unknown>>> {
    return this.#execute(artifact, false)
  }

  async reconcile(): Promise<SignedAuthorityPayload<Record<string, unknown>>[]> {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.#options.stateRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = []
      else throw error
    }
    const receipts: SignedAuthorityPayload<Record<string, unknown>>[] = []
    const permitIds: string[] = []
    for (const entry of entries.sort()) {
      if (entry.endsWith(ACKNOWLEDGED_SUFFIX)) {
        const permitId = entry.slice(0, -ACKNOWLEDGED_SUFFIX.length)
        if (!PERMIT_ID.test(permitId)) throw new Error("Sanctuary host execution acknowledgement entry is invalid")
        const ledger = this.#options.ledger.read(permitId)
        if (!ledger || ledger.state === "reserved") throw new Error("Sanctuary host execution acknowledgement is not terminal")
        this.#finishAcknowledgement(path.join(this.#options.stateRoot, entry))
        continue
      }
      const permitId = entry
      if (!PERMIT_ID.test(permitId)) throw new Error("Sanctuary host execution state entry is invalid")
      const ledger = this.#options.ledger.read(permitId)
      if (!ledger) {
        this.#discardUnreservedPublication(permitId)
        continue
      }
      permitIds.push(permitId)
      const artifact = this.#readArtifact(permitId, "permit.json")
      const receiptPath = this.#statePath(permitId, "receipt.json")
      const temporaryReceiptPath = `${receiptPath}.tmp`
      if (!fs.existsSync(receiptPath) && fs.existsSync(temporaryReceiptPath)) {
        const receipt = this.#verifiedReceipt(this.#readTemporaryArtifact(temporaryReceiptPath), permitId, ledger.permitDigest)
        fs.renameSync(temporaryReceiptPath, receiptPath)
        this.#syncDirectory(path.dirname(receiptPath))
        if (ledger.state === "reserved") {
          this.#options.ledger.terminalize({
            permitId,
            state: receipt.payload.state as "verified" | "failed" | "ambiguous",
            outcomeDigest: authorityArtifactDigest(receipt.domain, receipt.payload),
            updatedAt: receipt.payload.completedAt as string,
          })
        }
        this.#cleanupStaged(permitId)
        receipts.push(receipt)
        continue
      }
      if (fs.existsSync(receiptPath)) {
        const receipt = this.#verifiedReceipt(this.#readArtifact(permitId, "receipt.json"), permitId, ledger.permitDigest)
        if (ledger.state === "reserved") {
          this.#options.ledger.terminalize({
            permitId,
            state: receipt.payload.state as "verified" | "failed" | "ambiguous",
            outcomeDigest: authorityArtifactDigest(receipt.domain, receipt.payload),
            updatedAt: receipt.payload.completedAt as string,
          })
        }
        this.#cleanupStaged(permitId)
        receipts.push(receipt)
        continue
      }
      if (ledger.state !== "reserved") throw new Error(`Sanctuary host execution receipt is missing for ${permitId}`)
      receipts.push(await this.#execute(artifact, true))
    }
    await this.#options.supervisor.reconcileOrphans?.(permitIds)
    return receipts
  }

  acknowledge(permitId: string): void {
    if (!PERMIT_ID.test(permitId)) throw new Error("Sanctuary host permit id is invalid")
    const ledger = this.#options.ledger.read(permitId)
    if (!ledger || ledger.state === "reserved") throw new Error("Sanctuary host execution is not terminal")
    const root = path.join(this.#options.stateRoot, permitId)
    const acknowledgedRoot = `${root}${ACKNOWLEDGED_SUFFIX}`
    if (fs.existsSync(acknowledgedRoot)) {
      this.#finishAcknowledgement(acknowledgedRoot)
      return
    }
    if (!fs.existsSync(root)) return
    this.#options.supervisor.acknowledge?.(permitId)
    fs.renameSync(root, acknowledgedRoot)
    this.#syncStateRoot()
    this.#finishAcknowledgement(acknowledgedRoot)
  }

  async #execute(artifact: unknown, resume: boolean): Promise<SignedAuthorityPayload<Record<string, unknown>>> {
    if (this.#active) throw new Error("Sanctuary host execution is already active")
    const permit = verifyAuthorityPayload<HostExecutionPermitPayloadV1>({
      artifact,
      expectedDomain: PERMIT_DOMAIN,
      expectedKeyId: this.#options.expectedKeyId,
      publicKey: this.#options.publicKey,
    })
    const permitDigest = authorityArtifactDigest(PERMIT_DOMAIN, permit)
    const existing = resume ? this.#options.ledger.read(permit.permitId) : null
    if (resume && (existing!.state !== "reserved" || existing!.permitDigest !== permitDigest || existing!.nonce !== permit.nonce)) {
      throw new Error("Sanctuary host reserved permit binding changed")
    }
    const now = existing?.reservedAt ?? this.#now()
    validatePermit(permit, this.#options, now)
    if (!resume) {
      this.#writeArtifact(permit.permitId, "permit.json", artifact)
      this.#options.ledger.reserve({
        permitId: permit.permitId,
        nonce: permit.nonce,
        permitDigest,
        reservedAt: now,
      })
    }
    this.#active = true
    let stagedPath: string | null = null
    try {
      let executable: string
      let arguments_: string[]
      if (permit.command.kind === "script") {
        stagedPath = resume
          ? this.#resumeScript(permit.permitId, permit.command)
          : this.#stageScript(permit.permitId, permit.command)
        executable = permit.command.interpreter
        arguments_ = [...permit.command.arguments, stagedPath]
      } else {
        executable = permit.command.executable
        arguments_ = [...permit.command.arguments]
      }
      let attempt: HostSupervisorAttempt
      let errorCategory: string | null = null
      try {
        const operation = resume ? this.#options.supervisor.resume : this.#options.supervisor.execute
        if (!operation) throw new Error("Sanctuary host supervisor cannot resume reserved execution")
        attempt = await operation.call(this.#options.supervisor, {
          permit,
          permitArtifact: artifact as SignedAuthorityPayload<HostExecutionPermitPayloadV1>,
          executable,
          arguments: arguments_,
          cwd: "/",
          environment: CLEAN_ENVIRONMENT,
          timeoutMs: permit.timeoutMs,
        })
        validateAttempt(attempt)
      } catch {
        const failedAt = this.#now()
        attempt = {
          startedAt: now,
          completedAt: failedAt,
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          outputOverflow: false,
          stdout: "",
          stderr: "",
          stdoutDigest: digest(""),
          stderrDigest: digest(""),
          stdoutBytes: 0,
          stderrBytes: 0,
          cleanup: "cleanup_unproven",
          containment: "approved_root_may_escape",
          verificationBefore: null,
          verificationAfter: null,
        }
        errorCategory = "supervisor_failure"
      }
      const outputOverflow = attempt.outputOverflow
        || Buffer.byteLength(attempt.stdout, "utf8") > OUTPUT_LIMIT
        || Buffer.byteLength(attempt.stderr, "utf8") > OUTPUT_LIMIT
      if (attempt.cleanup !== "cgroup_empty") {
        throw new Error("Sanctuary host execution cleanup requires reconciliation")
      }
      const state = errorCategory
        || attempt.timedOut
        || attempt.cancelled
        || outputOverflow
        || attempt.exitCode !== 0
        || attempt.signal !== null
        ? "failed"
        : permit.verification && attempt.verificationAfter?.matches !== true
          ? "ambiguous"
          : "verified"
      const receipt = signAuthorityPayload({
        domain: RECEIPT_DOMAIN,
        keyId: this.#options.expectedKeyId,
        privateKey: this.#options.privateKey,
        payload: {
          targetHost: this.#options.expectedTargetHost,
          permitId: permit.permitId,
          permitDigest,
          registrationId: permit.registrationId,
          state,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
          exitCode: attempt.exitCode,
          signal: attempt.signal,
          timedOut: attempt.timedOut,
          cancelled: attempt.cancelled,
          outputOverflow,
          stdoutDigest: attempt.stdoutDigest,
          stderrDigest: attempt.stderrDigest,
          stdoutBytes: attempt.stdoutBytes,
          stderrBytes: attempt.stderrBytes,
          stdoutExcerpt: attempt.stdout.slice(0, EXCERPT_LIMIT),
          stderrExcerpt: attempt.stderr.slice(0, EXCERPT_LIMIT),
          cleanup: attempt.cleanup,
          containment: attempt.containment,
          verificationBefore: attempt.verificationBefore,
          verificationAfter: attempt.verificationAfter,
          errorCategory,
          publicKeyDigest: this.#options.expectedPublicKeyDigest,
        },
      })
      this.#writeArtifact(permit.permitId, "receipt.json", receipt)
      this.#options.ledger.terminalize({
        permitId: permit.permitId,
        state,
        outcomeDigest: authorityArtifactDigest(receipt.domain, receipt.payload),
        updatedAt: attempt.completedAt,
      })
      if (stagedPath) fs.unlinkSync(stagedPath)
      return receipt
    } finally {
      this.#active = false
    }
  }

  #statePath(permitId: string, name: "permit.json" | "receipt.json"): string {
      return path.join(this.#options.stateRoot, permitId, name)
    }

  #writeArtifact(permitId: string, name: "permit.json" | "receipt.json", value: unknown): void {
      const filePath = this.#statePath(permitId, name)
      const bytes = `${JSON.stringify(value)}\n`
      const root = path.dirname(filePath)
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      fs.chmodSync(root, 0o700)
      if (fs.existsSync(filePath)) {
        if (fs.readFileSync(filePath, "utf8") !== bytes) throw new Error(`Sanctuary host ${name} changed`)
        return
      }
      const temporaryPath = `${filePath}.tmp`
      if (fs.existsSync(temporaryPath)) throw new Error(`Sanctuary host ${name} temporary publication exists`)
      const descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600,
      )
      try {
        fs.writeFileSync(descriptor, bytes, "utf8")
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(temporaryPath, filePath)
      this.#syncDirectory(root)
    }

  #readArtifact(permitId: string, name: "permit.json" | "receipt.json"): unknown {
      const filePath = this.#statePath(permitId, name)
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`Sanctuary host ${name} metadata is invalid`)
      }
      const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        return JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown
      } finally {
        fs.closeSync(descriptor)
      }
    }

  #readTemporaryArtifact(filePath: string): unknown {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("Sanctuary host temporary artifact metadata is invalid")
      }
      const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        return JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown
      } finally {
        fs.closeSync(descriptor)
      }
    }

  #verifiedReceipt(artifact: unknown, permitId: string, permitDigest: string): SignedAuthorityPayload<Record<string, unknown>> {
      const payload = verifyAuthorityPayload<Record<string, unknown>>({
        artifact,
        expectedDomain: RECEIPT_DOMAIN,
        expectedKeyId: this.#options.expectedKeyId,
        publicKey: this.#options.publicKey,
      })
      if (
        payload.permitId !== permitId
        || payload.permitDigest !== permitDigest
        || !["verified", "failed", "ambiguous"].includes(String(payload.state))
        || !validTime(payload.completedAt)
      ) {
        throw new Error("Sanctuary host durable receipt binding changed")
      }
      return artifact as SignedAuthorityPayload<Record<string, unknown>>
    }

  #cleanupStaged(permitId: string): void {
      const stagedPath = path.join(this.#options.stagingRoot, `${permitId}.script`)
      try { fs.unlinkSync(stagedPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
  }

  #finishAcknowledgement(root: string): void {
      const entries = fs.readdirSync(root)
      if (entries.some((name) => !["permit.json", "receipt.json"].includes(name))) {
        throw new Error("Sanctuary host execution acknowledgement contents changed")
      }
      for (const name of entries) fs.unlinkSync(path.join(root, name))
      fs.rmdirSync(root)
      this.#syncStateRoot()
  }

  #syncStateRoot(): void {
      this.#syncDirectory(this.#options.stateRoot)
  }

  #syncDirectory(directory: string): void {
      const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
    }
  }

  #discardUnreservedPublication(permitId: string): void {
    const root = path.join(this.#options.stateRoot, permitId)
    const entries = fs.readdirSync(root)
    if (entries.some((name) => !["permit.json", "permit.json.tmp"].includes(name))) {
        throw new Error(`Sanctuary host execution ledger is missing for ${permitId}`)
    }
    for (const name of entries) fs.unlinkSync(path.join(root, name))
    fs.rmdirSync(root)
    this.#syncStateRoot()
  }

  #stageScript(permitId: string, command: Extract<HostCommandV1, { kind: "script" }>): string {
    fs.mkdirSync(this.#options.stagingRoot, { recursive: true, mode: 0o700 })
    const root = fs.lstatSync(this.#options.stagingRoot)
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700) {
      throw new Error("Sanctuary host staging root metadata is invalid")
    }
    const target = path.join(this.#options.stagingRoot, `${permitId}.script`)
    const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o700)
    try {
      fs.writeFileSync(descriptor, command.script, "utf8")
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return target
  }

  #resumeScript(permitId: string, command: Extract<HostCommandV1, { kind: "script" }>): string {
    const target = path.join(this.#options.stagingRoot, `${permitId}.script`)
    if (!fs.existsSync(target)) return this.#stageScript(permitId, command)
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw new Error("Sanctuary host staged script metadata is invalid")
    }
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (fs.readFileSync(descriptor, "utf8") !== command.script) {
        throw new Error("Sanctuary host staged script changed")
      }
    } finally {
      fs.closeSync(descriptor)
    }
    return target
  }

  #now(): string {
    const value = this.#options.now?.() ?? new Date().toISOString()
    if (!validTime(value)) throw new Error("Sanctuary host executor time is invalid")
    return value
  }
}
