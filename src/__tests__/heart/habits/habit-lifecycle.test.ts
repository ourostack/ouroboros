import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import {
  HABIT_LIFECYCLE_POLL_MS,
  HABIT_LIFECYCLE_TIMEOUT_MS,
  HabitLifecycleError,
  acquireHabitLifecycleLock,
  buildHabitCancellationOperation,
  buildHabitEvidenceIdentity,
  buildHabitLifecycleOwner,
  buildHabitSendOperation,
  classifyHabitLifecycleOwner,
  createHabitLifecycleJournal,
  getHabitLifecyclePaths,
  probeHabitBootIdentity,
  probeHabitProcessLiveness,
  probeHabitProcessStartedAt,
  publishHabitLifecycleReceipt,
  readHabitLifecycleJournal,
  readHabitLifecycleReceipt,
  releaseHabitLifecycleLock,
  serializeHabitLifecycleJson,
  transitionHabitLifecycleJournal,
  writeHabitLifecycleDefinition,
  writeHabitLifecycleJournal,
  type HabitLifecycleDeps,
  type HabitCancellationReceipt,
  type HabitLifecycleJournal,
  type HabitLifecycleLease,
} from "../../../heart/habits/habit-lifecycle"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

const FIXED_NOW = "2026-07-31T20:30:00.000Z"
const NEXT_NOW = "2026-07-31T20:30:01.000Z"
const THIRD_NOW = "2026-07-31T20:30:02.000Z"
const FOURTH_NOW = "2026-07-31T20:30:03.000Z"
const CAPTURE_HASH = "a".repeat(64)
const TEST_ROOTS: string[] = []
const ACTIVE_CHILDREN = new Set<ReturnType<typeof spawn>>()

function makeRoot(prefix = "habit-lifecycle-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TEST_ROOTS.push(root)
  return root
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function fixedDeps(overrides: HabitLifecycleDeps = {}): HabitLifecycleDeps {
  return {
    now: () => new Date(FIXED_NOW),
    pid: () => 4242,
    bootIdentity: () => "boot-current",
    processStartedAt: () => "process-current",
    processLiveness: () => "alive",
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  }
}

function owner(operationId = "cancel:demo") {
  return buildHabitLifecycleOwner({
    operationId,
    pid: 4242,
    bootIdentity: "boot-current",
    processStartedAt: "process-current",
    acquiredAt: FIXED_NOW,
  })
}

function expectLifecycleError(error: unknown, code: string, durabilityUnknown = false): void {
  expect(error).toBeInstanceOf(HabitLifecycleError)
  expect(error).toMatchObject({ code, durabilityUnknown })
}

function fsWithFault(method: keyof typeof fs, occurrence = 1): typeof fs {
  let calls = 0
  return new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== method || typeof value !== "function") return value
      return (...args: unknown[]) => {
        calls += 1
        if (calls === occurrence) {
          const failure = new Error(`injected ${String(method)} failure`) as NodeJS.ErrnoException
          failure.code = "EIO"
          throw failure
        }
        return Reflect.apply(value, target, args)
      }
    },
  }) as typeof fs
}

function codedError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

function tracingFs(
  operations: string[],
  failure?: { operation: string; occurrence?: number; code?: string },
): typeof fs {
  const openedPaths = new Map<number, string>()
  let matchingCalls = 0
  const maybeFail = (operation: string): void => {
    if (failure?.operation !== operation) return
    matchingCalls += 1
    if (matchingCalls === (failure.occurrence ?? 1)) throw codedError(failure.code ?? "EIO")
  }
  const adapter = Object.create(fs) as Record<string, unknown>
  adapter.openSync = (...args: unknown[]) => {
    const renderedPath = String(args[0])
    operations.push(`open:${path.basename(renderedPath)}:${String(args[1])}`)
    maybeFail("openSync")
    const fd = Reflect.apply(fs.openSync, fs, args) as number
    openedPaths.set(fd, renderedPath)
    return fd
  }
  adapter.writeFileSync = (...args: unknown[]) => {
    const target = typeof args[0] === "number"
      ? path.basename(openedPaths.get(args[0]) ?? String(args[0]))
      : path.basename(String(args[0]))
    operations.push(`write:${target}`)
    maybeFail("write")
    return Reflect.apply(fs.writeFileSync, fs, args)
  }
  adapter.writeSync = (...args: unknown[]) => {
    operations.push(`write:${path.basename(openedPaths.get(Number(args[0])) ?? String(args[0]))}`)
    maybeFail("write")
    return Reflect.apply(fs.writeSync, fs, args)
  }
  adapter.fsyncSync = (...args: unknown[]) => {
    operations.push(`fsync:${path.basename(openedPaths.get(Number(args[0])) ?? String(args[0]))}`)
    maybeFail("fsyncSync")
    return Reflect.apply(fs.fsyncSync, fs, args)
  }
  adapter.closeSync = (...args: unknown[]) => {
    const fd = Number(args[0])
    operations.push(`close:${path.basename(openedPaths.get(fd) ?? String(fd))}`)
    maybeFail("closeSync")
    const result = Reflect.apply(fs.closeSync, fs, args)
    openedPaths.delete(fd)
    return result
  }
  adapter.renameSync = (...args: unknown[]) => {
    operations.push(`rename:${path.basename(String(args[0]))}->${path.basename(String(args[1]))}`)
    maybeFail("renameSync")
    return Reflect.apply(fs.renameSync, fs, args)
  }
  adapter.linkSync = (...args: unknown[]) => {
    operations.push(`link:${path.basename(String(args[0]))}->${path.basename(String(args[1]))}`)
    maybeFail("linkSync")
    return Reflect.apply(fs.linkSync, fs, args)
  }
  adapter.unlinkSync = (...args: unknown[]) => {
    operations.push(`unlink:${path.basename(String(args[0]))}`)
    maybeFail("unlinkSync")
    return Reflect.apply(fs.unlinkSync, fs, args)
  }
  return adapter as typeof fs
}

function expectAtomicSequence(
  operations: string[],
  input: { finalPath: string; directoryPath: string; publication: "rename" | "link"; cleanupTemp: boolean },
): void {
  const tempOpen = operations.find((entry) => entry.startsWith("open:") && entry.endsWith(":wx"))
  expect(tempOpen).toBeDefined()
  const tempBasename = tempOpen!.slice("open:".length, -":wx".length)
  expect(tempBasename).toMatch(/\.tmp$/)
  const finalBasename = path.basename(input.finalPath)
  const directoryBasename = path.basename(input.directoryPath)
  const normalized = operations.map((entry) => entry
    .replaceAll(tempBasename, "<temp>")
    .replaceAll(finalBasename, "<final>")
    .replaceAll(directoryBasename, "<directory>"))
  expect(normalized).toEqual([
    "open:<temp>:wx",
    "write:<temp>",
    "fsync:<temp>",
    "close:<temp>",
    `${input.publication}:<temp>-><final>`,
    "open:<directory>:r",
    "fsync:<directory>",
    "close:<directory>",
    ...(input.cleanupTemp ? ["unlink:<temp>"] : []),
  ])
}

function cancellationReceipt(
  captureKeyHash = CAPTURE_HASH,
  overrides: Partial<HabitCancellationReceipt> = {},
): HabitCancellationReceipt {
  const { evidenceKeyHash } = buildHabitEvidenceIdentity({
    habitId: "rsvp-demo",
    kind: "capture",
    id: captureKeyHash,
  })
  return {
    schemaVersion: 1,
    habitId: "rsvp-demo",
    operationId: `cancel:${evidenceKeyHash}`,
    evidenceKeyHash,
    evidenceLocator: { kind: "capture", id: captureKeyHash },
    actor: { displayName: "Ari", provider: "bluebubbles", externalId: "synthetic-handle" },
    request: {
      text: "Please end this report.",
      sha256: sha256("Please end this report."),
      observedAt: FIXED_NOW,
    },
    transition: {
      fromStatus: "active",
      toStatus: "cancelled",
      cancelledAt: THIRD_NOW,
      boundaryState: "not_crossed",
    },
    acknowledgement: "Cancelled habit \"rsvp-demo\" from confirmed requester \"Ari\". No concurrent send crossed the transport boundary.",
    createdAt: THIRD_NOW,
    ...overrides,
  }
}

