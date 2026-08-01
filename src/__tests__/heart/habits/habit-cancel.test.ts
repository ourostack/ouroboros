import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { registerGlobalLogSink, type LogEvent } from "../../../nerves"
import {
  acquireHabitLifecycleLock,
  buildHabitCancellationOperation,
  buildHabitEvidenceIdentity,
  buildHabitSendOperation,
  createHabitLifecycleJournal,
  getHabitLifecyclePaths,
  releaseHabitLifecycleLock,
  transitionHabitLifecycleJournal,
  writeHabitLifecycleJournal,
  type HabitBoundaryState,
  type HabitLifecycleDeps,
} from "../../../heart/habits/habit-lifecycle"
import {
  cancelHabit,
  HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256,
  renderHabitCancellationAcknowledgement,
  resolveHistoricalHabitEvidenceBridgeTrust,
  validateHabitEvidenceBridge,
  type HabitCancelInput,
  type HabitCancelDeps,
  type HabitCancellationAuthority,
} from "../../../heart/habits/habit-cancel"
import {
  SYNTHETIC_ACTOR,
  SYNTHETIC_CANCELLED_AT,
  SYNTHETIC_CANCELLATION_REASON,
  SYNTHETIC_CAPTURED_AT,
  SYNTHETIC_HABIT_ID,
  SYNTHETIC_PARTICIPANT,
  SYNTHETIC_REQUEST,
  sha256Utf8,
  writeSyntheticBridgeEvidence,
  writeSyntheticCaptureEvidence,
  writeSyntheticHabitDefinition,
  type SyntheticBridgeEvidence,
  type SyntheticCaptureEvidence,
} from "../../fixtures/habits/habit-cancel-evidence"

const roots: string[] = []
const activeChildren = new Set<ReturnType<typeof spawn>>()

function temporaryAgentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "habit-cancel-"))
  roots.push(root)
  return root
}

function lifecycleDeps(overrides: HabitCancelDeps = {}): HabitCancelDeps {
  return {
    now: () => new Date(SYNTHETIC_CANCELLED_AT),
    pid: () => process.pid,
    bootIdentity: () => "synthetic-boot",
    processStartedAt: () => "synthetic-process-start",
    processLiveness: () => "alive",
    trustedBridge: (_bridgeId, _sha256) => ({
      cancellationReason: SYNTHETIC_CANCELLATION_REASON,
    }),
    ...overrides,
  }
}

function captureAuthority(capture: SyntheticCaptureEvidence): HabitCancellationAuthority {
  return {
    kind: "current_ingress",
    currentIngressEvidence: {
      schemaVersion: 1,
      provider: "bluebubbles",
      captureKeyHash: capture.capture.keyHash,
    },
  }
}

