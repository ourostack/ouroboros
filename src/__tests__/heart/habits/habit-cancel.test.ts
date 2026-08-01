import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  acquireHabitLifecycleLock,
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
  validateHabitEvidenceBridge,
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
    "habit-cancel-child-process.test.ts",
  )
  const child = spawn(process.execPath, [
    path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
    "run",
    fixture,
    "--config",
    path.join(process.cwd(), "vitest.config.ts"),
    "--pool",
    "threads",
  ], {
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

  it("pins the production historical bridge to the independently recorded manifest digest", async () => {
    expect(HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256).toBe(
      "34a90f6ce3f7b092edb8114cf7ab640486fd7e6d7667acfd0249408fff394201",
    )
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
})

describe("atomic habit cancellation", () => {
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