async function waitForPath(filePath: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now()
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for ${filePath}`)
    await sleep(10)
  }
}

function spawnLifecycleChild(input: {
  mode: "lock" | "abandon" | "receipt" | "coordination"
  agentRoot: string
  readyPath: string
  startPath: string
  resultPath: string
  habitId?: string
  operationId?: string
  releasePath?: string
  lease?: HabitLifecycleLease
  evidenceKeyHash?: string
  receipt?: HabitCancellationReceipt
  precommitPath?: string
  peerPrecommitPath?: string
  attemptingPath?: string
}): { child: ReturnType<typeof spawn>; completion: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const repoRoot = process.cwd()
  const fixture = path.join(repoRoot, "src", "__tests__", "fixtures", "habits", "habit-lifecycle-child-process.test.ts")
  const child = spawn(process.execPath, [
    path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
    "run",
    fixture,
    "--config",
    path.join(repoRoot, "vitest.config.ts"),
    "--pool",
    "threads",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HABIT_LIFECYCLE_CHILD_MODE: input.mode,
      HABIT_LIFECYCLE_CHILD_AGENT_ROOT: input.agentRoot,
      HABIT_LIFECYCLE_CHILD_READY: input.readyPath,
      HABIT_LIFECYCLE_CHILD_START: input.startPath,
      HABIT_LIFECYCLE_CHILD_RESULT: input.resultPath,
      HABIT_LIFECYCLE_CHILD_HABIT_ID: input.habitId ?? "",
      HABIT_LIFECYCLE_CHILD_OPERATION_ID: input.operationId ?? "",
      HABIT_LIFECYCLE_CHILD_RELEASE: input.releasePath ?? "",
      HABIT_LIFECYCLE_CHILD_LEASE: input.lease ? JSON.stringify(input.lease) : "",
      HABIT_LIFECYCLE_CHILD_EVIDENCE_HASH: input.evidenceKeyHash ?? "",
      HABIT_LIFECYCLE_CHILD_RECEIPT: input.receipt ? JSON.stringify(input.receipt) : "",
      HABIT_LIFECYCLE_CHILD_PRECOMMIT: input.precommitPath ?? "",
      HABIT_LIFECYCLE_CHILD_PEER_PRECOMMIT: input.peerPrecommitPath ?? "",
      HABIT_LIFECYCLE_CHILD_ATTEMPTING: input.attemptingPath ?? `${input.resultPath}.attempting`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  ACTIVE_CHILDREN.add(child)
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      ACTIVE_CHILDREN.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
  return { child, completion }
}

afterEach(async () => {
  const liveChildren = [...ACTIVE_CHILDREN].filter((child) => child.exitCode === null && child.signalCode === null)
  const closed = liveChildren.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve())))
  for (const child of liveChildren) child.kill("SIGKILL")
  await Promise.all(closed)
  ACTIVE_CHILDREN.clear()
  for (const root of TEST_ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("habit lifecycle filesystem protocol", () => {
  it("derives every fixed root, journal, receipt, evidence, cancellation, and send identity", () => {
    const agentRoot = "/tmp/bundles/demo.ouro"
    const evidence = buildHabitEvidenceIdentity({ habitId: "rsvp-demo", kind: "capture", id: CAPTURE_HASH })
    const cancellation = buildHabitCancellationOperation(evidence.evidenceKeyHash)
    const send = buildHabitSendOperation({ habitId: "rsvp-demo", outboundIdempotencyKey: "outbound-demo" })
    const paths = getHabitLifecyclePaths({
      agentRoot,
      habitId: "rsvp-demo",
      operationId: cancellation.operationId,
      evidenceKeyHash: evidence.evidenceKeyHash,
    })

    expect(HABIT_LIFECYCLE_POLL_MS).toBe(50)
    expect(HABIT_LIFECYCLE_TIMEOUT_MS).toBe(5_000)
    expect(evidence).toEqual({
      canonicalKey: `["habit-evidence-v1","rsvp-demo","capture","${CAPTURE_HASH}"]`,
      evidenceKeyHash: "53d7e3529f2a7b803a803442c45b119349346dc6d59aa7ee0b40795be7df540c",
    })
    expect(cancellation).toEqual({
      operationId: "cancel:53d7e3529f2a7b803a803442c45b119349346dc6d59aa7ee0b40795be7df540c",
      operationIdHash: "4a770cadbbc94f723e529dcd5204de62074baba8480a4e9838e220071d1a1ed3",
    })
    expect(send).toEqual({
      canonicalKey: `["habit-send-v1","rsvp-demo","outbound-demo"]`,
      operationHash: "be1329e1ddf5a557c5ab240b951557c6b52326e17e39b5de279c82ed998a94e2",
      operationId: "send:be1329e1ddf5a557c5ab240b951557c6b52326e17e39b5de279c82ed998a94e2",
    })
    expect(paths).toEqual({
      root: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101"),
      coordination: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "coordination.sqlite"),
      owner: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "owner.lock"),
      journalDirectory: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "journal"),
      journal: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "journal", `${cancellation.operationIdHash}.json`),
      receiptsDirectory: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "receipts"),
      receipt: path.join(agentRoot, "state", "habits", "lifecycle", "65a7a2f287b997927c0d3beb72cf7908d6ea2476a60ef80b3aaacf70eb531101", "receipts", `${evidence.evidenceKeyHash}.json`),
    })
    expect(() => getHabitLifecyclePaths({ agentRoot, habitId: "../escape" })).toThrow(/habit_id_invalid/)
    expect(() => getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", operationId: "\0bad" })).toThrow(/operation_id_invalid/)
    for (const invalidHash of ["b".repeat(63), "B".repeat(64), "../receipt", `${"b".repeat(64)}/escape`]) {
      expect(() => getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: invalidHash }))
        .toThrow(/evidence_key_hash_invalid/)
    }
    expect(() => buildHabitSendOperation({ habitId: "rsvp-demo", outboundIdempotencyKey: " " })).toThrow(/outbound_idempotency_key_required/)
  })

  it("serializes owner and journal records with exact fields, order, nulls, transitions, and generations", () => {
    const exactOwner = owner()
    expect(exactOwner).toEqual({
      schemaVersion: 1,
      operationId: "cancel:demo",
      pid: 4242,
      bootIdentity: "boot-current",
      processStartedAt: "process-current",
      acquiredAt: FIXED_NOW,
    })
    expect(serializeHabitLifecycleJson(exactOwner)).toBe(`${JSON.stringify(exactOwner, null, 2)}\n`)

    const initial = createHabitLifecycleJournal({
      habitId: "rsvp-demo",
      operationId: "cancel:demo",
      operationKind: "cancel",
      updatedAt: FIXED_NOW,
    })
    expect(initial).toEqual({
      schemaVersion: 1,
      habitId: "rsvp-demo",
      operationId: "cancel:demo",
      operationKind: "cancel",
      state: "lock_acquired",
      updatedAt: FIXED_NOW,
      generation: 0,
      evidenceKeyHash: null,
      intentAt: null,
      transportInvokedAt: null,
      classifiedAt: null,
      boundaryState: null,
      transportResult: null,
    })
    const intent = transitionHabitLifecycleJournal(initial, {
      state: "cancellation_intent",
      at: NEXT_NOW,
      evidenceKeyHash: "b".repeat(64),
    })
    const definition = transitionHabitLifecycleJournal(intent, {
      state: "definition_cancelled",
      at: THIRD_NOW,
      boundaryState: "not_crossed",
    })
    const receipt = transitionHabitLifecycleJournal(definition, {
      state: "cancellation_receipt_committed",
      at: FOURTH_NOW,
    })
    expect([initial, intent, definition, receipt].map((entry) => [entry.state, entry.generation])).toEqual([
      ["lock_acquired", 0],
      ["cancellation_intent", 1],
      ["definition_cancelled", 2],
      ["cancellation_receipt_committed", 3],
    ])
    expect(receipt).toMatchObject({
      evidenceKeyHash: "b".repeat(64),
      intentAt: NEXT_NOW,
      classifiedAt: THIRD_NOW,
      boundaryState: "not_crossed",
      transportInvokedAt: null,
      transportResult: null,
    })

    const sendTerminalRecords: HabitLifecycleJournal[] = []
    for (const terminal of ["not_crossed", "crossing_unknown", "crossed"] as const) {
      const sendInitial = createHabitLifecycleJournal({
        habitId: "rsvp-demo",
        operationId: `send:${terminal}`,
        operationKind: "send",
        updatedAt: FIXED_NOW,
      })
      const sendIntent = transitionHabitLifecycleJournal(sendInitial, { state: "send_intent", at: NEXT_NOW })
      const sent = transitionHabitLifecycleJournal(sendIntent, {
        state: terminal,
        at: THIRD_NOW,
        transportInvokedAt: terminal === "not_crossed" ? null : NEXT_NOW,
        transportResult: { httpStatus: terminal === "crossed" ? 200 : null, messageGuid: terminal === "crossed" ? "guid-demo" : null, errorCode: terminal === "crossed" ? null : "demo" },
      })
      sendTerminalRecords.push(sent)
      expect(sent).toMatchObject({ state: terminal, generation: 2, classifiedAt: THIRD_NOW, boundaryState: terminal })
    }

    expect(() => transitionHabitLifecycleJournal(initial, { state: "send_intent", at: NEXT_NOW })).toThrow(/lifecycle_transition_invalid/)
    expect(() => transitionHabitLifecycleJournal(receipt, { state: "cancellation_intent", at: NEXT_NOW, evidenceKeyHash: "b".repeat(64) })).toThrow(/lifecycle_transition_invalid/)

    const sendInitial = createHabitLifecycleJournal({
      habitId: "rsvp-demo",
      operationId: "send:matrix",
      operationKind: "send",
      updatedAt: FIXED_NOW,
    })
    const sendIntent = transitionHabitLifecycleJournal(sendInitial, { state: "send_intent", at: NEXT_NOW })
    const stateRecords: HabitLifecycleJournal[] = [
      initial,
      intent,
      definition,
      receipt,
      sendInitial,
      sendIntent,
      ...sendTerminalRecords,
    ]
    const nextInputs = [
      { state: "lock_acquired", at: FOURTH_NOW },
      { state: "cancellation_intent", at: FOURTH_NOW, evidenceKeyHash: "b".repeat(64) },
      { state: "definition_cancelled", at: FOURTH_NOW, boundaryState: "not_crossed" },
      { state: "cancellation_receipt_committed", at: FOURTH_NOW },
      { state: "send_intent", at: FOURTH_NOW },
      { state: "not_crossed", at: FOURTH_NOW, transportInvokedAt: null, transportResult: { httpStatus: null, messageGuid: null, errorCode: "rejected" } },
      { state: "crossing_unknown", at: FOURTH_NOW, transportInvokedAt: NEXT_NOW, transportResult: { httpStatus: null, messageGuid: null, errorCode: "timeout" } },
      { state: "crossed", at: FOURTH_NOW, transportInvokedAt: NEXT_NOW, transportResult: { httpStatus: 200, messageGuid: "guid-demo", errorCode: null } },
    ] as const
    const permitted = new Set([
      "cancel:lock_acquired->cancellation_intent",
      "cancel:cancellation_intent->definition_cancelled",
      "cancel:definition_cancelled->cancellation_receipt_committed",
      "send:lock_acquired->send_intent",
      "send:send_intent->not_crossed",
      "send:send_intent->crossing_unknown",
      "send:send_intent->crossed",
    ])
    for (const record of stateRecords) {
      for (const next of nextInputs) {
        const edge = `${record.operationKind}:${record.state}->${next.state}`
        if (permitted.has(edge)) continue
        expect(() => transitionHabitLifecycleJournal(record, next), edge).toThrow(/lifecycle_transition_invalid/)
      }
    }
  })

  it("uses exact default boot, process-start, and liveness probes and classifies every owner boundary", () => {
    const darwinOutput = "{ sec = 123, usec = 456 } Thu Jul 31 20:00:00 2026\n"
    const windowsOutput = "638922384000000000\r\n"
    const baseOwner = owner()

    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps())).toBe("live")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ bootIdentity: () => "different-boot" }))).toBe("recoverable")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ processLiveness: () => "missing" }))).toBe("recoverable")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ processStartedAt: () => "reused-process" }))).toBe("recoverable")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ processLiveness: () => "unknown" }))).toBe("unknown")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ processStartedAt: () => null }))).toBe("unknown")
    expect(classifyHabitLifecycleOwner(baseOwner, fixedDeps({ bootIdentity: () => { throw new Error("probe failed") } }))).toBe("unknown")
    expect(classifyHabitLifecycleOwner({ ...baseOwner, acquiredAt: "2000-01-01T00:00:00.000Z" }, fixedDeps())).toBe("live")

    const linuxStat = `900 (synthetic worker) ${Array.from({ length: 20 }, (_, index) => String(index + 1)).join(" ")}\n`
    const linuxFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== "readFileSync") return Reflect.get(target, property, receiver)
        return (filePath: fs.PathOrFileDescriptor, encoding: BufferEncoding) => {
          expect(encoding).toBe("utf8")
          if (filePath === "/proc/sys/kernel/random/boot_id") return "linux-boot-id\n"
          if (filePath === "/proc/900/stat") return linuxStat
          throw codedError("ENOENT")
        }
      },
    }) as typeof fs
    expect(probeHabitBootIdentity({ platform: "linux", fs: linuxFs })).toBe("linux-boot-id")
    expect(probeHabitProcessStartedAt(900, { platform: "linux", fs: linuxFs })).toBe("linux:20")
    expect(probeHabitProcessStartedAt(901, { platform: "linux", fs: linuxFs })).toBeNull()

    const darwinRun = ((file: string, args: readonly string[], options: object) => {
      expect([file, args, options]).toEqual([
        "/usr/sbin/sysctl",
        ["-n", "kern.boottime"],
        { encoding: "utf8" },
      ])
      return darwinOutput
    }) as typeof execFileSync
    expect(probeHabitBootIdentity({ platform: "darwin", execFileSync: darwinRun })).toBe(sha256(darwinOutput))

    const processOutput = "Thu Jul 31 20:00:01 2026\n"
    const processRun = ((file: string, args: readonly string[], options: object) => {
      expect([file, args, options]).toEqual([
        "/bin/ps",
        ["-o", "lstart=", "-p", "900"],
        { encoding: "utf8" },
      ])
      return processOutput
    }) as typeof execFileSync
    expect(probeHabitProcessStartedAt(900, { platform: "darwin", execFileSync: processRun }))
      .toBe("darwin:Thu Jul 31 20:00:01 2026")

    const windowsBootRun = ((file: string, args: readonly string[], options: object) => {
      expect([file, args, options]).toEqual([
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks"],
        { encoding: "utf8" },
      ])
      return windowsOutput
    }) as typeof execFileSync
    expect(probeHabitBootIdentity({ platform: "win32", execFileSync: windowsBootRun })).toBe(sha256(windowsOutput))

    const windowsProcessRun = ((file: string, args: readonly string[], options: object) => {
      expect([file, args, options]).toEqual([
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-Process -Id 900).StartTime.ToUniversalTime().Ticks"],
        { encoding: "utf8" },
      ])
      return "638922384010000000\r\n"
    }) as typeof execFileSync
    expect(probeHabitProcessStartedAt(900, { platform: "win32", execFileSync: windowsProcessRun }))
      .toBe("win32:638922384010000000")

    expect(probeHabitProcessLiveness(900, { kill: (() => true) as typeof process.kill })).toBe("alive")
    expect(probeHabitProcessLiveness(900, { kill: (() => { throw codedError("ESRCH") }) as typeof process.kill })).toBe("missing")
    expect(probeHabitProcessLiveness(900, { kill: (() => { throw codedError("EPERM") }) as typeof process.kill })).toBe("unknown")
    expect(probeHabitProcessLiveness(900, { kill: (() => { throw codedError("EIO") }) as typeof process.kill })).toBe("unknown")

    const defaultLinuxDeps: HabitLifecycleDeps = {
      platform: "linux",
      fs: linuxFs,
      kill: (() => true) as typeof process.kill,
    }
    const defaultLinuxOwner = buildHabitLifecycleOwner({
      operationId: "default-linux",
      pid: 900,
      bootIdentity: "linux-boot-id",
      processStartedAt: "linux:20",
      acquiredAt: FIXED_NOW,
    })
    expect(classifyHabitLifecycleOwner(defaultLinuxOwner, defaultLinuxDeps)).toBe("live")
    expect(classifyHabitLifecycleOwner({ ...defaultLinuxOwner, processStartedAt: "linux:19" }, defaultLinuxDeps))
      .toBe("recoverable")
  })

  it("publishes a complete owner.lock atomically, releases only unchanged ownership, and emits paired evidence", async () => {
    const agentRoot = makeRoot()
    const events: LogEvent[] = []
    const operations: string[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event.startsWith("daemon.habit_lifecycle_lock_")) events.push(entry)
    })
    try {
      const result = await acquireHabitLifecycleLock(
        { agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" },
        fixedDeps({ fs: tracingFs(operations) }),
      )
      expect(result.status).toBe("acquired")
      if (result.status !== "acquired") return
      const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
      expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(owner()))
      expectAtomicSequence(operations, {
        finalPath: paths.owner,
        directoryPath: paths.root,
        publication: "link",
        cleanupTemp: true,
      })
      expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
      expect(fs.existsSync(paths.owner)).toBe(false)
      expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(false)
      expect(events.map((event) => event.event)).toEqual([
        "daemon.habit_lifecycle_lock_start",
        "daemon.habit_lifecycle_lock_end",
      ])
    } finally {
      unregister()
    }
  })

  it("cleans failed owner publications and pairs every acquisition failure with diagnostic evidence", async () => {
    const failures = [
      { operation: "openSync" },
      { operation: "write" },
      { operation: "fsyncSync", occurrence: 1 },
      { operation: "closeSync" },
      { operation: "linkSync" },
      { operation: "fsyncSync", occurrence: 2 },
    ]
    for (const [index, failure] of failures.entries()) {
      const agentRoot = makeRoot(`habit-lifecycle-owner-failure-${index}-`)
      const events: LogEvent[] = []
      const unregister = registerGlobalLogSink((entry) => {
        if (entry.event.startsWith("daemon.habit_lifecycle_lock_")) events.push(entry)
      })
      try {
        await expect(acquireHabitLifecycleLock(
          { agentRoot, habitId: "rsvp-demo", operationId: `cancel:failure-${index}` },
          fixedDeps({ fs: tracingFs([], failure) }),
        )).rejects.toMatchObject({ code: "lifecycle_lock_failed", durabilityUnknown: false })
        const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
        expect(fs.existsSync(paths.owner)).toBe(false)
        expect(fs.existsSync(paths.root)
          ? fs.readdirSync(paths.root).filter((name) => name.endsWith(".tmp"))
          : []).toEqual([])
        expect(events.map((event) => event.event)).toEqual([
          "daemon.habit_lifecycle_lock_start",
          "daemon.habit_lifecycle_lock_error",
        ])
        expect(events[1]).toMatchObject({
          level: "error",
          meta: expect.objectContaining({
            habitId: "rsvp-demo",
            operationId: `cancel:failure-${index}`,
            errorCode: "lifecycle_lock_failed",
          }),
        })
      } finally {
        unregister()
      }
    }
  })

  it("ignores a crash-abandoned partial owner temp because only complete hard-linked owner.lock is authoritative", async () => {
    const agentRoot = makeRoot("habit-lifecycle-owner-temp-crash-")
    const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
    fs.mkdirSync(paths.root, { recursive: true })
    const abandonedTemp = path.join(paths.root, "owner.lock.abandoned.tmp")
    fs.writeFileSync(abandonedTemp, "{\"schemaVersion\":1", "utf8")

    const result = await acquireHabitLifecycleLock(
      { agentRoot, habitId: "rsvp-demo", operationId: "cancel:after-crash" },
      fixedDeps(),
    )
    expect(result.status).toBe("acquired")
    expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(owner("cancel:after-crash")))
    expect(fs.readFileSync(abandonedTemp, "utf8")).toBe("{\"schemaVersion\":1")
    if (result.status === "acquired") expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
  })

  it("fences every mutation and release after an identical-byte ABA owner replacement", async () => {
    const agentRoot = makeRoot()
    const result = await acquireHabitLifecycleLock(
      { agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" },
      fixedDeps(),
    )
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") return
    const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" })
    const originalStat = fs.lstatSync(paths.owner)
    const heldOldInode = path.join(paths.root, "owner.old-inode")
    fs.linkSync(paths.owner, heldOldInode)
    fs.unlinkSync(paths.owner)
    fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(owner()), "utf8")
    const replacementStat = fs.lstatSync(paths.owner)
    expect([replacementStat.dev, replacementStat.ino]).not.toEqual([originalStat.dev, originalStat.ino])

    const journal = createHabitLifecycleJournal({
      habitId: "rsvp-demo",
      operationId: "cancel:demo",
      operationKind: "cancel",
      updatedAt: FIXED_NOW,
    })
    expect(() => writeHabitLifecycleJournal(result.lease, journal, fixedDeps()))
      .toThrow(/lifecycle_lease_lost/)
    expect(() => writeHabitLifecycleDefinition(
      result.lease,
      path.join(agentRoot, "habits", "rsvp-demo.md"),
      "---\nstatus: cancelled\n---\n",
      fixedDeps(),
    )).toThrow(/lifecycle_lease_lost/)
    const fencedReceipt = cancellationReceipt()
    expect(() => publishHabitLifecycleReceipt(
      result.lease,
      fencedReceipt.evidenceKeyHash,
      fencedReceipt,
      fixedDeps(),
    )).toThrow(/lifecycle_lease_lost/)
    expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(false)
    expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(owner()))
    expect(fs.existsSync(paths.journal!)).toBe(false)
    expect(fs.existsSync(path.join(agentRoot, "habits", "rsvp-demo.md"))).toBe(false)
    expect(fs.existsSync(getHabitLifecyclePaths({
      agentRoot,
      habitId: "rsvp-demo",
      evidenceKeyHash: fencedReceipt.evidenceKeyHash,
    }).receipt!)).toBe(false)
  })

  it("waits in exact 50 ms increments through 5,000 ms and never breaks live or indeterminate owners", async () => {
    for (const liveness of ["alive", "unknown"] as const) {
      const agentRoot = makeRoot(`habit-lifecycle-${liveness}-`)
      const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
      fs.mkdirSync(paths.root, { recursive: true })
      fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(owner("holder")), { encoding: "utf8", mode: 0o600 })
      let elapsed = 0
      const sleeps: number[] = []
      const events: LogEvent[] = []
      const unregister = registerGlobalLogSink((entry) => {
        if (entry.event.startsWith("daemon.habit_lifecycle_lock_")) events.push(entry)
      })
      try {
        const result = await acquireHabitLifecycleLock(
          { agentRoot, habitId: "rsvp-demo", operationId: "waiter" },
          fixedDeps({
            now: () => new Date(Date.parse(FIXED_NOW) + elapsed),
            processLiveness: () => liveness,
            sleep: async (milliseconds) => { sleeps.push(milliseconds); elapsed += milliseconds },
          }),
        )
        expect(result).toEqual({ status: "timeout", error: "lifecycle_lock_timeout" })
        expect(sleeps).toHaveLength(100)
        expect(new Set(sleeps)).toEqual(new Set([50]))
        expect(elapsed).toBe(5_000)
        expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(owner("holder")))
        expect(events.map((event) => event.event)).toEqual([
          "daemon.habit_lifecycle_lock_start",
          "daemon.habit_lifecycle_lock_error",
        ])
        expect(events[1]).toMatchObject({
          level: "error",
          meta: expect.objectContaining({
            habitId: "rsvp-demo",
            operationId: "waiter",
            errorCode: "lifecycle_lock_timeout",
            ownerStatus: liveness === "alive" ? "live" : "unknown",
          }),
        })
      } finally {
        unregister()
      }
    }
  })

  it("treats malformed or non-canonical owner records as indeterminate and never overwrites them", async () => {
    const validOwner = owner("holder")
    const malformedOwnerBytes = [
      serializeHabitLifecycleJson({ ...validOwner, schemaVersion: 2 }),
      serializeHabitLifecycleJson({ schemaVersion: 1, pid: validOwner.pid, bootIdentity: validOwner.bootIdentity, processStartedAt: validOwner.processStartedAt, acquiredAt: validOwner.acquiredAt }),
      serializeHabitLifecycleJson({ ...validOwner, acquiredAt: "not-a-timestamp" }),
      serializeHabitLifecycleJson({ ...validOwner, pid: 0 }),
      serializeHabitLifecycleJson({ ...validOwner, unexpected: true }),
      `${JSON.stringify({ operationId: validOwner.operationId, schemaVersion: 1, pid: validOwner.pid, bootIdentity: validOwner.bootIdentity, processStartedAt: validOwner.processStartedAt, acquiredAt: validOwner.acquiredAt }, null, 2)}\n`,
      "{\"schemaVersion\":1",
    ]
    for (const [index, bytes] of malformedOwnerBytes.entries()) {
      const agentRoot = makeRoot(`habit-lifecycle-invalid-owner-${index}-`)
      const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
      fs.mkdirSync(paths.root, { recursive: true })
      fs.writeFileSync(paths.owner, bytes, "utf8")
      let elapsed = 0
      const result = await acquireHabitLifecycleLock(
        { agentRoot, habitId: "rsvp-demo", operationId: "waiter" },
        fixedDeps({
          now: () => new Date(Date.parse(FIXED_NOW) + elapsed),
          sleep: async (milliseconds) => { elapsed += milliseconds },
        }),
      )
      expect(result).toEqual({ status: "timeout", error: "lifecycle_lock_timeout" })
      expect(fs.readFileSync(paths.owner, "utf8")).toBe(bytes)
    }
  })

  it("fails closed and emits paired diagnostics when an owner liveness probe throws", async () => {
    const agentRoot = makeRoot("habit-lifecycle-probe-error-")
    const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(owner("holder")), "utf8")
    let elapsed = 0
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event.startsWith("daemon.habit_lifecycle_lock_")) events.push(entry)
    })
    try {
      const result = await acquireHabitLifecycleLock(
        { agentRoot, habitId: "rsvp-demo", operationId: "waiter" },
        fixedDeps({
          now: () => new Date(Date.parse(FIXED_NOW) + elapsed),
          bootIdentity: () => { throw new Error("boot probe unavailable") },
          sleep: async (milliseconds) => { elapsed += milliseconds },
        }),
      )
      expect(result).toEqual({ status: "timeout", error: "lifecycle_lock_timeout" })
      expect(events.map((event) => event.event)).toEqual([
        "daemon.habit_lifecycle_lock_start",
        "daemon.habit_lifecycle_lock_error",
      ])
      expect(events[1]).toMatchObject({
        level: "error",
        meta: expect.objectContaining({
          errorCode: "lifecycle_lock_timeout",
          ownerStatus: "unknown",
          probeError: true,
        }),
      })
      expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(owner("holder")))
    } finally {
      unregister()
    }
  })

  it("recovers only boot-mismatched, missing, or PID-reused owners and preserves journal state", async () => {
    const cases: Array<{ label: string; deps: HabitLifecycleDeps }> = [
      { label: "boot", deps: fixedDeps({ bootIdentity: () => "new-boot" }) },
      { label: "missing", deps: fixedDeps({ processLiveness: () => "missing" }) },
      { label: "reused", deps: fixedDeps({ processStartedAt: () => "new-process" }) },
    ]
    for (const testCase of cases) {
      const agentRoot = makeRoot(`habit-lifecycle-recover-${testCase.label}-`)
      const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:old" })
      fs.mkdirSync(paths.journalDirectory, { recursive: true })
      fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(owner("cancel:old")), { encoding: "utf8", mode: 0o600 })
      const oldJournal = createHabitLifecycleJournal({ habitId: "rsvp-demo", operationId: "cancel:old", operationKind: "cancel", updatedAt: FIXED_NOW })
      fs.writeFileSync(paths.journal!, serializeHabitLifecycleJson(oldJournal), "utf8")

      const events: LogEvent[] = []
      const unregister = registerGlobalLogSink((entry) => {
        if (entry.event.startsWith("daemon.habit_lifecycle_lock_")) events.push(entry)
      })
      try {
        const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:new" }, testCase.deps)
        expect(result.status, testCase.label).toBe("acquired")
        expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:old" }), testCase.label).toEqual(oldJournal)
        expect(events.map((event) => event.event)).toEqual([
          "daemon.habit_lifecycle_lock_start",
          "daemon.habit_lifecycle_lock_end",
        ])
        expect(events[1]).toMatchObject({
          meta: expect.objectContaining({ recoveredOwner: true, recoveredOwnerStatus: "recoverable" }),
        })
        if (result.status === "acquired") expect(releaseHabitLifecycleLock(result.lease, testCase.deps)).toBe(true)
      } finally {
        unregister()
      }
    }
  })

  it("serializes stale-owner recovery behind the process-death-safe coordination transaction", async () => {
    const agentRoot = makeRoot("habit-lifecycle-coordination-")
    const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
    fs.mkdirSync(paths.root, { recursive: true })
    const staleBytes = serializeHabitLifecycleJson(owner("stale-owner"))
    fs.writeFileSync(paths.owner, staleBytes, "utf8")

    const childReady = path.join(agentRoot, "coordination.ready")
    const childStart = path.join(agentRoot, "coordination.start")
    const childHolding = path.join(agentRoot, "coordination.held")
    const childRelease = path.join(agentRoot, "coordination.release")
    const coordinator = spawnLifecycleChild({
      mode: "coordination",
      agentRoot,
      habitId: "rsvp-demo",
      readyPath: childReady,
      startPath: childStart,
      resultPath: childHolding,
      releasePath: childRelease,
    })
    await waitForPath(childReady)
    fs.writeFileSync(childStart, "start\n", "utf8")
    await waitForPath(childHolding)

    const waitedPath = path.join(agentRoot, "contender.waited")
    const contender = acquireHabitLifecycleLock(
      { agentRoot, habitId: "rsvp-demo", operationId: "recovered-owner" },
      fixedDeps({
        bootIdentity: () => "new-boot",
        sleep: async (milliseconds) => {
          fs.writeFileSync(waitedPath, `${milliseconds}\n`, "utf8")
          await sleep(milliseconds)
        },
      }),
    )
    const firstOutcome = await Promise.race([
      waitForPath(waitedPath).then(() => "waited" as const),
      contender.then(() => "acquired" as const),
    ])
    expect(firstOutcome).toBe("waited")
    expect(fs.readFileSync(paths.owner, "utf8")).toBe(staleBytes)

    expect(coordinator.child.kill("SIGKILL")).toBe(true)
    expect(await coordinator.completion).toMatchObject({ code: null })
    const result = await contender
    expect(result.status).toBe("acquired")
    if (result.status === "acquired") expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
    const coordination = new Database(paths.coordination, { readonly: true })
    try {
      expect(coordination.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all()).toEqual([])
    } finally {
      coordination.close()
    }
  }, 20_000)

  it("revalidates a stale owner immediately before removal and preserves an injected successor", async () => {
    const agentRoot = makeRoot("habit-lifecycle-recovery-revalidation-")
    const paths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" })
    fs.mkdirSync(paths.root, { recursive: true })
    const sameBytesOwner = owner("same-owner")
    fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(sameBytesOwner), "utf8")
    const originalIdentity = fs.lstatSync(paths.owner)
    let replacementIdentity: fs.Stats | null = null
    let injected = false
    let elapsed = 0
    const result = await acquireHabitLifecycleLock(
      { agentRoot, habitId: "rsvp-demo", operationId: "contender" },
      fixedDeps({
        now: () => new Date(Date.parse(FIXED_NOW) + elapsed),
        processStartedAt: () => injected ? "process-current" : "reused-process",
        sleep: async (milliseconds) => { elapsed += milliseconds },
        beforeOwnerRecovery: () => {
          if (injected) return
          injected = true
          const heldStaleInode = path.join(paths.root, "stale-owner-held")
          fs.linkSync(paths.owner, heldStaleInode)
          fs.unlinkSync(paths.owner)
          fs.writeFileSync(paths.owner, serializeHabitLifecycleJson(sameBytesOwner), "utf8")
          replacementIdentity = fs.lstatSync(paths.owner)
        },
      }),
    )
    expect(injected).toBe(true)
    expect(replacementIdentity).not.toBeNull()
    expect([replacementIdentity!.dev, replacementIdentity!.ino])
      .not.toEqual([originalIdentity.dev, originalIdentity.ino])
    expect(result).toEqual({ status: "timeout", error: "lifecycle_lock_timeout" })
    expect(fs.readFileSync(paths.owner, "utf8")).toBe(serializeHabitLifecycleJson(sameBytesOwner))
  })

  it("serializes one habit, allows different habits, and recovers a crashed real-process owner", async () => {
    const agentRoot = makeRoot("habit-lifecycle-processes-")
    const firstReady = path.join(agentRoot, "first.ready")
    const firstStart = path.join(agentRoot, "first.start")
    const firstAcquired = path.join(agentRoot, "first.result")
    const firstBarrier = path.join(agentRoot, "first.release")
    const secondReady = path.join(agentRoot, "second.ready")
    const secondStart = path.join(agentRoot, "second.start")
    const secondAcquired = path.join(agentRoot, "second.result")
    const secondBarrier = path.join(agentRoot, "second.release")
    const first = spawnLifecycleChild({
      mode: "lock",
      agentRoot,
      habitId: "same-habit",
      operationId: "first",
      readyPath: firstReady,
      startPath: firstStart,
      resultPath: firstAcquired,
      releasePath: firstBarrier,
    })
    await waitForPath(firstReady)
    fs.writeFileSync(firstStart, "start\n", "utf8")
    await waitForPath(firstAcquired)
    const second = spawnLifecycleChild({
      mode: "lock",
      agentRoot,
      habitId: "same-habit",
      operationId: "second",
      readyPath: secondReady,
      startPath: secondStart,
      resultPath: secondAcquired,
      releasePath: secondBarrier,
    })
    await waitForPath(secondReady)
    fs.writeFileSync(secondStart, "start\n", "utf8")
    await waitForPath(`${secondAcquired}.attempting`)
    await sleep(150)
    expect(fs.existsSync(secondAcquired)).toBe(false)
    fs.writeFileSync(firstBarrier, "release\n", "utf8")
    expect(await first.completion).toMatchObject({ code: 0 })
    await waitForPath(secondAcquired)
    fs.writeFileSync(secondBarrier, "release\n", "utf8")
    expect(await second.completion).toMatchObject({ code: 0 })

    const alphaReady = path.join(agentRoot, "alpha.ready")
    const betaReady = path.join(agentRoot, "beta.ready")
    const differentStart = path.join(agentRoot, "different.start")
    const alphaAcquired = path.join(agentRoot, "alpha.result")
    const betaAcquired = path.join(agentRoot, "beta.result")
    const sharedRelease = path.join(agentRoot, "different.release")
    const alpha = spawnLifecycleChild({
      mode: "lock",
      agentRoot,
      habitId: "habit-alpha",
      operationId: "alpha",
      readyPath: alphaReady,
      startPath: differentStart,
      resultPath: alphaAcquired,
      releasePath: sharedRelease,
    })
    const beta = spawnLifecycleChild({
      mode: "lock",
      agentRoot,
      habitId: "habit-beta",
      operationId: "beta",
      readyPath: betaReady,
      startPath: differentStart,
      resultPath: betaAcquired,
      releasePath: sharedRelease,
    })
    await Promise.all([waitForPath(alphaReady), waitForPath(betaReady)])
    fs.writeFileSync(differentStart, "start\n", "utf8")
    await Promise.all([waitForPath(alphaAcquired), waitForPath(betaAcquired)])
    fs.writeFileSync(sharedRelease, "release\n", "utf8")
    expect(await alpha.completion).toMatchObject({ code: 0 })
    expect(await beta.completion).toMatchObject({ code: 0 })

    const crashReady = path.join(agentRoot, "crash.ready")
    const crashStart = path.join(agentRoot, "crash.start")
    const crashResult = path.join(agentRoot, "crash.result")
    const crashed = spawnLifecycleChild({
      mode: "abandon",
      agentRoot,
      habitId: "crashed-habit",
      operationId: "crashed-owner",
      readyPath: crashReady,
      startPath: crashStart,
      resultPath: crashResult,
    })
    await waitForPath(crashReady)
    fs.writeFileSync(crashStart, "start\n", "utf8")
    await waitForPath(crashResult)
    const crashedRecord = JSON.parse(fs.readFileSync(crashResult, "utf8")) as { pid: number }
    expect(await crashed.completion).toMatchObject({ code: 0 })
    expect(() => process.kill(crashedRecord.pid, 0)).toThrow()
    const recovered = await acquireHabitLifecycleLock({
      agentRoot,
      habitId: "crashed-habit",
      operationId: "recovered-owner",
    })
    expect(recovered.status).toBe("acquired")
    if (recovered.status === "acquired") expect(releaseHabitLifecycleLock(recovered.lease)).toBe(true)
  }, 45_000)

  it("writes journal and definition bytes in temp-fsync-rename-directory-fsync order", async () => {
    const agentRoot = makeRoot()
    const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }, fixedDeps())
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") return
    const journal = createHabitLifecycleJournal({ habitId: "rsvp-demo", operationId: "cancel:demo", operationKind: "cancel", updatedAt: FIXED_NOW })
    const lifecyclePaths = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" })
    const journalOperations: string[] = []
    writeHabitLifecycleJournal(result.lease, journal, fixedDeps({ fs: tracingFs(journalOperations) }))
    expectAtomicSequence(journalOperations, {
      finalPath: lifecyclePaths.journal!,
      directoryPath: lifecyclePaths.journalDirectory,
      publication: "rename",
      cleanupTemp: false,
    })

    const definitionPath = path.join(agentRoot, "habits", "rsvp-demo.md")
    const definitionOperations: string[] = []
    writeHabitLifecycleDefinition(
      result.lease,
      definitionPath,
      "---\nstatus: cancelled\n---\n",
      fixedDeps({ fs: tracingFs(definitionOperations) }),
    )
    expectAtomicSequence(definitionOperations, {
      finalPath: definitionPath,
      directoryPath: path.dirname(definitionPath),
      publication: "rename",
      cleanupTemp: false,
    })
    expect(fs.readFileSync(lifecyclePaths.journal!, "utf8"))
      .toBe(serializeHabitLifecycleJson(journal))
    expect(fs.readFileSync(definitionPath, "utf8")).toBe("---\nstatus: cancelled\n---\n")
    expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
  })

  it("keeps prior journal and definition bytes authoritative before rename and exposes post-rename durability", async () => {
    const failures = [
      { operation: "openSync" },
      { operation: "write" },
      { operation: "fsyncSync", occurrence: 1 },
      { operation: "closeSync" },
      { operation: "renameSync" },
    ]
    for (const [index, failure] of failures.entries()) {
      const agentRoot = makeRoot(`habit-lifecycle-journal-failure-${index}-`)
      const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }, fixedDeps())
      expect(result.status).toBe("acquired")
      if (result.status !== "acquired") continue
      const initial = createHabitLifecycleJournal({ habitId: "rsvp-demo", operationId: "cancel:demo", operationKind: "cancel", updatedAt: FIXED_NOW })
      writeHabitLifecycleJournal(result.lease, initial, fixedDeps())
      const intent = transitionHabitLifecycleJournal(initial, { state: "cancellation_intent", at: NEXT_NOW, evidenceKeyHash: "b".repeat(64) })
      let caught: unknown
      try {
        writeHabitLifecycleJournal(result.lease, intent, fixedDeps({ fs: tracingFs([], failure) }))
      } catch (error) {
        caught = error
      }
      expectLifecycleError(caught, "lifecycle_write_failed")
      expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" })).toEqual(initial)
      expect(fs.readdirSync(getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo" }).journalDirectory)
        .filter((name) => name.endsWith(".tmp"))).toEqual([])
      expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
    }

    const agentRoot = makeRoot("habit-lifecycle-dir-fsync-")
    const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }, fixedDeps())
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") return
    const initial = createHabitLifecycleJournal({ habitId: "rsvp-demo", operationId: "cancel:demo", operationKind: "cancel", updatedAt: FIXED_NOW })
    writeHabitLifecycleJournal(result.lease, initial, fixedDeps())
    const intent = transitionHabitLifecycleJournal(initial, { state: "cancellation_intent", at: NEXT_NOW, evidenceKeyHash: "b".repeat(64) })
    let caught: unknown
    try {
      writeHabitLifecycleJournal(result.lease, intent, fixedDeps({
        fs: tracingFs([], { operation: "fsyncSync", occurrence: 2 }),
      }))
    } catch (error) {
      caught = error
    }
    expectLifecycleError(caught, "lifecycle_durability_unknown", true)
    expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" })).toEqual(intent)
    expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)

    for (const [index, failure] of failures.entries()) {
      const definitionRoot = makeRoot(`habit-lifecycle-definition-failure-${index}-`)
      const definitionResult = await acquireHabitLifecycleLock(
        { agentRoot: definitionRoot, habitId: "rsvp-demo", operationId: "cancel:demo" },
        fixedDeps(),
      )
      expect(definitionResult.status).toBe("acquired")
      if (definitionResult.status !== "acquired") continue
      const definitionPath = path.join(definitionRoot, "habits", "rsvp-demo.md")
      fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
      fs.writeFileSync(definitionPath, "---\nstatus: active\n---\n", "utf8")
      let definitionError: unknown
      try {
        writeHabitLifecycleDefinition(
          definitionResult.lease,
          definitionPath,
          "---\nstatus: cancelled\n---\n",
          fixedDeps({ fs: tracingFs([], failure) }),
        )
      } catch (error) {
        definitionError = error
      }
      expectLifecycleError(definitionError, "lifecycle_write_failed")
      expect(fs.readFileSync(definitionPath, "utf8")).toBe("---\nstatus: active\n---\n")
      expect(fs.readdirSync(path.dirname(definitionPath)).filter((name) => name.endsWith(".tmp"))).toEqual([])
      expect(releaseHabitLifecycleLock(definitionResult.lease, fixedDeps())).toBe(true)
    }

    const definitionRoot = makeRoot("habit-lifecycle-definition-dir-fsync-")
    const definitionResult = await acquireHabitLifecycleLock(
      { agentRoot: definitionRoot, habitId: "rsvp-demo", operationId: "cancel:demo" },
      fixedDeps(),
    )
    expect(definitionResult.status).toBe("acquired")
    if (definitionResult.status !== "acquired") return
    const definitionPath = path.join(definitionRoot, "habits", "rsvp-demo.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, "---\nstatus: active\n---\n", "utf8")
    let definitionError: unknown
    try {
      writeHabitLifecycleDefinition(
        definitionResult.lease,
        definitionPath,
        "---\nstatus: cancelled\n---\n",
        fixedDeps({ fs: tracingFs([], { operation: "fsyncSync", occurrence: 2 }) }),
      )
    } catch (error) {
      definitionError = error
    }
    expectLifecycleError(definitionError, "lifecycle_durability_unknown", true)
    expect(fs.readFileSync(definitionPath, "utf8")).toBe("---\nstatus: cancelled\n---\n")
    expect(releaseHabitLifecycleLock(definitionResult.lease, fixedDeps())).toBe(true)
  })

  it("publishes receipts immutably, returns exact duplicates, rejects collisions, and reconciles durability unknown", async () => {
    const agentRoot = makeRoot()
    const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }, fixedDeps())
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") return
    const receipt = cancellationReceipt()
    const evidenceHash = receipt.evidenceKeyHash
    const receiptPath = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: evidenceHash }).receipt!
    const operations: string[] = []
    expect(publishHabitLifecycleReceipt(result.lease, evidenceHash, receipt, fixedDeps({ fs: tracingFs(operations) })))
      .toBe("published")
    expectAtomicSequence(operations, {
      finalPath: receiptPath,
      directoryPath: path.dirname(receiptPath),
      publication: "link",
      cleanupTemp: true,
    })
    expect(publishHabitLifecycleReceipt(result.lease, evidenceHash, receipt, fixedDeps())).toBe("duplicate")
    expect(readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: evidenceHash })).toEqual(receipt)
    expect(() => publishHabitLifecycleReceipt(result.lease, evidenceHash, {
      ...receipt,
      acknowledgement: `${receipt.acknowledgement} collision`,
    }, fixedDeps()))
      .toThrow(/lifecycle_receipt_collision/)

    const unknownReceipt = cancellationReceipt(sha256("durability-unknown-capture"))
    const unknownHash = unknownReceipt.evidenceKeyHash
    let caught: unknown
    try {
      publishHabitLifecycleReceipt(result.lease, unknownHash, unknownReceipt, fixedDeps({
        fs: tracingFs([], { operation: "fsyncSync", occurrence: 2 }),
      }))
    } catch (error) {
      caught = error
    }
    expectLifecycleError(caught, "lifecycle_durability_unknown", true)
    expect(readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: unknownHash })).toEqual(unknownReceipt)
    expect(publishHabitLifecycleReceipt(result.lease, unknownHash, unknownReceipt, fixedDeps())).toBe("duplicate")

    const failures = [
      { operation: "openSync" },
      { operation: "write" },
      { operation: "fsyncSync", occurrence: 1 },
      { operation: "closeSync" },
      { operation: "linkSync" },
    ]
    for (const [index, failure] of failures.entries()) {
      const failedReceipt = cancellationReceipt(sha256(`receipt-failure-${index}`))
      const failedHash = failedReceipt.evidenceKeyHash
      let failureError: unknown
      try {
        publishHabitLifecycleReceipt(
          result.lease,
          failedHash,
          failedReceipt,
          fixedDeps({ fs: tracingFs([], failure) }),
        )
      } catch (error) {
        failureError = error
      }
      expectLifecycleError(failureError, "lifecycle_write_failed")
      const failedPath = getHabitLifecyclePaths({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: failedHash }).receipt!
      expect(fs.existsSync(failedPath)).toBe(false)
      expect(fs.existsSync(path.dirname(failedPath))
        ? fs.readdirSync(path.dirname(failedPath)).filter((name) => name.endsWith(".tmp"))
        : []).toEqual([])
    }
    expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
  })

  it("uses no-clobber publication for concurrent duplicate and collision receipt writers", async () => {
    const agentRoot = makeRoot("habit-lifecycle-receipt-race-")
    const lock = await acquireHabitLifecycleLock(
      { agentRoot, habitId: "rsvp-demo", operationId: "cancel:race" },
      fixedDeps(),
    )
    expect(lock.status).toBe("acquired")
    if (lock.status !== "acquired") return

    const runRace = async (
      label: string,
      evidenceKeyHash: string,
      receipts: [HabitCancellationReceipt, HabitCancellationReceipt],
    ): Promise<string[]> => {
      const startPath = path.join(agentRoot, `${label}.start`)
      const readyPaths = [0, 1].map((index) => path.join(agentRoot, `${label}.${index}.ready`))
      const resultPaths = [0, 1].map((index) => path.join(agentRoot, `${label}.${index}.result`))
      const precommitPaths = [0, 1].map((index) => path.join(agentRoot, `${label}.${index}.precommit`))
      const children = [0, 1].map((index) => spawnLifecycleChild({
        mode: "receipt",
        agentRoot,
        readyPath: readyPaths[index]!,
        startPath,
        resultPath: resultPaths[index]!,
        lease: lock.lease,
        evidenceKeyHash,
        receipt: receipts[index]!,
        precommitPath: precommitPaths[index]!,
        peerPrecommitPath: precommitPaths[index === 0 ? 1 : 0]!,
      }))
      await Promise.all(readyPaths.map((readyPath) => waitForPath(readyPath)))
      fs.writeFileSync(startPath, "start\n", "utf8")
      await Promise.all(resultPaths.map((resultPath) => waitForPath(resultPath, 10_000)))
      const completions = await Promise.all(children.map(({ completion }) => completion))
      expect(completions.map(({ code }) => code)).toEqual([0, 0])
      return resultPaths.map((resultPath) => (
        JSON.parse(fs.readFileSync(resultPath, "utf8")) as { outcome: string }
      ).outcome)
    }

    const duplicateReceipt = cancellationReceipt(sha256("concurrent-duplicate"))
    const duplicateHash = duplicateReceipt.evidenceKeyHash
    expect((await runRace("duplicate", duplicateHash, [duplicateReceipt, duplicateReceipt])).sort())
      .toEqual(["duplicate", "published"])
    expect(readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: duplicateHash }))
      .toEqual(duplicateReceipt)

    const collisionCaptureHash = sha256("concurrent-collision")
    const firstReceipt = cancellationReceipt(collisionCaptureHash)
    const collisionHash = firstReceipt.evidenceKeyHash
    const secondReceipt = cancellationReceipt(collisionCaptureHash, {
      actor: { displayName: "Second requester", provider: "bluebubbles", externalId: "synthetic-second" },
      acknowledgement: "Cancelled habit \"rsvp-demo\" from confirmed requester \"Second requester\". No concurrent send crossed the transport boundary.",
    })
    expect((await runRace("collision", collisionHash, [firstReceipt, secondReceipt])).sort())
      .toEqual(["lifecycle_receipt_collision", "published"])
    expect([firstReceipt, secondReceipt]).toContainEqual(readHabitLifecycleReceipt({
      agentRoot,
      habitId: "rsvp-demo",
      evidenceKeyHash: collisionHash,
    }))
    expect(releaseHabitLifecycleLock(lock.lease, fixedDeps())).toBe(true)
  }, 45_000)

  it("preserves cancelled definition and journal state for operation-owned recovery and idempotent retry", async () => {
    const agentRoot = makeRoot("habit-lifecycle-reconcile-")
    const receipt = cancellationReceipt(sha256("reconcile-cancellation"))
    const evidenceKeyHash = receipt.evidenceKeyHash
    const operationId = `cancel:${evidenceKeyHash}`
    const definitionPath = path.join(agentRoot, "habits", "rsvp-demo.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, "---\nstatus: active\n---\n", "utf8")
    const cancelledBytes = "---\nstatus: cancelled\ncancelledAt: 2026-07-31T20:30:02.000Z\n---\n"

    const firstLock = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId }, fixedDeps())
    expect(firstLock.status).toBe("acquired")
    if (firstLock.status !== "acquired") return
    const initial = createHabitLifecycleJournal({
      habitId: "rsvp-demo",
      operationId,
      operationKind: "cancel",
      updatedAt: FIXED_NOW,
    })
    writeHabitLifecycleJournal(firstLock.lease, initial, fixedDeps())
    const intent = transitionHabitLifecycleJournal(initial, {
      state: "cancellation_intent",
      at: NEXT_NOW,
      evidenceKeyHash,
    })
    writeHabitLifecycleJournal(firstLock.lease, intent, fixedDeps())
    writeHabitLifecycleDefinition(firstLock.lease, definitionPath, cancelledBytes, fixedDeps())
    const definitionCancelled = transitionHabitLifecycleJournal(intent, {
      state: "definition_cancelled",
      at: THIRD_NOW,
      boundaryState: "not_crossed",
    })
    writeHabitLifecycleJournal(firstLock.lease, definitionCancelled, fixedDeps())
    expect(() => publishHabitLifecycleReceipt(
      firstLock.lease,
      evidenceKeyHash,
      receipt,
      fixedDeps({ fs: tracingFs([], { operation: "linkSync" }) }),
    )).toThrow(/lifecycle_write_failed/)
    expect(fs.readFileSync(definitionPath, "utf8")).toBe(cancelledBytes)
    expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId })).toEqual(definitionCancelled)
    expect(readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash })).toBeNull()
    expect(releaseHabitLifecycleLock(firstLock.lease, fixedDeps())).toBe(true)

    const recoveryLock = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId }, fixedDeps())
    expect(recoveryLock.status).toBe("acquired")
    if (recoveryLock.status !== "acquired") return
    expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId })).toEqual(definitionCancelled)
    expect(fs.readFileSync(definitionPath, "utf8")).toBe(cancelledBytes)
    expect(publishHabitLifecycleReceipt(recoveryLock.lease, evidenceKeyHash, receipt, fixedDeps())).toBe("published")
    const committed = transitionHabitLifecycleJournal(definitionCancelled, {
      state: "cancellation_receipt_committed",
      at: FOURTH_NOW,
    })
    writeHabitLifecycleJournal(recoveryLock.lease, committed, fixedDeps())
    expect(releaseHabitLifecycleLock(recoveryLock.lease, fixedDeps())).toBe(true)

    const retryLock = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId }, fixedDeps())
    expect(retryLock.status).toBe("acquired")
    if (retryLock.status !== "acquired") return
    expect(publishHabitLifecycleReceipt(retryLock.lease, evidenceKeyHash, receipt, fixedDeps())).toBe("duplicate")
    expect(readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId })).toEqual(committed)
    expect(fs.readFileSync(definitionPath, "utf8")).toBe(cancelledBytes)
    expect(releaseHabitLifecycleLock(retryLock.lease, fixedDeps())).toBe(true)
  })

  it("fails closed on corrupt journal/receipt state and emits diagnostic write errors", async () => {
    const agentRoot = makeRoot()
    const validReceipt = cancellationReceipt()
    const validEvidenceHash = validReceipt.evidenceKeyHash
    const paths = getHabitLifecyclePaths({
      agentRoot,
      habitId: "rsvp-demo",
      operationId: "cancel:demo",
      evidenceKeyHash: validEvidenceHash,
    })
    fs.mkdirSync(paths.journalDirectory, { recursive: true })
    fs.mkdirSync(paths.receiptsDirectory, { recursive: true })

    const validJournal = createHabitLifecycleJournal({
      habitId: "rsvp-demo",
      operationId: "cancel:demo",
      operationKind: "cancel",
      updatedAt: FIXED_NOW,
    })
    const missingJournalKey = { ...validJournal } as Record<string, unknown>
    delete missingJournalKey.operationId
    const invalidJournals: unknown[] = [
      { ...validJournal, schemaVersion: 2 },
      missingJournalKey,
      { ...validJournal, unexpected: true },
      { ...validJournal, updatedAt: "not-a-timestamp" },
      { ...validJournal, updatedAt: "2026-07-31T20:30:00Z" },
      { ...validJournal, habitId: "other-habit" },
      { ...validJournal, operationId: "cancel:other-operation" },
      { ...validJournal, operationKind: "send" },
      { ...validJournal, state: "unknown_state" },
      { ...validJournal, generation: -1 },
      { ...validJournal, generation: 0.5 },
      { ...validJournal, generation: 1 },
      { ...validJournal, state: "cancellation_intent" },
      { ...validJournal, evidenceKeyHash: "b".repeat(64) },
      { ...validJournal, intentAt: NEXT_NOW },
      { ...validJournal, state: "crossed", generation: 2, boundaryState: "crossed" },
    ]
    for (const invalidJournal of invalidJournals) {
      fs.writeFileSync(paths.journal!, serializeHabitLifecycleJson(invalidJournal), "utf8")
      expect(() => readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }))
        .toThrow(/lifecycle_journal_invalid/)
    }
    fs.writeFileSync(paths.journal!, `${JSON.stringify({ operationId: validJournal.operationId, ...validJournal }, null, 2)}\n`, "utf8")
    expect(() => readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" }))
      .toThrow(/lifecycle_journal_invalid/)

    const missingReceiptKey = { ...validReceipt } as Record<string, unknown>
    delete missingReceiptKey.actor
    const invalidReceipts: unknown[] = [
      { ...validReceipt, schemaVersion: 2 },
      missingReceiptKey,
      { ...validReceipt, unexpected: true },
      { ...validReceipt, createdAt: "not-a-timestamp" },
      { ...validReceipt, createdAt: "2026-07-31T20:30:02Z" },
      { ...validReceipt, habitId: "other-habit" },
      { ...validReceipt, operationId: `cancel:${"c".repeat(64)}` },
      { ...validReceipt, evidenceKeyHash: "B".repeat(64) },
      { ...validReceipt, evidenceKeyHash: "c".repeat(64) },
      { ...validReceipt, evidenceLocator: { id: CAPTURE_HASH, kind: "capture" } },
      { ...validReceipt, evidenceLocator: { ...validReceipt.evidenceLocator, unexpected: true } },
      { ...validReceipt, actor: { provider: "bluebubbles", displayName: "Ari", externalId: "synthetic-handle" } },
      { ...validReceipt, actor: { displayName: "Ari", provider: "bluebubbles" } },
      { ...validReceipt, actor: { ...validReceipt.actor, unexpected: true } },
      { ...validReceipt, request: { ...validReceipt.request, text: "Different text" } },
      { ...validReceipt, request: { ...validReceipt.request, sha256: "c".repeat(64) } },
      { ...validReceipt, request: { ...validReceipt.request, observedAt: "2026-07-31T20:30:00Z" } },
      { ...validReceipt, request: { sha256: validReceipt.request.sha256, text: validReceipt.request.text, observedAt: validReceipt.request.observedAt } },
      { ...validReceipt, request: { ...validReceipt.request, unexpected: true } },
      { ...validReceipt, transition: { ...validReceipt.transition, toStatus: "active" } },
      { ...validReceipt, transition: { ...validReceipt.transition, fromStatus: "cancelled" } },
      { ...validReceipt, transition: { ...validReceipt.transition, boundaryState: "unknown" } },
      { ...validReceipt, transition: { ...validReceipt.transition, cancelledAt: NEXT_NOW } },
      { ...validReceipt, transition: { toStatus: "cancelled", fromStatus: "active", cancelledAt: THIRD_NOW, boundaryState: "not_crossed" } },
      { ...validReceipt, transition: { ...validReceipt.transition, unexpected: true } },
      { ...validReceipt, acknowledgement: "caller-authored acknowledgement" },
    ]
    for (const invalidReceipt of invalidReceipts) {
      fs.writeFileSync(paths.receipt!, serializeHabitLifecycleJson(invalidReceipt), "utf8")
      expect(() => readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: validEvidenceHash }))
        .toThrow(/lifecycle_receipt_invalid/)
    }
    fs.writeFileSync(paths.receipt!, `${JSON.stringify({ habitId: validReceipt.habitId, ...validReceipt }, null, 2)}\n`, "utf8")
    expect(() => readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: validEvidenceHash }))
      .toThrow(/lifecycle_receipt_invalid/)

    fs.writeFileSync(paths.journal!, "{bad-json\n", "utf8")
    fs.writeFileSync(paths.receipt!, "{bad-json\n", "utf8")
    expect(() => readHabitLifecycleJournal({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:demo" })).toThrow(/lifecycle_journal_invalid/)
    expect(() => readHabitLifecycleReceipt({ agentRoot, habitId: "rsvp-demo", evidenceKeyHash: validEvidenceHash })).toThrow(/lifecycle_receipt_invalid/)

    const result = await acquireHabitLifecycleLock({ agentRoot, habitId: "rsvp-demo", operationId: "cancel:new" }, fixedDeps())
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") return
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event === "daemon.habit_lifecycle_write_error") events.push(entry)
    })
    try {
      const journal: HabitLifecycleJournal = createHabitLifecycleJournal({ habitId: "rsvp-demo", operationId: "cancel:new", operationKind: "cancel", updatedAt: FIXED_NOW })
      expect(() => writeHabitLifecycleJournal(result.lease, journal, fixedDeps({ fs: fsWithFault("renameSync") }))).toThrow(/lifecycle_write_failed/)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ level: "error", meta: expect.objectContaining({ operationId: "cancel:new", errorCode: "lifecycle_write_failed" }) })
    } finally {
      unregister()
      expect(releaseHabitLifecycleLock(result.lease, fixedDeps())).toBe(true)
    }
  })
})