function offlineAuthority(): HabitCancellationAuthority {
  return { kind: "offline_bridge" }
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function lifecycleRoot(agentRoot: string): string {
  return getHabitLifecyclePaths({ agentRoot, habitId: SYNTHETIC_HABIT_ID }).root
}

async function waitForPath(filePath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now()
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for ${filePath}`)
    await sleep(10)
  }
}

function spawnCancellationChild(input: {
  mode: "cancel" | "crash_after_definition"
  agentRoot: string
  habitId: string
  captureKeyHash: string
  readyPath: string
  startPath: string
  resultPath: string
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const fixture = path.join(
    process.cwd(),
    "src",
    "__tests__",
    "fixtures",
    "habits",
    "habit-cancel-child-process.mjs",
  )
  const child = spawn(process.execPath, [fixture], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HABIT_CANCEL_CHILD_MODE: input.mode,
      HABIT_CANCEL_CHILD_AGENT_ROOT: input.agentRoot,
      HABIT_CANCEL_CHILD_HABIT_ID: input.habitId,
      HABIT_CANCEL_CHILD_CAPTURE_HASH: input.captureKeyHash,
      HABIT_CANCEL_CHILD_READY: input.readyPath,
      HABIT_CANCEL_CHILD_START: input.startPath,
      HABIT_CANCEL_CHILD_RESULT: input.resultPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  activeChildren.add(child)
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      activeChildren.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
}

async function cancelCapture(
  agentRoot: string,
  capture: SyntheticCaptureEvidence,
  deps: HabitCancelDeps = lifecycleDeps(),
) {
  return cancelHabit({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
    evidenceLocator: capture.locator,
    authority: captureAuthority(capture),
  }, deps)
}

async function cancelBridge(
  agentRoot: string,
  bridge: SyntheticBridgeEvidence,
  deps: HabitCancelDeps = lifecycleDeps(),
) {
  return cancelHabit({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
    evidenceLocator: bridge.locator,
    authority: offlineAuthority(),
  }, deps)
}

function cancellationPathsForCapture(agentRoot: string, capture: SyntheticCaptureEvidence) {
  const identity = buildHabitEvidenceIdentity({
    habitId: SYNTHETIC_HABIT_ID,
    kind: "capture",
    id: capture.capture.keyHash,
  })
  const operation = buildHabitCancellationOperation(identity.evidenceKeyHash)
  return getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
    operationId: operation.operationId,
    evidenceKeyHash: identity.evidenceKeyHash,
  })
}

async function leaveCancellationAtGeneration(
  agentRoot: string,
  capture: SyntheticCaptureEvidence,
  generation: 1 | 2,
): Promise<Record<string, any>> {
  const failingFs = generation === 1
    ? failJournalDirectoryFsyncAtState(agentRoot, "cancellation_intent")
    : failReceiptPublicationOnce()
  await cancelCapture(agentRoot, capture, lifecycleDeps({ fs: failingFs })).catch(() => undefined)
  const journal = readJson(cancellationPathsForCapture(agentRoot, capture).journal!)
  if (journal.generation !== generation) {
    throw new Error(`expected cancellation generation ${generation}, got ${String(journal.generation)}`)
  }
  return journal
}

async function seedSendJournal(
  agentRoot: string,
  boundaryState: HabitBoundaryState | null,
): Promise<void> {
  const operation = buildHabitSendOperation({
    habitId: SYNTHETIC_HABIT_ID,
    outboundIdempotencyKey: `synthetic-${boundaryState ?? "unclassified"}`,
  })
  const times = [
    "2026-07-01T12:02:00.000Z",
    "2026-07-01T12:03:00.000Z",
    "2026-07-01T12:04:00.000Z",
  ]
  let timeIndex = 0
  const deps: HabitLifecycleDeps = {
    ...lifecycleDeps(),
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
  }
  const lock = await acquireHabitLifecycleLock({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
    operationId: operation.operationId,
  }, deps)
  if (lock.status !== "acquired") throw new Error("synthetic send lock timed out")
  try {
    let journal = createHabitLifecycleJournal({
      habitId: SYNTHETIC_HABIT_ID,
      operationId: operation.operationId,
      operationKind: "send",
      updatedAt: times[0],
    })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
    journal = transitionHabitLifecycleJournal(journal, {
      state: "send_intent",
      at: times[1],
    })
    writeHabitLifecycleJournal(lock.lease, journal, deps)
    if (boundaryState !== null) {
      journal = transitionHabitLifecycleJournal(journal, {
        state: boundaryState,
        at: times[2],
        transportInvokedAt: boundaryState === "not_crossed" ? null : times[1],
        transportResult: {
          httpStatus: boundaryState === "crossed" ? 200 : null,
          messageGuid: boundaryState === "crossed" ? "synthetic-message-guid" : null,
          errorCode: boundaryState === "crossing_unknown" ? "synthetic_timeout" : null,
        },
      })
      writeHabitLifecycleJournal(lock.lease, journal, deps)
    }
  } finally {
    expect(releaseHabitLifecycleLock(lock.lease, deps)).toBe(true)
  }
}

function failOnceAfterRename(targetPath: string): typeof fs {
  let failDirectorySync = false
  let failed = false
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (from: fs.PathLike, to: fs.PathLike): void => {
          fs.renameSync(from, to)
          if (path.resolve(String(to)) === path.resolve(targetPath)) failDirectorySync = true
        }
      }
      if (property === "fsyncSync") {
        return (fd: number): void => {
          if (failDirectorySync && !failed) {
            failed = true
            failDirectorySync = false
            throw new Error("synthetic directory fsync failure")
          }
          fs.fsyncSync(fd)
        }
      }
      return Reflect.get(target, property)
    },
  }) as typeof fs
}

function failReceiptPublicationOnce(): typeof fs {
  let failed = false
  return new Proxy(fs, {
    get(target, property) {
      if (property === "linkSync") {
        return (existingPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (!failed && String(newPath).includes(`${path.sep}receipts${path.sep}`)) {
            failed = true
            throw new Error("synthetic receipt publication failure")
          }
          fs.linkSync(existingPath, newPath)
        }
      }
      return Reflect.get(target, property)
    },
  }) as typeof fs
}

function failJournalDirectoryFsyncAtState(
  agentRoot: string,
  state: string,
): typeof fs {
  const journalDirectory = path.resolve(getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
  }).journalDirectory)
  const descriptors = new Map<number, string>()
  let failDirectorySync = false
  let failed = false
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
          const descriptor = fs.openSync(filePath, flags, mode)
          descriptors.set(descriptor, path.resolve(String(filePath)))
          return descriptor
        }
      }
      if (property === "closeSync") {
        return (descriptor: number): void => {
          descriptors.delete(descriptor)
          fs.closeSync(descriptor)
        }
      }
      if (property === "renameSync") {
        return (from: fs.PathLike, to: fs.PathLike): void => {
          fs.renameSync(from, to)
          if (String(to).includes(`${path.sep}journal${path.sep}`)) {
            const journal = readJson(String(to))
            if (journal.state === state) failDirectorySync = true
          }
        }
      }
      if (property === "fsyncSync") {
        return (descriptor: number): void => {
          if (
            failDirectorySync
            && !failed
            && descriptors.get(descriptor) === journalDirectory
          ) {
            failed = true
            failDirectorySync = false
            throw new Error(`synthetic ${state} directory fsync failure`)
          }
          fs.fsyncSync(descriptor)
        }
      }
      return Reflect.get(target, property)
    },
  }) as typeof fs
}

function traceRecoveryDurability(agentRoot: string, definitionPath: string): {
  fs: typeof fs
  events: string[]
} {
  const paths = getHabitLifecyclePaths({ agentRoot, habitId: SYNTHETIC_HABIT_ID })
  const watchedDirectories = new Map([
    [path.resolve(paths.journalDirectory), "journal:fsync"],
    [path.resolve(path.dirname(definitionPath)), "definition:fsync"],
    [path.resolve(paths.receiptsDirectory), "receipt:fsync"],
  ])
  const descriptors = new Map<number, string>()
  const events: string[] = []
  return {
    events,
    fs: new Proxy(fs, {
      get(target, property) {
        if (property === "openSync") {
          return (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const descriptor = fs.openSync(filePath, flags, mode)
            descriptors.set(descriptor, path.resolve(String(filePath)))
            return descriptor
          }
        }
        if (property === "closeSync") {
          return (descriptor: number): void => {
            descriptors.delete(descriptor)
            fs.closeSync(descriptor)
          }
        }
        if (property === "fsyncSync") {
          return (descriptor: number): void => {
            const event = watchedDirectories.get(descriptors.get(descriptor) ?? "")
            if (event) events.push(event)
            fs.fsyncSync(descriptor)
          }
        }
        if (property === "renameSync") {
          return (from: fs.PathLike, to: fs.PathLike): void => {
            if (path.resolve(String(to)) === path.resolve(definitionPath)) events.push("definition:rename")
            fs.renameSync(from, to)
          }
        }
        if (property === "linkSync") {
          return (from: fs.PathLike, to: fs.PathLike): void => {
            if (String(to).includes(`${path.sep}receipts${path.sep}`)) events.push("receipt:link")
            fs.linkSync(from, to)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs,
  }
}

function trackDirectoryFsyncs(directories: Set<string>): { fs: typeof fs; synced: Set<string> } {
  const descriptors = new Map<number, string>()
  const synced = new Set<string>()
  return {
    synced,
    fs: new Proxy(fs, {
      get(target, property) {
        if (property === "openSync") {
          return (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const descriptor = fs.openSync(filePath, flags, mode)
            const resolved = path.resolve(String(filePath))
            if (directories.has(resolved)) descriptors.set(descriptor, resolved)
            return descriptor
          }
        }
        if (property === "fsyncSync") {
          return (descriptor: number): void => {
            const directory = descriptors.get(descriptor)
            if (directory) synced.add(directory)
            fs.fsyncSync(descriptor)
          }
        }
        if (property === "closeSync") {
          return (descriptor: number): void => {
            descriptors.delete(descriptor)
            fs.closeSync(descriptor)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs,
  }
}

function blockReleaseAfterCommit(agentRoot: string): {
  fs: typeof fs
  close: () => void
} {
  const coordinationPath = getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
  }).coordination
  let blocker: Database.Database | null = null
  const adapter = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (from: fs.PathLike, to: fs.PathLike): void => {
          fs.renameSync(from, to)
          if (String(to).includes(`${path.sep}journal${path.sep}`)) {
            const journal = readJson(String(to))
            if (journal.state === "cancellation_receipt_committed" && blocker === null) {
              blocker = new Database(coordinationPath)
              blocker.exec("BEGIN IMMEDIATE")
            }
          }
        }
      }
      return Reflect.get(target, property)
    },
  }) as typeof fs
  return {
    fs: adapter,
    close: () => {
      if (!blocker) return
      blocker.exec("ROLLBACK")
      blocker.close()
      blocker = null
    },
  }
}

function failOwnerInspectionAfterCommit(agentRoot: string): {
  fs: typeof fs
  recover: () => void
} {
  const ownerPath = getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
  }).owner
  let failing = false
  return {
    fs: new Proxy(fs, {
      get(target, property) {
        if (property === "renameSync") {
          return (from: fs.PathLike, to: fs.PathLike): void => {
            fs.renameSync(from, to)
            if (String(to).includes(`${path.sep}journal${path.sep}`)) {
              const journal = readJson(String(to))
              if (journal.state === "cancellation_receipt_committed") failing = true
            }
          }
        }
        if (property === "lstatSync") {
          return (targetPath: fs.PathLike): fs.Stats => {
            if (failing && path.resolve(String(targetPath)) === path.resolve(ownerPath)) {
              throw Object.assign(new Error("synthetic owner inspection failure"), { code: "EIO" })
            }
            return fs.lstatSync(targetPath)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs,
    recover: () => { failing = false },
  }
}

function failOwnerUnlinkAfterCommit(agentRoot: string): {
  fs: typeof fs
  recover: () => void
} {
  const ownerPath = path.resolve(getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
  }).owner)
  let failing = false
  return {
    fs: new Proxy(fs, {
      get(target, property) {
        if (property === "renameSync") {
          return (from: fs.PathLike, to: fs.PathLike): void => {
            fs.renameSync(from, to)
            if (String(to).includes(`${path.sep}journal${path.sep}`)) {
              const journal = readJson(String(to))
              if (journal.state === "cancellation_receipt_committed") failing = true
            }
          }
        }
        if (property === "unlinkSync") {
          return (targetPath: fs.PathLike): void => {
            if (failing && path.resolve(String(targetPath)) === ownerPath) {
              throw Object.assign(new Error("synthetic owner unlink failure"), { code: "EIO" })
            }
            fs.unlinkSync(targetPath)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs,
    recover: () => { failing = false },
  }
}

function missFirstOwnerInspectionAfterCommit(agentRoot: string): typeof fs {
  const ownerPath = path.resolve(getHabitLifecyclePaths({
    agentRoot,
    habitId: SYNTHETIC_HABIT_ID,
  }).owner)
  let missNextOwnerInspection = false
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (from: fs.PathLike, to: fs.PathLike): void => {
          fs.renameSync(from, to)
          if (String(to).includes(`${path.sep}journal${path.sep}`)) {
            const journal = readJson(String(to))
            if (journal.state === "cancellation_receipt_committed") missNextOwnerInspection = true
          }
        }
      }
      if (property === "lstatSync") {
        return (targetPath: fs.PathLike): fs.Stats => {
          if (missNextOwnerInspection && path.resolve(String(targetPath)) === ownerPath) {
            missNextOwnerInspection = false
            return { isFile: () => false } as fs.Stats
          }
          return fs.lstatSync(targetPath)
        }
      }
      return Reflect.get(target, property)
    },
  }) as typeof fs
}

afterEach(async () => {
  const children = [...activeChildren].filter((child) => child.exitCode === null && child.signalCode === null)
  const closed = children.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve())))
  for (const child of children) child.kill("SIGKILL")
  await Promise.all(closed)
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { force: true, recursive: true })
  }
})

describe("grounded habit cancellation evidence", () => {
  it("projects only a non-self inbound message actor and exact request bytes from a matching capture", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    const receipt = await cancelCapture(agentRoot, capture)

    expect(receipt.evidenceLocator).toEqual({ kind: "capture", id: capture.capture.keyHash })
    expect(receipt.actor).toEqual({
      displayName: SYNTHETIC_ACTOR,
      provider: "imessage-handle",
      externalId: "casey@example.invalid",
    })
    expect(receipt.request).toEqual({
      text: SYNTHETIC_REQUEST,
      sha256: sha256Utf8(SYNTHETIC_REQUEST),
      observedAt: SYNTHETIC_CAPTURED_AT,
    })
    expect(JSON.stringify(receipt)).not.toContain(SYNTHETIC_PARTICIPANT)
    expect(receipt.acknowledgement).not.toContain(SYNTHETIC_PARTICIPANT)
  })

  it("rejects missing, mismatched, self-authored, non-message, digestless, or actorless capture evidence before lifecycle mutation", async () => {
    const cases: Array<(agentRoot: string) => {
      capture: SyntheticCaptureEvidence
      mutate?: (capture: SyntheticCaptureEvidence) => void
      authority?: HabitCancellationAuthority
    }> = [
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        fs.unlinkSync(capture.path)
        return { capture }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          authority: {
            kind: "current_ingress",
            currentIngressEvidence: {
              schemaVersion: 1,
              provider: "bluebubbles",
              captureKeyHash: "f".repeat(64),
            },
          },
        }
      },
      (agentRoot) => ({ capture: writeSyntheticCaptureEvidence(agentRoot, { fromMe: true }) }),
      (agentRoot) => ({ capture: writeSyntheticCaptureEvidence(agentRoot, {
        text: "",
        textSha256: sha256Utf8(""),
      }) }),
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.event.kind = "reaction"
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.capturedAt = "2026-07-01T11:58:59.999Z"
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.keyHash = "f".repeat(64)
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.event.provider = "other-provider"
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.event.textSha256 = null
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.event.textSha256 = "f".repeat(64)
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => ({ capture: writeSyntheticCaptureEvidence(agentRoot, {
        actor: {
          provider: "imessage-handle",
          externalId: "",
          displayName: SYNTHETIC_ACTOR,
        },
      }) }),
      (agentRoot) => ({ capture: writeSyntheticCaptureEvidence(agentRoot, {
        actor: {
          provider: "imessage-handle",
          externalId: "casey@example.invalid",
          displayName: null,
        },
      }) }),
      (agentRoot) => ({ capture: writeSyntheticCaptureEvidence(agentRoot, {
        actor: {
          provider: "imessage-handle",
          externalId: "casey@example.invalid",
          displayName: "",
        },
      }) }),
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.event.actor.provider = "routing-metadata"
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.canonicalKey = JSON.stringify(["invented"])
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: (current) => {
            const value = readJson(current.path)
            value.providerNamespace = "ffffffff-ffff-4fff-8fff-ffffffffffff"
            writeJson(current.path, value)
          },
        }
      },
      (agentRoot) => {
        const capture = writeSyntheticCaptureEvidence(agentRoot)
        return {
          capture,
          mutate: () => {
            const cutoverPath = path.join(
              agentRoot,
              "state",
              "senses",
              "bluebubbles",
              "semantic-receipts",
              "cutover.json",
            )
            const cutover = readJson(cutoverPath)
            cutover.providerNamespace = "ffffffff-ffff-4fff-8fff-ffffffffffff"
            writeJson(cutoverPath, cutover)
          },
        }
      },
    ]

    for (const arrange of cases) {
      const agentRoot = temporaryAgentRoot()
      const definition = writeSyntheticHabitDefinition(agentRoot)
      const arranged = arrange(agentRoot)
      arranged.mutate?.(arranged.capture)
      await expect(cancelHabit({
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: arranged.capture.locator,
        authority: arranged.authority ?? captureAuthority(arranged.capture),
      }, lifecycleDeps())).rejects.toThrow(/evidence|capture|actor|message/i)
      expect(fs.existsSync(lifecycleRoot(agentRoot))).toBe(false)
      expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
    }
  })

  it("rejects malformed authority shapes, offline captures, and missing cutover authority", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const invalidInputs: HabitCancelInput[] = [
      {
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: capture.locator,
        authority: null as unknown as HabitCancellationAuthority,
      },
      {
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: "synthetic-bridge",
        authority: captureAuthority(capture),
      },
      {
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: capture.locator,
        authority: { kind: "invented" } as unknown as HabitCancellationAuthority,
      },
      {
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: capture.locator,
        authority: offlineAuthority(),
      },
      {
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceLocator: capture.locator,
        authority: {
          kind: "current_ingress",
          currentIngressEvidence: {
            schemaVersion: 1,
            provider: "bluebubbles",
            captureKeyHash: capture.capture.keyHash,
            extra: true,
          },
        } as unknown as HabitCancellationAuthority,
      },
    ]
    for (const input of invalidInputs) {
      await expect(cancelHabit(input, lifecycleDeps())).rejects.toThrow(/authority|capture|evidence/i)
    }
    const cutoverPath = path.join(
      agentRoot,
      "state",
      "senses",
      "bluebubbles",
      "semantic-receipts",
      "cutover.json",
    )
    fs.unlinkSync(cutoverPath)
    await expect(cancelCapture(agentRoot, capture)).rejects.toThrow(/cutover/i)
    expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
    expect(fs.existsSync(lifecycleRoot(agentRoot))).toBe(false)
  })

  it("wraps unexpected preflight failures while still emitting a paired diagnostic event", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.component === "daemon" && entry.event.startsWith("habit_cancel_")) events.push(entry)
    })
    const hostileInput = new Proxy({
      agentRoot: temporaryAgentRoot(),
      habitId: SYNTHETIC_HABIT_ID,
      evidenceLocator: `capture:${"a".repeat(64)}`,
      authority: offlineAuthority(),
    }, {
      get(target, property, receiver) {
        if (property === "authority") throw new Error("synthetic unexpected preflight failure")
        return Reflect.get(target, property, receiver)
      },
    }) as HabitCancelInput
    try {
      await expect(cancelHabit(hostileInput, lifecycleDeps()))
        .rejects.toThrow(/habit_cancellation_failed/)
    } finally {
      unregister()
    }
    expect(events.map((entry) => entry.event)).toEqual(["habit_cancel_start", "habit_cancel_error"])
    expect(events[0].meta).toEqual(expect.objectContaining({
      habitId: SYNTHETIC_HABIT_ID,
      operationId: null,
      evidenceKeyHash: null,
    }))
  })

  it("fails before mutation when grounded evidence changes between preflight and locked revalidation", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    let captureReads = 0
    const changingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "readFileSync") {
          return (filePath: fs.PathOrFileDescriptor, ...args: unknown[]): unknown => {
            if (path.resolve(String(filePath)) === path.resolve(capture.path)) {
              captureReads += 1
              if (captureReads === 2) {
                const value = readJson(capture.path)
                value.event.actor.displayName = "Changed synthetic requester"
                writeJson(capture.path, value)
              }
            }
            return Reflect.apply(fs.readFileSync, fs, [filePath, ...args] as Parameters<typeof fs.readFileSync>)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({ fs: changingFs })))
      .rejects.toThrow(/evidence.*changed/i)
    expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
  })

  it("validates the exact bridge shape, source hashes, unique request, session normalization, and participant-only role", () => {
    const agentRoot = temporaryAgentRoot()
    const bridge = writeSyntheticBridgeEvidence(agentRoot)
    const trustedBridge = vi.fn((_bridgeId: string, _sha256: string) => ({
      cancellationReason: SYNTHETIC_CANCELLATION_REASON,
    }))

    const evidence = validateHabitEvidenceBridge({
      agentRoot,
      bridgeId: bridge.bridgeId,
    }, lifecycleDeps({ trustedBridge }))

    expect(evidence).toEqual({
      locator: { kind: "bridge", id: bridge.bridgeId },
      actor: { displayName: SYNTHETIC_ACTOR, provider: null, externalId: null },
      request: {
        text: SYNTHETIC_REQUEST,
        sha256: sha256Utf8(SYNTHETIC_REQUEST),
        observedAt: SYNTHETIC_CAPTURED_AT,
      },
      cancellationReason: SYNTHETIC_CANCELLATION_REASON,
    })

    const bridgeValue = readJson(bridge.bridgePath)
    expect(bridgeValue.participants).toEqual([{
      displayName: SYNTHETIC_PARTICIPANT,
      provider: null,
      externalId: null,
      role: "group_participant_only",
    }])
    expect(trustedBridge).toHaveBeenCalledWith(bridge.bridgeId, bridge.bridgeSha256)
    const bridgeBytes = fs.readFileSync(bridge.bridgePath, "utf8")
    expect(bridgeBytes).toBe(`${JSON.stringify(bridgeValue, null, 2)}\n`)
    expect(bridgeBytes.endsWith("\n\n")).toBe(false)
  })

  it("validates durable screenshot copies without depending on volatile source attachments", () => {
    const agentRoot = temporaryAgentRoot()
    const bridge = writeSyntheticBridgeEvidence(agentRoot)
    const value = readJson(bridge.bridgePath)
    for (const screenshot of value.evidence.screenshots) fs.unlinkSync(screenshot.sourcePath)

    expect(validateHabitEvidenceBridge({
      agentRoot,
      bridgeId: bridge.bridgeId,
    }, lifecycleDeps())).toMatchObject({
      locator: { kind: "bridge", id: bridge.bridgeId },
      actor: { displayName: SYNTHETIC_ACTOR },
    })
  })

  it("cancels from a fully validated offline bridge without importing participant roles", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const bridge = writeSyntheticBridgeEvidence(agentRoot)

    const receipt = await cancelBridge(agentRoot, bridge)

    expect(receipt.evidenceLocator).toEqual({ kind: "bridge", id: bridge.bridgeId })
    expect(receipt.actor).toEqual({ displayName: SYNTHETIC_ACTOR, provider: null, externalId: null })
    expect(receipt.acknowledgement).not.toContain(SYNTHETIC_PARTICIPANT)
    expect(fs.readFileSync(path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`), "utf8"))
      .toContain(`cancelledEvidence: ${bridge.bridgeId}`)
  })

  it("pins the production historical bridge to the independently recorded manifest digest", async () => {
    expect(HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256).toBe(
      "34a90f6ce3f7b092edb8114cf7ab640486fd7e6d7667acfd0249408fff394201",
    )
    expect(resolveHistoricalHabitEvidenceBridgeTrust(
      HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256,
      SYNTHETIC_ACTOR,
    )).toEqual({
      cancellationReason:
        `Confirmed requester ${SYNTHETIC_ACTOR} asked to end the RSVP report after the wedding.`,
    })
    expect(resolveHistoricalHabitEvidenceBridgeTrust("f".repeat(64), SYNTHETIC_ACTOR)).toBeNull()
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const bridge = writeSyntheticBridgeEvidence(agentRoot)
    await expect(cancelBridge(agentRoot, bridge, lifecycleDeps({ trustedBridge: undefined })))
      .rejects.toThrow(/bridge.*trust/i)
    expect(fs.existsSync(lifecycleRoot(agentRoot))).toBe(false)
    expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
  })

  it("rejects a renamed/retitled, untrusted, duplicate-request, or session-normalization bridge before lifecycle mutation", async () => {
    const mutations: Array<(bridge: SyntheticBridgeEvidence) => void> = [
      (bridge) => {
        const value = readJson(bridge.bridgePath)
        value.bridgeId = `${value.bridgeId}-different`
        writeJson(bridge.bridgePath, value)
      },
      (bridge) => {
        const value = readJson(bridge.bridgePath)
        value.extra = true
        writeJson(bridge.bridgePath, value)
      },
      (bridge) => {
        const value = readJson(bridge.bridgePath)
        const inbound = value.evidence.sources[0]
        const row = fs.readFileSync(inbound.path, "utf8")
        fs.writeFileSync(inbound.path, `${row}${row}`, "utf8")
        inbound.fileSha256 = sha256Utf8(fs.readFileSync(inbound.path))
        writeJson(bridge.bridgePath, value)
      },
      (bridge) => {
        const value = readJson(bridge.bridgePath)
        const session = value.evidence.sources[1]
        const sessionValue = readJson(session.path)
        sessionValue.events[0].content = `${SYNTHETIC_ACTOR}: ${SYNTHETIC_REQUEST} `
        writeJson(session.path, sessionValue)
        session.fileSha256 = sha256Utf8(fs.readFileSync(session.path))
        writeJson(bridge.bridgePath, value)
      },
    ]

    for (const mutate of mutations) {
      const agentRoot = temporaryAgentRoot()
      const definition = writeSyntheticHabitDefinition(agentRoot)
      const bridge = writeSyntheticBridgeEvidence(agentRoot)
      mutate(bridge)
      await expect(cancelBridge(agentRoot, bridge)).rejects.toThrow(/bridge|evidence|request|session/i)
      expect(fs.existsSync(lifecycleRoot(agentRoot))).toBe(false)
      expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
    }

    const untrustedRoot = temporaryAgentRoot()
    const untrustedDefinition = writeSyntheticHabitDefinition(untrustedRoot)
    const untrusted = writeSyntheticBridgeEvidence(untrustedRoot)
    await expect(cancelBridge(untrustedRoot, untrusted, lifecycleDeps({
      trustedBridge: () => null,
    }))).rejects.toThrow(/bridge.*trust/i)
    expect(fs.existsSync(lifecycleRoot(untrustedRoot))).toBe(false)
    expect(fs.readFileSync(untrustedDefinition.path, "utf8")).toBe(untrustedDefinition.bytes)
  })

  it("rejects every malformed bridge record, artifact, and source relationship", () => {
    type Mutation = (
      bridge: SyntheticBridgeEvidence,
      value: Record<string, any>,
    ) => boolean | void
    const rewriteSource = (source: Record<string, any>, value: unknown): void => {
      writeJson(source.path, value)
      source.fileSha256 = sha256Utf8(fs.readFileSync(source.path))
    }
    const cases: Array<[string, Mutation]> = [
      ["non-canonical manifest", (bridge) => {
        fs.appendFileSync(bridge.bridgePath, "\n", "utf8")
        return false
      }],
      ["invalid manifest JSON", (bridge) => {
        fs.writeFileSync(bridge.bridgePath, "{\n", "utf8")
        return false
      }],
      ["non-record manifest", (bridge) => {
        fs.writeFileSync(bridge.bridgePath, "[]\n", "utf8")
        return false
      }],
      ["missing top-level key", (_bridge, value) => { delete value.schemaVersion }],
      ["schema version", (_bridge, value) => { value.schemaVersion = 2 }],
      ["embedded bridge id", (_bridge, value) => { value.bridgeId = `${value.bridgeId}-other` }],
      ["source kind", (_bridge, value) => { value.sourceKind = "other" }],
      ["created timestamp", (_bridge, value) => { value.createdAt = "2026-07-01T12:00:00Z" }],
      ["confirmed timestamp", (_bridge, value) => { value.confirmedAt = "2026-07-01T12:00:01.000Z" }],
      ["actor record", (_bridge, value) => { value.actor = null }],
      ["actor keys", (_bridge, value) => { value.actor.extra = true }],
      ["actor display", (_bridge, value) => { value.actor.displayName = "" }],
      ["actor display line", (_bridge, value) => { value.actor.displayName = "Casey\nInvented" }],
      ["actor provider", (_bridge, value) => { value.actor.provider = "invented" }],
      ["actor external id", (_bridge, value) => { value.actor.externalId = "invented" }],
      ["participants shape", (_bridge, value) => { value.participants = null }],
      ["participants empty", (_bridge, value) => { value.participants = [] }],
      ["participant record", (_bridge, value) => { value.participants[0] = null }],
      ["participant keys", (_bridge, value) => { value.participants[0].extra = true }],
      ["participant display", (_bridge, value) => { value.participants[0].displayName = "" }],
      ["participant provider", (_bridge, value) => { value.participants[0].provider = "invented" }],
      ["participant external id", (_bridge, value) => { value.participants[0].externalId = "invented" }],
      ["participant role", (_bridge, value) => { value.participants[0].role = "requester" }],
      ["request record", (_bridge, value) => { value.request = null }],
      ["request keys", (_bridge, value) => { value.request.extra = true }],
      ["request guid", (_bridge, value) => { value.request.eventGuid = "" }],
      ["request text", (_bridge, value) => { value.request.text = "" }],
      ["request hash format", (_bridge, value) => { value.request.sha256 = "INVALID" }],
      ["request digest", (_bridge, value) => { value.request.text += " changed" }],
      ["evidence record", (_bridge, value) => { value.evidence = null }],
      ["evidence keys", (_bridge, value) => { value.evidence.extra = true }],
      ["confirmation record", (_bridge, value) => { value.evidence.operatorConfirmation = null }],
      ["confirmation keys", (_bridge, value) => { value.evidence.operatorConfirmation.extra = true }],
      ["confirmation traversal", (_bridge, value) => { value.evidence.operatorConfirmation.path = "../confirmation.md" }],
      ["confirmation dot path", (_bridge, value) => { value.evidence.operatorConfirmation.path = "." }],
      ["confirmation hash format", (_bridge, value) => { value.evidence.operatorConfirmation.sha256 = "INVALID" }],
      ["confirmation missing", (bridge, value) => {
        fs.unlinkSync(path.join(path.dirname(bridge.bridgePath), value.evidence.operatorConfirmation.path))
      }],
      ["confirmation digest", (bridge, value) => {
        fs.appendFileSync(path.join(path.dirname(bridge.bridgePath), value.evidence.operatorConfirmation.path), "changed", "utf8")
      }],
      ["confirmation missing LF", (bridge, value) => {
        const target = path.join(path.dirname(bridge.bridgePath), value.evidence.operatorConfirmation.path)
        const bytes = fs.readFileSync(target, "utf8").replace(/\n$/, "")
        fs.writeFileSync(target, bytes, "utf8")
        value.evidence.operatorConfirmation.sha256 = sha256Utf8(bytes)
      }],
      ["confirmation duplicate LF", (bridge, value) => {
        const target = path.join(path.dirname(bridge.bridgePath), value.evidence.operatorConfirmation.path)
        fs.appendFileSync(target, "\n", "utf8")
        value.evidence.operatorConfirmation.sha256 = sha256Utf8(fs.readFileSync(target))
      }],
      ["confirmation CR", (bridge, value) => {
        const target = path.join(path.dirname(bridge.bridgePath), value.evidence.operatorConfirmation.path)
        fs.appendFileSync(target, "\r", "utf8")
        value.evidence.operatorConfirmation.sha256 = sha256Utf8(fs.readFileSync(target))
      }],
      ["screenshots shape", (_bridge, value) => { value.evidence.screenshots = null }],
      ["screenshots length", (_bridge, value) => { value.evidence.screenshots.pop() }],
      ["screenshot record", (_bridge, value) => { value.evidence.screenshots[0] = null }],
      ["screenshot keys", (_bridge, value) => { value.evidence.screenshots[0].extra = true }],
      ["screenshot index", (_bridge, value) => { value.evidence.screenshots[0].index = 2 }],
      ["screenshot source path", (_bridge, value) => { value.evidence.screenshots[0].sourcePath = "relative.jpg" }],
      ["screenshot artifact traversal", (_bridge, value) => { value.evidence.screenshots[0].artifactPath = "../copy.jpg" }],
      ["screenshot hash", (_bridge, value) => { value.evidence.screenshots[0].sha256 = "INVALID" }],
      ["screenshot missing", (bridge, value) => {
        fs.unlinkSync(path.join(path.dirname(bridge.bridgePath), value.evidence.screenshots[0].artifactPath))
      }],
      ["screenshot digest", (bridge, value) => {
        fs.appendFileSync(path.join(path.dirname(bridge.bridgePath), value.evidence.screenshots[0].artifactPath), "changed")
      }],
      ["sources shape", (_bridge, value) => { value.evidence.sources = null }],
      ["sources length", (_bridge, value) => { value.evidence.sources.pop() }],
      ["inbound record", (_bridge, value) => { value.evidence.sources[0] = null }],
      ["inbound keys", (_bridge, value) => { value.evidence.sources[0].extra = true }],
      ["inbound role", (_bridge, value) => { value.evidence.sources[0].role = "other" }],
      ["inbound guid", (_bridge, value) => { value.evidence.sources[0].eventGuid = "other" }],
      ["inbound request hash", (_bridge, value) => { value.evidence.sources[0].requestSha256 = "f".repeat(64) }],
      ["inbound source path", (_bridge, value) => { value.evidence.sources[0].path = "" }],
      ["inbound file hash", (_bridge, value) => { value.evidence.sources[0].fileSha256 = "INVALID" }],
      ["inbound missing", (_bridge, value) => { fs.unlinkSync(value.evidence.sources[0].path) }],
      ["inbound file digest", (_bridge, value) => { fs.appendFileSync(value.evidence.sources[0].path, "changed") }],
      ["inbound JSON", (_bridge, value) => {
        const source = value.evidence.sources[0]
        fs.writeFileSync(source.path, "{\n", "utf8")
        source.fileSha256 = sha256Utf8(fs.readFileSync(source.path))
      }],
      ["inbound row record", (_bridge, value) => {
        const source = value.evidence.sources[0]
        fs.writeFileSync(source.path, "[]\n", "utf8")
        source.fileSha256 = sha256Utf8(fs.readFileSync(source.path))
      }],
      ["inbound duplicate", (_bridge, value) => {
        const source = value.evidence.sources[0]
        fs.appendFileSync(source.path, fs.readFileSync(source.path))
        source.fileSha256 = sha256Utf8(fs.readFileSync(source.path))
      }],
      ["inbound request text", (_bridge, value) => {
        const source = value.evidence.sources[0]
        rewriteSource(source, { messageGuid: value.request.eventGuid, textForAgent: "different" })
      }],
      ["session record", (_bridge, value) => { value.evidence.sources[1] = null }],
      ["session keys", (_bridge, value) => { value.evidence.sources[1].extra = true }],
      ["session role", (_bridge, value) => { value.evidence.sources[1].role = "other" }],
      ["session request hash", (_bridge, value) => { value.evidence.sources[1].normalizedRequestSha256 = "f".repeat(64) }],
      ["session events", (_bridge, value) => { rewriteSource(value.evidence.sources[1], { events: null }) }],
      ["session event missing", (_bridge, value) => { rewriteSource(value.evidence.sources[1], { events: [] }) }],
      ["session content", (_bridge, value) => {
        rewriteSource(value.evidence.sources[1], { events: [{ id: value.evidence.sources[1].eventId, content: null }] })
      }],
      ["session prefix", (_bridge, value) => {
        rewriteSource(value.evidence.sources[1], { events: [{ id: value.evidence.sources[1].eventId, content: value.request.text }] })
      }],
      ["session normalized text", (_bridge, value) => {
        rewriteSource(value.evidence.sources[1], { events: [{ id: value.evidence.sources[1].eventId, content: `Casey: ${value.request.text} ` }] })
      }],
      ["context record", (_bridge, value) => { value.evidence.sources[2] = null }],
      ["context keys", (_bridge, value) => { value.evidence.sources[2].extra = true }],
      ["context role", (_bridge, value) => { value.evidence.sources[2].role = "other" }],
      ["context guid", (_bridge, value) => { value.evidence.sources[2].eventGuid = "other" }],
      ["context anchor", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], { anchorMessageGuid: "other", messages: [{}, {}] })
      }],
      ["context messages", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], { anchorMessageGuid: value.request.eventGuid, messages: null })
      }],
      ["context message count", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], { anchorMessageGuid: value.request.eventGuid, messages: [] })
      }],
      ["context message record", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], { anchorMessageGuid: value.request.eventGuid, messages: [null, null] })
      }],
      ["context author", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], {
          anchorMessageGuid: value.request.eventGuid,
          messages: [
            { authorLabel: null, bodyPreview: "one", timestamp: SYNTHETIC_CAPTURED_AT },
            { authorLabel: "Agent", bodyPreview: "two", timestamp: SYNTHETIC_CAPTURED_AT },
          ],
        })
      }],
      ["context preview", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], {
          anchorMessageGuid: value.request.eventGuid,
          messages: [
            { authorLabel: "Agent", bodyPreview: null, timestamp: SYNTHETIC_CAPTURED_AT },
            { authorLabel: "Agent", bodyPreview: "two", timestamp: SYNTHETIC_CAPTURED_AT },
          ],
        })
      }],
      ["context timestamp", (_bridge, value) => {
        rewriteSource(value.evidence.sources[2], {
          anchorMessageGuid: value.request.eventGuid,
          messages: [
            { authorLabel: "Agent", bodyPreview: "one", timestamp: null },
            { authorLabel: "Agent", bodyPreview: "two", timestamp: SYNTHETIC_CAPTURED_AT },
          ],
        })
      }],
    ]

    for (const [name, mutate] of cases) {
      const agentRoot = temporaryAgentRoot()
      const bridge = writeSyntheticBridgeEvidence(agentRoot)
      const value = readJson(bridge.bridgePath)
      const rewriteManifest = mutate(bridge, value) !== false
      if (rewriteManifest) writeJson(bridge.bridgePath, value)
      expect(
        () => validateHabitEvidenceBridge({ agentRoot, bridgeId: bridge.bridgeId }, lifecycleDeps()),
        name,
      ).toThrow(/bridge/i)
    }
  })

  it("rejects invalid bridge roots, identifiers, and trust metadata", () => {
    expect(() => validateHabitEvidenceBridge({ agentRoot: "", bridgeId: "synthetic" }, lifecycleDeps()))
      .toThrow(/agent.root/i)
    for (const bridgeId of ["", ".", "..", "../bridge", "bridge/path"]) {
      expect(() => validateHabitEvidenceBridge({ agentRoot: temporaryAgentRoot(), bridgeId }, lifecycleDeps()))
        .toThrow(/bridge.*id/i)
    }

    const missingRoot = temporaryAgentRoot()
    expect(() => validateHabitEvidenceBridge({ agentRoot: missingRoot, bridgeId: "synthetic" }, lifecycleDeps()))
      .toThrow(/bridge.*missing/i)

    const agentRoot = temporaryAgentRoot()
    const bridge = writeSyntheticBridgeEvidence(agentRoot)
    expect(() => validateHabitEvidenceBridge({ agentRoot, bridgeId: bridge.bridgeId }, lifecycleDeps({
      trustedBridge: () => ({ cancellationReason: "invented\nreason" }),
    }))).toThrow(/cancellation.reason/i)
  })
})

