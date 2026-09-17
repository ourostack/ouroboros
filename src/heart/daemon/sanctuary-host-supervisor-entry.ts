#!/usr/bin/env node
import { createHash, createPublicKey } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

import type { HostExecutionPermitPayloadV1, HostSupervisorAttempt } from "./sanctuary-host-executor"
import { verifyAuthorityPayload, type SignedAuthorityPayload } from "./sanctuary-authority-codec"
import { LinuxSanctuaryHostSupervisorKernel } from "./sanctuary-host-linux-kernel"
import { KernelSanctuaryHostSupervisor } from "./sanctuary-host-supervisor"
import type { SanctuaryHostSupervisorKernel } from "./sanctuary-host-supervisor"

const DIGEST = /^sha256:[a-f0-9]{64}$/u

interface DetachedSupervisorSpec {
  schemaVersion: 1
  permitId: string
  permitArtifact: SignedAuthorityPayload<HostExecutionPermitPayloadV1>
  keyId: string
  publicKeyPem: string
  executable: string
  arguments: string[]
  cwd: "/"
  environment: Readonly<Record<string, string>>
  timeoutMs: number
  cgroupRoot: string
  launcherPath: string
  launcherDigest: string
  prlimitPath: string
  prlimitDigest: string
  setsidPath: string
  setsidDigest: string
  shellPath: string
  shellDigest: string
  supervisorProgramPath: string
  supervisorProgramDigest: string
  readyPath: string
  terminalPath: string
  lockPath: string
  spawnPath: string
  startPath: string
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function readPrivateSpec(specPath: string, expectedUid: number): { bytes: string; spec: DetachedSupervisorSpec } {
  if (!path.isAbsolute(specPath)) throw new Error("Sanctuary host supervisor spec path must be absolute")
  const stat = fs.lstatSync(specPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Sanctuary host supervisor spec metadata is invalid")
  }
  const descriptor = fs.openSync(specPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const bytes = fs.readFileSync(descriptor, "utf8")
    const spec = JSON.parse(bytes) as DetachedSupervisorSpec
    if (
      spec.schemaVersion !== 1
      || spec.permitId !== spec.permitArtifact?.payload?.permitId
      || !Array.isArray(spec.arguments)
      || spec.cwd !== "/"
      || !Number.isSafeInteger(spec.timeoutMs)
      || spec.timeoutMs < 1_000
      || spec.timeoutMs > 900_000
    ) {
      throw new Error("Sanctuary host supervisor spec is invalid")
    }
    return { bytes, spec }
  } finally {
    fs.closeSync(descriptor)
  }
}

function assertDigest(filePath: string, expectedDigest: string, expectedUid: number): void {
  const stat = fs.lstatSync(filePath)
  if (
    !DIGEST.test(expectedDigest)
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || (stat.mode & 0o111) === 0
    || (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`Sanctuary host supervisor primitive metadata is invalid: ${filePath}`)
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (digest(fs.readFileSync(descriptor)) === expectedDigest) return
  } finally {
    fs.closeSync(descriptor)
  }
  {
    throw new Error(`Sanctuary host supervisor primitive digest changed: ${filePath}`)
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(filePath), 0o700)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }

  fs.renameSync(temporaryPath, filePath)
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_host_supervisor_state_written", message: "Sanctuary host supervisor state atomically written" })
  fs.chmodSync(filePath, 0o600)
}

async function waitForStart(filePath: string, permitId: string, specDigest: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
      if (value.schemaVersion !== 1 || value.permitId !== permitId || value.specDigest !== specDigest) {
        throw new Error("Sanctuary host supervisor start gate is invalid")
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Sanctuary host supervisor start gate timed out")
}

export async function runSanctuaryHostSupervisor(specPath: string, options: {
  expectedUid?: number
  processId?: number
  bootId?: () => string
  processStartTime?: (pid: number) => string
  kernel?: SanctuaryHostSupervisorKernel
  getuid?: () => number
} = {}): Promise<HostSupervisorAttempt> {
  const expectedUid = options.expectedUid ?? 0
  if ((options.getuid ?? (process.getuid as () => number))() !== expectedUid) throw new Error("Sanctuary host supervisor must run as root")
  const { bytes, spec } = readPrivateSpec(specPath, expectedUid)
  const publicKey = createPublicKey(spec.publicKeyPem)
  const permit = verifyAuthorityPayload<HostExecutionPermitPayloadV1>({
    artifact: spec.permitArtifact,
    expectedDomain: "ouro.sanctuary.host-permit.v1",
    expectedKeyId: spec.keyId,
    publicKey,
  })
  const publicKeyDigest = `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`
  if (publicKeyDigest !== permit.publicKeyDigest) {
    throw new Error("Sanctuary host supervisor permit key digest changed")
  }
  assertDigest(spec.launcherPath, spec.launcherDigest, expectedUid)
  assertDigest(spec.prlimitPath, spec.prlimitDigest, expectedUid)
  assertDigest(spec.setsidPath, spec.setsidDigest, expectedUid)
  assertDigest(spec.shellPath, spec.shellDigest, expectedUid)
  assertDigest(spec.supervisorProgramPath, spec.supervisorProgramDigest, expectedUid)
  const specDigest = digest(bytes)
  const processId = options.processId ?? process.pid
  const bootId = options.bootId?.() ?? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  const processStartTime = options.processStartTime?.(processId)
    ?? fs.readFileSync(`/proc/${processId}/stat`, "utf8").trim().split(" ")[21]
    ?? ""
  const binding = {
    schemaVersion: 1,
    permitId: spec.permitId,
    specDigest,
    supervisorPid: processId,
    bootId,
    processStartTime,
  }
  await waitForStart(spec.startPath, spec.permitId, specDigest)
  const lock = fs.openSync(spec.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, permitId: spec.permitId, supervisorPid: processId })}\n`, "utf8")
    fs.fsyncSync(lock)
    writePrivateJson(spec.readyPath, binding)
    const kernel = options.kernel ?? new LinuxSanctuaryHostSupervisorKernel({
      cgroupRoot: spec.cgroupRoot,
      shellPath: spec.shellPath,
      launcherPath: spec.launcherPath,
      prlimitPath: spec.prlimitPath,
      setsidPath: spec.setsidPath,
    })
    const supervisor = new KernelSanctuaryHostSupervisor(kernel)
    const attempt = await supervisor.execute({
      permit,
      permitArtifact: spec.permitArtifact,
      executable: spec.executable,
      arguments: spec.arguments,
      cwd: spec.cwd,
      environment: spec.environment,
      timeoutMs: spec.timeoutMs,
    })
    writePrivateJson(spec.terminalPath, { ...binding, attempt })
    return attempt
  } finally {
    fs.closeSync(lock)
    fs.rmSync(spec.lockPath, { force: true })
  }
}

export async function runSanctuaryHostSupervisorCli(
  argv = process.argv,
  run: (specPath: string) => Promise<HostSupervisorAttempt> = runSanctuaryHostSupervisor,
): Promise<void> {
  const index = argv.indexOf("--spec")
  const specPath = index >= 0 ? argv[index + 1] : undefined
  if (!specPath) throw new Error("Sanctuary host supervisor requires --spec")
  await run(specPath)
}

/* v8 ignore next 6 -- executable guard delegates to the tested CLI runner @preserve */
if (require.main === module) {
  void runSanctuaryHostSupervisorCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Sanctuary host supervisor failed"}\n`)
    process.exitCode = 1
  })
}