describe("atomic habit cancellation", () => {
  it("emits exact paired cancellation lifecycle events with stable operation identity", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.component === "daemon" && entry.event.startsWith("habit_cancel_")) events.push(entry)
    })
    let receipt
    try {
      receipt = await cancelCapture(agentRoot, capture)
    } finally {
      unregister()
    }

    expect(events.map((entry) => entry.event)).toEqual(["habit_cancel_start", "habit_cancel_end"])
    expect(events.map((entry) => entry.meta)).toEqual([
      expect.objectContaining({
        habitId: SYNTHETIC_HABIT_ID,
        operationId: receipt.operationId,
        evidenceKeyHash: receipt.evidenceKeyHash,
      }),
      expect.objectContaining({
        habitId: SYNTHETIC_HABIT_ID,
        operationId: receipt.operationId,
        evidenceKeyHash: receipt.evidenceKeyHash,
      }),
    ])
  })

  it("rejects missing or degraded definitions without creating cancellation authority", async () => {
    for (const definitionBytes of [null, "---\nstatus: invented\n---\n\nDo not run.\n"]) {
      const agentRoot = temporaryAgentRoot()
      const capture = writeSyntheticCaptureEvidence(agentRoot)
      const definitionPath = path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
      if (definitionBytes !== null) {
        fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
        fs.writeFileSync(definitionPath, definitionBytes, "utf8")
      }
      await expect(cancelCapture(agentRoot, capture)).rejects.toThrow(/definition|habit/i)
      expect(fs.existsSync(lifecycleRoot(agentRoot))).toBe(false)
      if (definitionBytes === null) {
        expect(fs.existsSync(definitionPath)).toBe(false)
      } else {
        expect(fs.readFileSync(definitionPath, "utf8")).toBe(definitionBytes)
      }
    }
  })

  it("rejects invalid habit identifiers, clocks, and already-cancelled definitions", async () => {
    const invalidRoot = temporaryAgentRoot()
    const invalidCapture = writeSyntheticCaptureEvidence(invalidRoot)
    await expect(cancelHabit({
      agentRoot: invalidRoot,
      habitId: "../invalid",
      evidenceLocator: invalidCapture.locator,
      authority: captureAuthority(invalidCapture),
    }, lifecycleDeps())).rejects.toThrow(/habit|definition|id/i)

    const clockRoot = temporaryAgentRoot()
    const clockDefinition = writeSyntheticHabitDefinition(clockRoot)
    const clockCapture = writeSyntheticCaptureEvidence(clockRoot)
    await expect(cancelCapture(clockRoot, clockCapture, lifecycleDeps({
      now: () => new Date(Number.NaN),
    }))).rejects.toThrow(/clock/i)
    expect(fs.readFileSync(clockDefinition.path, "utf8")).toBe(clockDefinition.bytes)

    const cancelledRoot = temporaryAgentRoot()
    const cancelledPath = path.join(cancelledRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
    fs.mkdirSync(path.dirname(cancelledPath), { recursive: true })
    fs.writeFileSync(cancelledPath, "---\nstatus: cancelled\n---\nAlready ended.\n", "utf8")
    const cancelledCapture = writeSyntheticCaptureEvidence(cancelledRoot)
    await expect(cancelCapture(cancelledRoot, cancelledCapture))
      .rejects.toThrow(/already.cancelled/i)
  })

  it("times out behind a distinct live owner for the same cancellation operation", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const identity = buildHabitEvidenceIdentity({
      habitId: SYNTHETIC_HABIT_ID,
      kind: "capture",
      id: capture.capture.keyHash,
    })
    const operation = buildHabitCancellationOperation(identity.evidenceKeyHash)
    let tick = Date.parse(SYNTHETIC_CANCELLED_AT)
    const deps = lifecycleDeps({
      now: () => new Date((tick += 6_000)),
      sleep: async () => undefined,
    })
    const lock = await acquireHabitLifecycleLock({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
      operationId: operation.operationId,
    }, deps)
    expect(lock.status).toBe("acquired")
    if (lock.status !== "acquired") return
    try {
      await expect(cancelCapture(agentRoot, capture, deps)).rejects.toThrow(/lock.*timeout/i)
    } finally {
      expect(releaseHabitLifecycleLock(lock.lease, deps)).toBe(true)
    }
  })

  it.each(["active", "paused"] as const)(
    "atomically transitions %s to cancelled while preserving unrelated definition bytes",
    async (fromStatus) => {
      const agentRoot = temporaryAgentRoot()
      const definition = writeSyntheticHabitDefinition(agentRoot, fromStatus)
      const capture = writeSyntheticCaptureEvidence(agentRoot)

      const receipt = await cancelCapture(agentRoot, capture)
      const cancelled = fs.readFileSync(definition.path, "utf8")

      expect(receipt.transition).toEqual({
        fromStatus,
        toStatus: "cancelled",
        cancelledAt: SYNTHETIC_CANCELLED_AT,
        boundaryState: "not_crossed",
      })
      expect(cancelled).toBe(definition.bytes
        .replace(`status: ${fromStatus}`, [
          "status: cancelled",
          `cancelledAt: ${SYNTHETIC_CANCELLED_AT}`,
          `cancelledEvidence: capture:${capture.capture.keyHash}`,
          `cancelledReason: Confirmed requester ${SYNTHETIC_ACTOR} asked to end this habit.`,
        ].join("\n")))
    },
  )

  it("returns the stored receipt byte-for-byte for an already-cancelled duplicate", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const first = await cancelCapture(agentRoot, capture)
    const firstDefinition = fs.readFileSync(definition.path, "utf8")
    const receiptPath = getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
      evidenceKeyHash: first.evidenceKeyHash,
    }).receipt!
    const receiptBytes = fs.readFileSync(receiptPath, "utf8")

    const second = await cancelCapture(agentRoot, capture, lifecycleDeps({
      now: () => new Date("2026-07-01T13:00:00.000Z"),
    }))

    expect(second).toEqual(first)
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(receiptBytes)
    expect(fs.readFileSync(definition.path, "utf8")).toBe(firstDefinition)
  })

  it.each([
    ["body-only", "Run the synthetic report while this legacy habit is active.\n"],
    ["body-only without terminal LF", "Run the synthetic report while this legacy habit is active."],
    ["frontmatter-without-status", [
      "---",
      "title: Legacy synthetic report",
      "cadence: 24h",
      "---",
      "",
      "Run the synthetic report while this legacy habit is active.",
      "",
    ].join("\n")],
  ])("cancels parser-valid active %s definitions by insertion while preserving every original byte", async (name, bytes) => {
    const agentRoot = temporaryAgentRoot()
    const definitionPath = path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, bytes, "utf8")
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    const receipt = await cancelCapture(agentRoot, capture)
    const cancelled = fs.readFileSync(definitionPath, "utf8")
    const lifecycleBlock = [
      "status: cancelled",
      `cancelledAt: ${SYNTHETIC_CANCELLED_AT}`,
      `cancelledEvidence: capture:${capture.capture.keyHash}`,
      `cancelledReason: Confirmed requester ${SYNTHETIC_ACTOR} asked to end this habit.`,
    ].join("\n")
    const expected = name.startsWith("body-only")
      ? `---\n${lifecycleBlock}\n---\n${bytes}`
      : bytes.replace("\n---\n", `\n${lifecycleBlock}\n---\n`)

    expect(receipt.transition.fromStatus).toBe("active")
    expect(cancelled).toBe(expected)
  })

  it.each([
    ["BOM/CRLF", "\uFEFF---\r\ntitle: Legacy CRLF report\r\nstatus: active\r\n---\r\nRun it.\r\n"],
    ["body status lookalike", "---\ntitle: Explicit report\nstatus: active\n---\nThe literal body follows:\nstatus: active\n"],
    ["whitespace delimiters", " --- \ntitle: Spaced delimiters\nstatus: active\n --- \nRun it.\n"],
    ["trailing status whitespace", "---\ntitle: Trailing status\nstatus: active   \n---\nRun it.\n"],
  ])("cancels %s active frontmatter without rewriting line endings or a body status lookalike", async (_name, bytes) => {
    const agentRoot = temporaryAgentRoot()
    const definitionPath = path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, bytes, "utf8")
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const lineEnding = bytes.includes("\r\n") ? "\r\n" : "\n"
    const lifecycleBlock = [
      "status: cancelled",
      `cancelledAt: ${SYNTHETIC_CANCELLED_AT}`,
      `cancelledEvidence: capture:${capture.capture.keyHash}`,
      `cancelledReason: Confirmed requester ${SYNTHETIC_ACTOR} asked to end this habit.`,
    ].join(lineEnding)

    await cancelCapture(agentRoot, capture)

    expect(fs.readFileSync(definitionPath, "utf8"))
      .toBe(bytes.replace(/status: active[ \t]*(?=\r?$)/m, lifecycleBlock))
  })

  it.each([
    ["pre-existing lifecycle authority", "---\nstatus: active\ncancelledAt: 2026-01-01T00:00:00.000Z\n---\nRun it.\n"],
    ["duplicate status authority", "---\nstatus: paused\nstatus: active\n---\nRun it.\n"],
  ])("rejects %s instead of rendering ambiguous cancellation state", async (_name, bytes) => {
    const agentRoot = temporaryAgentRoot()
    const definitionPath = path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, bytes, "utf8")
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    await expect(cancelCapture(agentRoot, capture)).rejects.toThrow(/lifecycle.lines|status.line/i)
    expect(fs.readFileSync(definitionPath, "utf8")).toBe(bytes)
  })

  it("re-establishes definition, receipt, and journal parent durability before returning an idempotent acknowledgement", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const first = await cancelCapture(agentRoot, capture)
    const paths = getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
      operationId: first.operationId,
      evidenceKeyHash: first.evidenceKeyHash,
    })
    const requiredDirectories = new Set([
      path.resolve(path.dirname(definition.path)),
      path.resolve(paths.journalDirectory),
      path.resolve(paths.receiptsDirectory),
    ])
    const tracking = trackDirectoryFsyncs(requiredDirectories)

    const duplicate = await cancelCapture(agentRoot, capture, lifecycleDeps({ fs: tracking.fs }))

    expect(duplicate).toEqual(first)
    expect(tracking.synced).toEqual(requiredDirectories)
  })

  it("returns the committed receipt idempotently after raw ingress evidence expires", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const first = await cancelCapture(agentRoot, capture)
    fs.unlinkSync(capture.path)

    await expect(cancelCapture(agentRoot, capture)).resolves.toEqual(first)
  })

  it("rejects a committed journal whose cancelled digest points at an active definition", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const first = await cancelCapture(agentRoot, capture)
    const journalPath = getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
      operationId: first.operationId,
    }).journal!
    const journal = readJson(journalPath)
    journal.cancellationPreparation.definitionCancelledSha256 = sha256Utf8(definition.bytes)
    writeJson(journalPath, journal)
    fs.writeFileSync(definition.path, definition.bytes, "utf8")

    await expect(cancelCapture(agentRoot, capture))
      .rejects.toThrow(/definition.*state/i)
    expect(fs.readFileSync(definition.path, "utf8")).toBe(definition.bytes)
  })

  it("fails closed on missing or digest-divergent committed receipt authority", async () => {
    const missingRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(missingRoot)
    const missingCapture = writeSyntheticCaptureEvidence(missingRoot)
    await cancelCapture(missingRoot, missingCapture)
    fs.unlinkSync(cancellationPathsForCapture(missingRoot, missingCapture).receipt!)
    await expect(cancelCapture(missingRoot, missingCapture))
      .rejects.toThrow(/committed.*state/i)

    const digestRoot = temporaryAgentRoot()
    const digestDefinition = writeSyntheticHabitDefinition(digestRoot)
    const digestCapture = writeSyntheticCaptureEvidence(digestRoot)
    await cancelCapture(digestRoot, digestCapture)
    fs.appendFileSync(digestDefinition.path, "# divergent but still parsed cancelled\n", "utf8")
    await expect(cancelCapture(digestRoot, digestCapture))
      .rejects.toThrow(/definition.*digest/i)
  })

  it("fails closed if committed preflight authority regresses before the lock is inspected", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    await cancelCapture(agentRoot, capture)
    const journalPath = cancellationPathsForCapture(agentRoot, capture).journal!
    const committedBytes = fs.readFileSync(journalPath, "utf8")
    const regressed = JSON.parse(committedBytes)
    regressed.state = "definition_cancelled"
    regressed.generation = 2
    const regressedBytes = `${JSON.stringify(regressed, null, 2)}\n`
    let journalReads = 0
    const racingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "readFileSync") {
          return (filePath: fs.PathOrFileDescriptor, ...args: unknown[]): unknown => {
            if (path.resolve(String(filePath)) === path.resolve(journalPath)) {
              journalReads += 1
              return journalReads === 1 ? committedBytes : regressedBytes
            }
            return Reflect.apply(fs.readFileSync, fs, [filePath, ...args] as Parameters<typeof fs.readFileSync>)
          }
        }
        return Reflect.get(target, property)
      },
    }) as typeof fs

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({ fs: racingFs })))
      .rejects.toThrow(/evidence.*required/i)
  })

  it("rejects orphan receipts and a cancelled definition without lifecycle intent", async () => {
    const orphanRoot = temporaryAgentRoot()
    const orphanDefinition = writeSyntheticHabitDefinition(orphanRoot)
    const orphanCapture = writeSyntheticCaptureEvidence(orphanRoot)
    await cancelCapture(orphanRoot, orphanCapture)
    const orphanPaths = cancellationPathsForCapture(orphanRoot, orphanCapture)
    fs.unlinkSync(orphanPaths.journal!)
    fs.writeFileSync(orphanDefinition.path, orphanDefinition.bytes, "utf8")
    await expect(cancelCapture(orphanRoot, orphanCapture))
      .rejects.toThrow(/receipt.*without.*intent/i)

    const cancelledRoot = temporaryAgentRoot()
    const cancelledPath = path.join(cancelledRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`)
    fs.mkdirSync(path.dirname(cancelledPath), { recursive: true })
    fs.writeFileSync(cancelledPath, "---\nstatus: cancelled\n---\nAlready ended.\n", "utf8")
    const cancelledCapture = writeSyntheticCaptureEvidence(cancelledRoot)
    await expect(cancelCapture(cancelledRoot, cancelledCapture))
      .rejects.toThrow(/already.cancelled/i)
  })

  it("rejects every semantically divergent prepared cancellation state", async () => {
    const actorRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(actorRoot)
    const actorCapture = writeSyntheticCaptureEvidence(actorRoot)
    const actorJournal = await leaveCancellationAtGeneration(actorRoot, actorCapture, 1)
    actorJournal.cancellationPreparation.receipt.actor.displayName = "Different requester"
    actorJournal.cancellationPreparation.receipt.acknowledgement = renderHabitCancellationAcknowledgement(
      SYNTHETIC_HABIT_ID,
      "Different requester",
      actorJournal.cancellationPreparation.receipt.transition.boundaryState,
    )
    writeJson(cancellationPathsForCapture(actorRoot, actorCapture).journal!, actorJournal)
    await expect(cancelCapture(actorRoot, actorCapture))
      .rejects.toThrow(/prepared.*receipt.*mismatch/i)

    const statusRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(statusRoot)
    const statusCapture = writeSyntheticCaptureEvidence(statusRoot)
    const statusJournal = await leaveCancellationAtGeneration(statusRoot, statusCapture, 1)
    statusJournal.cancellationPreparation.receipt.transition.fromStatus = "paused"
    writeJson(cancellationPathsForCapture(statusRoot, statusCapture).journal!, statusJournal)
    await expect(cancelCapture(statusRoot, statusCapture))
      .rejects.toThrow(/definition.*state/i)

    const renderRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(renderRoot)
    const renderCapture = writeSyntheticCaptureEvidence(renderRoot)
    const renderJournal = await leaveCancellationAtGeneration(renderRoot, renderCapture, 1)
    renderJournal.cancellationPreparation.definitionCancelledSha256 = "f".repeat(64)
    writeJson(cancellationPathsForCapture(renderRoot, renderCapture).journal!, renderJournal)
    await expect(cancelCapture(renderRoot, renderCapture))
      .rejects.toThrow(/definition.*digest/i)

    const unknownRoot = temporaryAgentRoot()
    const unknownDefinition = writeSyntheticHabitDefinition(unknownRoot)
    const unknownCapture = writeSyntheticCaptureEvidence(unknownRoot)
    await leaveCancellationAtGeneration(unknownRoot, unknownCapture, 1)
    fs.appendFileSync(unknownDefinition.path, "# divergent definition\n", "utf8")
    await expect(cancelCapture(unknownRoot, unknownCapture))
      .rejects.toThrow(/definition.*digest/i)
  })

  it("rejects g2 definition regressions and confirms an already-published matching receipt", async () => {
    const beforeRoot = temporaryAgentRoot()
    const beforeDefinition = writeSyntheticHabitDefinition(beforeRoot)
    const beforeCapture = writeSyntheticCaptureEvidence(beforeRoot)
    await leaveCancellationAtGeneration(beforeRoot, beforeCapture, 2)
    fs.writeFileSync(beforeDefinition.path, beforeDefinition.bytes, "utf8")
    await expect(cancelCapture(beforeRoot, beforeCapture))
      .rejects.toThrow(/definition.*state/i)

    const statusRoot = temporaryAgentRoot()
    const statusDefinition = writeSyntheticHabitDefinition(statusRoot)
    const statusCapture = writeSyntheticCaptureEvidence(statusRoot)
    const statusJournal = await leaveCancellationAtGeneration(statusRoot, statusCapture, 2)
    statusJournal.cancellationPreparation.definitionBeforeSha256 = "f".repeat(64)
    statusJournal.cancellationPreparation.definitionCancelledSha256 = sha256Utf8(statusDefinition.bytes)
    writeJson(cancellationPathsForCapture(statusRoot, statusCapture).journal!, statusJournal)
    fs.writeFileSync(statusDefinition.path, statusDefinition.bytes, "utf8")
    await expect(cancelCapture(statusRoot, statusCapture))
      .rejects.toThrow(/definition.*state/i)

    const receiptRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(receiptRoot)
    const receiptCapture = writeSyntheticCaptureEvidence(receiptRoot)
    const first = await cancelCapture(receiptRoot, receiptCapture)
    const receiptPaths = cancellationPathsForCapture(receiptRoot, receiptCapture)
    const receiptJournal = readJson(receiptPaths.journal!)
    receiptJournal.state = "definition_cancelled"
    receiptJournal.generation = 2
    writeJson(receiptPaths.journal!, receiptJournal)
    await expect(cancelCapture(receiptRoot, receiptCapture)).resolves.toEqual(first)
  })

  it("retains and reuses a same-process lease after release contention instead of wedging retries", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const releaseBlocker = blockReleaseAfterCommit(agentRoot)

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({
      fs: releaseBlocker.fs,
      sleep: async () => undefined,
    })))
      .rejects.toThrow(/lock.*release/i)
    releaseBlocker.close()

    let tick = Date.parse(SYNTHETIC_CANCELLED_AT)
    const recovered = await cancelCapture(agentRoot, capture, lifecycleDeps({
      now: () => new Date((tick += 6_000)),
      sleep: async () => undefined,
    }))
    expect(recovered.transition.toStatus).toBe("cancelled")
    expect(fs.existsSync(getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
    }).owner)).toBe(false)
  })

  it("retains a same-process lease when owner inspection fails transiently during release", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const inspection = failOwnerInspectionAfterCommit(agentRoot)

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({
      fs: inspection.fs,
      sleep: async () => undefined,
    }))).rejects.toThrow(/lock.*release/i)
    inspection.recover()

    const recovered = await cancelCapture(agentRoot, capture)
    expect(recovered.transition.toStatus).toBe("cancelled")
    expect(fs.existsSync(getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
    }).owner)).toBe(false)
  })

  it("retains leases across release exceptions and discards a missing retained owner on retry", async () => {
    const exceptionRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(exceptionRoot)
    const exceptionCapture = writeSyntheticCaptureEvidence(exceptionRoot)
    const unlinkFailure = failOwnerUnlinkAfterCommit(exceptionRoot)
    await expect(cancelCapture(exceptionRoot, exceptionCapture, lifecycleDeps({ fs: unlinkFailure.fs })))
      .rejects.toThrow(/lock.*release/i)
    unlinkFailure.recover()
    await expect(cancelCapture(exceptionRoot, exceptionCapture)).resolves.toMatchObject({
      transition: { toStatus: "cancelled" },
    })

    const missingRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(missingRoot)
    const missingCapture = writeSyntheticCaptureEvidence(missingRoot)
    const blocker = blockReleaseAfterCommit(missingRoot)
    await expect(cancelCapture(missingRoot, missingCapture, lifecycleDeps({
      fs: blocker.fs,
      sleep: async () => undefined,
    }))).rejects.toThrow(/lock.*release/i)
    blocker.close()
    const ownerPath = getHabitLifecyclePaths({
      agentRoot: missingRoot,
      habitId: SYNTHETIC_HABIT_ID,
    }).owner
    fs.unlinkSync(ownerPath)
    await expect(cancelCapture(missingRoot, missingCapture)).resolves.toMatchObject({
      transition: { toStatus: "cancelled" },
    })
  })

  it("retries one transient false release with the default bounded wait", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({
      fs: missFirstOwnerInspectionAfterCommit(agentRoot),
      sleep: undefined,
    }))).resolves.toMatchObject({ transition: { toStatus: "cancelled" } })
  })

  it("serializes concurrent cancellation into one definition transition and one immutable receipt", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    const [left, right] = await Promise.all([
      cancelCapture(agentRoot, capture),
      cancelCapture(agentRoot, capture),
    ])

    expect(left).toEqual(right)
    const receiptDirectory = getHabitLifecyclePaths({
      agentRoot,
      habitId: SYNTHETIC_HABIT_ID,
    }).receiptsDirectory
    expect(fs.readdirSync(receiptDirectory)).toHaveLength(1)
    expect(fs.readFileSync(path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`), "utf8")
      .match(/^status: cancelled$/gm)).toHaveLength(1)
  })

  it("serializes two fresh processes into one transition and the same immutable receipt", async () => {
    const agentRoot = temporaryAgentRoot()
    writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)
    const startPath = path.join(agentRoot, "children.start")
    const children = ["left", "right"].map((name) => {
      const readyPath = path.join(agentRoot, `${name}.ready`)
      const resultPath = path.join(agentRoot, `${name}.result`)
      return {
        readyPath,
        resultPath,
        completion: spawnCancellationChild({
          mode: "cancel",
          agentRoot,
          habitId: SYNTHETIC_HABIT_ID,
          captureKeyHash: capture.capture.keyHash,
          readyPath,
          startPath,
          resultPath,
        }),
      }
    })
    await Promise.all(children.map((child) => waitForPath(child.readyPath)))
    fs.writeFileSync(startPath, "start\n", "utf8")
    const completions = await Promise.all(children.map((child) => child.completion))
    expect(completions).toEqual([
      expect.objectContaining({ code: 0, stderr: "" }),
      expect.objectContaining({ code: 0, stderr: "" }),
    ])
    const receipts = children.map((child) => JSON.parse(fs.readFileSync(child.resultPath, "utf8")))
    expect(receipts[0]).toEqual(receipts[1])
    expect(fs.readFileSync(path.join(agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`), "utf8")
      .match(/^status: cancelled$/gm)).toHaveLength(1)
  }, 45_000)

  it.each([
    [null, "crossing_unknown"],
    ["not_crossed", "not_crossed"],
    ["crossing_unknown", "crossing_unknown"],
    ["crossed", "crossed"],
  ] as const)(
    "classifies a concurrent send journal in state %s as %s",
    async (sendState, expectedBoundary) => {
      const agentRoot = temporaryAgentRoot()
      writeSyntheticHabitDefinition(agentRoot)
      const capture = writeSyntheticCaptureEvidence(agentRoot)
      await seedSendJournal(agentRoot, sendState)

      const receipt = await cancelCapture(agentRoot, capture)

      expect(receipt.transition.boundaryState).toBe(expectedBoundary)
      expect(receipt.acknowledgement).toBe(renderHabitCancellationAcknowledgement(
        SYNTHETIC_HABIT_ID,
        SYNTHETIC_ACTOR,
        expectedBoundary,
      ))
    },
  )

  it("recovers a visible cancelled definition after definition directory durability becomes unknown", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({
      fs: failOnceAfterRename(definition.path),
    }))).rejects.toThrow(/durability|write/i)
    expect(fs.readFileSync(definition.path, "utf8")).toContain("status: cancelled")
    const cancelledDefinitionBytes = fs.readFileSync(definition.path, "utf8")

    const recovered = await cancelCapture(agentRoot, capture)
    expect(recovered.transition.fromStatus).toBe("active")
    expect(recovered.transition.toStatus).toBe("cancelled")
    expect(fs.readFileSync(definition.path, "utf8")).toBe(cancelledDefinitionBytes)
  })

  it("re-establishes each visible journal generation before its dependent mutation", async () => {
    const g1Root = temporaryAgentRoot()
    const g1Definition = writeSyntheticHabitDefinition(g1Root)
    const g1Capture = writeSyntheticCaptureEvidence(g1Root)
    await expect(cancelCapture(g1Root, g1Capture, lifecycleDeps({
      fs: failJournalDirectoryFsyncAtState(g1Root, "cancellation_intent"),
    }))).rejects.toThrow(/durability/i)
    expect(fs.readFileSync(g1Definition.path, "utf8")).toBe(g1Definition.bytes)
    const g1Trace = traceRecoveryDurability(g1Root, g1Definition.path)
    await cancelCapture(g1Root, g1Capture, lifecycleDeps({ fs: g1Trace.fs }))
    expect(g1Trace.events.indexOf("journal:fsync")).toBeGreaterThanOrEqual(0)
    expect(g1Trace.events.indexOf("journal:fsync"))
      .toBeLessThan(g1Trace.events.indexOf("definition:rename"))

    const g2Root = temporaryAgentRoot()
    const g2Definition = writeSyntheticHabitDefinition(g2Root)
    const g2Capture = writeSyntheticCaptureEvidence(g2Root)
    await expect(cancelCapture(g2Root, g2Capture, lifecycleDeps({
      fs: failReceiptPublicationOnce(),
    }))).rejects.toThrow(/write/i)
    const g2Trace = traceRecoveryDurability(g2Root, g2Definition.path)
    await cancelCapture(g2Root, g2Capture, lifecycleDeps({ fs: g2Trace.fs }))
    expect(g2Trace.events.indexOf("journal:fsync")).toBeGreaterThanOrEqual(0)
    expect(g2Trace.events.indexOf("journal:fsync"))
      .toBeLessThan(g2Trace.events.indexOf("receipt:link"))

    const g3Root = temporaryAgentRoot()
    const g3Definition = writeSyntheticHabitDefinition(g3Root)
    const g3Capture = writeSyntheticCaptureEvidence(g3Root)
    const receipt = await cancelCapture(g3Root, g3Capture)
    const g3Trace = traceRecoveryDurability(g3Root, g3Definition.path)
    await expect(cancelCapture(g3Root, g3Capture, lifecycleDeps({ fs: g3Trace.fs })))
      .resolves.toEqual(receipt)
    expect(g3Trace.events.filter((event) => event.endsWith(":fsync")).slice(0, 3))
      .toEqual(["journal:fsync", "definition:fsync", "receipt:fsync"])
  })

  it.each(["active", "paused"] as const)(
    "recovers %s from generation-one preparation in a fresh process after its predecessor dies at definition publication",
    async (fromStatus) => {
      const agentRoot = temporaryAgentRoot()
      const definition = writeSyntheticHabitDefinition(agentRoot, fromStatus)
      const capture = writeSyntheticCaptureEvidence(agentRoot)
      const crashReady = path.join(agentRoot, "crash.ready")
      const crashStart = path.join(agentRoot, "crash.start")
      const crashResult = path.join(agentRoot, "crash.result")
      const crashCompletion = spawnCancellationChild({
        mode: "crash_after_definition",
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        captureKeyHash: capture.capture.keyHash,
        readyPath: crashReady,
        startPath: crashStart,
        resultPath: crashResult,
      })
      await waitForPath(crashReady)
      fs.writeFileSync(crashStart, "start\n", "utf8")
      expect(await crashCompletion).toMatchObject({ code: 86 })
      expect(fs.existsSync(crashResult)).toBe(false)
      expect(fs.readFileSync(definition.path, "utf8")).toContain("status: cancelled")
      const journalDirectory = getHabitLifecyclePaths({
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
      }).journalDirectory
      const journalFiles = fs.readdirSync(journalDirectory).filter((name) => name.endsWith(".json"))
      expect(journalFiles).toHaveLength(1)
      const preparedJournal = readJson(path.join(journalDirectory, journalFiles[0]))
      const cancelledDefinitionBytes = fs.readFileSync(definition.path, "utf8")
      expect(preparedJournal).toMatchObject({
        state: "cancellation_intent",
        generation: 1,
        cancellationPreparation: {
          receipt: {
            transition: { fromStatus, toStatus: "cancelled" },
          },
          definitionBeforeSha256: sha256Utf8(definition.bytes),
          definitionCancelledSha256: sha256Utf8(fs.readFileSync(definition.path)),
        },
      })

      const recoveryReady = path.join(agentRoot, "recovery.ready")
      const recoveryStart = path.join(agentRoot, "recovery.start")
      const recoveryResult = path.join(agentRoot, "recovery.result")
      const recoveryCompletion = spawnCancellationChild({
        mode: "cancel",
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        captureKeyHash: capture.capture.keyHash,
        readyPath: recoveryReady,
        startPath: recoveryStart,
        resultPath: recoveryResult,
      })
      await waitForPath(recoveryReady)
      fs.writeFileSync(recoveryStart, "start\n", "utf8")
      expect(await recoveryCompletion).toMatchObject({ code: 0, stderr: "" })
      const preparedReceipt = preparedJournal.cancellationPreparation.receipt
      const returnedReceipt = JSON.parse(fs.readFileSync(recoveryResult, "utf8"))
      expect(returnedReceipt).toEqual(preparedReceipt)
      const receiptPath = getHabitLifecyclePaths({
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceKeyHash: preparedReceipt.evidenceKeyHash,
      }).receipt!
      expect(fs.readFileSync(receiptPath, "utf8"))
        .toBe(`${JSON.stringify(preparedReceipt, null, 2)}\n`)
      const committedJournal = readJson(path.join(journalDirectory, journalFiles[0]))
      expect(committedJournal).toMatchObject({
        state: "cancellation_receipt_committed",
        generation: 3,
      })
      expect(committedJournal.cancellationPreparation)
        .toEqual(preparedJournal.cancellationPreparation)
      expect(fs.readFileSync(definition.path, "utf8")).toBe(cancelledDefinitionBytes)
    },
    45_000,
  )

  it.each([
    "capture_missing",
    "cutover_tampered",
    "definition_hash_mismatch",
  ] as const)(
    "fails closed during fresh-process generation-one recovery when %s",
    async (failureMode) => {
      const agentRoot = temporaryAgentRoot()
      const definition = writeSyntheticHabitDefinition(agentRoot)
      const capture = writeSyntheticCaptureEvidence(agentRoot)
      const crashReady = path.join(agentRoot, `${failureMode}.crash.ready`)
      const crashStart = path.join(agentRoot, `${failureMode}.crash.start`)
      const crashResult = path.join(agentRoot, `${failureMode}.crash.result`)
      const crashCompletion = spawnCancellationChild({
        mode: "crash_after_definition",
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        captureKeyHash: capture.capture.keyHash,
        readyPath: crashReady,
        startPath: crashStart,
        resultPath: crashResult,
      })
      await waitForPath(crashReady)
      fs.writeFileSync(crashStart, "start\n", "utf8")
      expect(await crashCompletion).toMatchObject({ code: 86 })

      const journalDirectory = getHabitLifecyclePaths({
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
      }).journalDirectory
      const journalFiles = fs.readdirSync(journalDirectory).filter((name) => name.endsWith(".json"))
      expect(journalFiles).toHaveLength(1)
      const journalPath = path.join(journalDirectory, journalFiles[0])
      const preparedJournalBytes = fs.readFileSync(journalPath, "utf8")
      const preparedJournal = JSON.parse(preparedJournalBytes)
      expect(preparedJournal).toMatchObject({ state: "cancellation_intent", generation: 1 })

      if (failureMode === "capture_missing") {
        fs.unlinkSync(capture.path)
      } else if (failureMode === "cutover_tampered") {
        const cutoverPath = path.join(
          agentRoot,
          "state",
          "senses",
          "bluebubbles",
          "semantic-receipts",
          "cutover.json",
        )
        const cutover = readJson(cutoverPath)
        cutover.providerNamespace = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        writeJson(cutoverPath, cutover)
      } else {
        fs.appendFileSync(definition.path, "# definition no longer matches either prepared digest\n", "utf8")
      }
      const definitionBytesBeforeRecovery = fs.readFileSync(definition.path, "utf8")

      const recoveryReady = path.join(agentRoot, `${failureMode}.recovery.ready`)
      const recoveryStart = path.join(agentRoot, `${failureMode}.recovery.start`)
      const recoveryResult = path.join(agentRoot, `${failureMode}.recovery.result`)
      const recoveryCompletion = spawnCancellationChild({
        mode: "cancel",
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        captureKeyHash: capture.capture.keyHash,
        readyPath: recoveryReady,
        startPath: recoveryStart,
        resultPath: recoveryResult,
      })
      await waitForPath(recoveryReady)
      fs.writeFileSync(recoveryStart, "start\n", "utf8")
      const completion = await recoveryCompletion
      expect(completion.code).not.toBe(0)
      expect(fs.existsSync(recoveryResult)).toBe(false)
      const receiptPath = getHabitLifecyclePaths({
        agentRoot,
        habitId: SYNTHETIC_HABIT_ID,
        evidenceKeyHash: preparedJournal.cancellationPreparation.receipt.evidenceKeyHash,
      }).receipt!
      expect(fs.existsSync(receiptPath)).toBe(false)
      expect(fs.readFileSync(journalPath, "utf8")).toBe(preparedJournalBytes)
      expect(fs.readFileSync(definition.path, "utf8")).toBe(definitionBytesBeforeRecovery)
    },
    45_000,
  )

  it("recovers a cancelled definition after receipt publication fails without rolling it active", async () => {
    const agentRoot = temporaryAgentRoot()
    const definition = writeSyntheticHabitDefinition(agentRoot)
    const capture = writeSyntheticCaptureEvidence(agentRoot)

    await expect(cancelCapture(agentRoot, capture, lifecycleDeps({
      fs: failReceiptPublicationOnce(),
    }))).rejects.toThrow(/receipt|write/i)
    expect(fs.readFileSync(definition.path, "utf8")).toContain("status: cancelled")
    const cancelledDefinitionBytes = fs.readFileSync(definition.path, "utf8")

    const recovered = await cancelCapture(agentRoot, capture)
    expect(recovered.transition.fromStatus).toBe("active")
    expect(recovered.transition.toStatus).toBe("cancelled")
    expect(fs.readFileSync(definition.path, "utf8")).toBe(cancelledDefinitionBytes)
  })
})

describe("deterministic cancellation acknowledgement", () => {
  it.each([
    ["not_crossed", "No concurrent send crossed the transport boundary."],
    ["crossing_unknown", "A concurrent send may have crossed the transport boundary; delivery is unknown."],
    ["crossed", "A concurrent send crossed the transport boundary before cancellation took effect."],
  ] as const)("renders and JSON-escapes the exact %s template", (boundaryState, suffix) => {
    const habitId = "synthetic-habit"
    const actor = "Casey \"C.J.\" \\ owner\nconfirmed"
    expect(renderHabitCancellationAcknowledgement(habitId, actor, boundaryState)).toBe(
      `Cancelled habit ${JSON.stringify(habitId)} from confirmed requester ${JSON.stringify(actor)}. ${suffix}`,
    )
  })
})
