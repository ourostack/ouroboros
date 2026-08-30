import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { listExternalEventStatus, readExternalEventRecord, recordExternalEvent, scanPrivilegedEventSpool } from "../../../heart/external-events/router"

const spoolMock = vi.hoisted(() => ({ root: "", readOnly: false, authorityBarrierUsed: false, mountInfo: null as string | null, mountReadError: false }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    lstatSync(target: fs.PathLike) {
      const stat = actual.lstatSync(target)
      const resolved = path.resolve(String(target))
      if (!spoolMock.root || (resolved !== path.resolve(spoolMock.root) && path.dirname(resolved) !== path.resolve(spoolMock.root))) return stat
      return new Proxy(stat, { get(value, property, receiver) { return property === "uid" ? 0 : Reflect.get(value, property, receiver) } })
    },
    readFileSync(target: Parameters<typeof actual.readFileSync>[0], options?: unknown) {
      if (target === "/proc/self/mountinfo" && spoolMock.mountReadError) throw new Error("mountinfo unavailable")
      if (target === "/proc/self/mountinfo" && spoolMock.mountInfo !== null) return spoolMock.mountInfo
      if (target === "/proc/self/mountinfo" && spoolMock.root && spoolMock.readOnly) {
        return `1 1 0:1 / ${spoolMock.root.replace(/ /gu, "\\040")} ro,nosuid,nodev - bind none ro\n`
      }
      return actual.readFileSync(target, options as never)
    },
    readdirSync(target: fs.PathLike, options?: unknown) {
      const entries = actual.readdirSync(target, options as never)
      const barrier = process.env.OURO_TEST_SCANNER_BARRIER
      const eventRoot = process.env.OURO_TEST_SCANNER_EVENT_ROOT
      if (barrier && eventRoot && !spoolMock.authorityBarrierUsed && path.resolve(String(target)).startsWith(path.resolve(eventRoot))) {
        spoolMock.authorityBarrierUsed = true
        actual.writeFileSync(`${barrier}.${process.pid}`, "ready")
        const deadline = Date.now() + Number(process.env.OURO_TEST_SCANNER_BARRIER_WAIT_MS ?? 500)
        while (Date.now() < deadline && actual.readdirSync(path.dirname(barrier)).filter((name) => name.startsWith(path.basename(barrier))).length < 2) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
      }
      return entries
    },
  }
})

const roots: string[] = []
const NOW = "2026-08-29T20:00:00.000Z"
const SOURCE_MANIFEST = ".privileged-replay-manifest.json"

function root(name: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  roots.push(value)
  return value
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agent: "sanctuary",
    source: "sanctuary-usenet",
    eventType: "usenet.protective_action",
    incidentKey: "spend-guard",
    transitionId: "2026-08-29:pause:50000:20",
    observationRevision: "a".repeat(64),
    action: "sabnzbd.pause",
    actionReceipt: "sabnzbd:pause:2026-08-29:50000:20",
    protectiveStateVerified: true,
    protectiveStateDigest: "d".repeat(64),
    protectiveStateObservedAt: "2026-08-29T19:55:01.000Z",
    critical: true,
    summary: "SABnzbd was paused after article success fell below the spend guard.",
    evidence: ["50,000 articles attempted; 20% succeeded."],
    createdAt: "2026-08-29T19:55:00.000Z",
    expiresAt: "2026-08-29T20:10:00.000Z",
    nonce: "b".repeat(64),
    ...overrides,
  }
}

function envelopeName(value: Record<string, unknown>): string {
  return `${createHash("sha256").update(`${value.source}\0${value.incidentKey}\0${value.transitionId}`).digest("hex")}.json`
}

function writeSpoolFile(spoolRoot: string, value: Record<string, unknown>, mode = 0o444): string {
  const filePath = path.join(spoolRoot, envelopeName(value))
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode })
  fs.chmodSync(filePath, mode)
  return filePath
}

function spoofRootOwnership(spoolRoot: string): void {
  spoolMock.root = spoolRoot
  spoolMock.readOnly = true
}

function producerOptions(spoolRoot: string, nonce = "b".repeat(64)) {
  return {
    spoolRoot,
    effectiveUid: 0,
    expectedSpoolOwnerUid: process.getuid?.() ?? 0,
    now: () => "2026-08-29T19:55:00.000Z",
    nonce: () => nonce,
  }
}

function runProducerProcess(producerPath: string, input: Record<string, unknown>, options: { spoolRoot: string; nonce: string; maxSpoolFiles?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const program = `import { emitEvent } from ${JSON.stringify(pathToFileURL(producerPath).href)}; try { const result = emitEvent(${JSON.stringify(input)}, { spoolRoot: ${JSON.stringify(options.spoolRoot)}, effectiveUid: 0, expectedSpoolOwnerUid: process.getuid(), now: () => ${JSON.stringify("2026-08-29T19:55:00.000Z")}, nonce: () => ${JSON.stringify(options.nonce)}, maxSpoolFiles: ${JSON.stringify(options.maxSpoolFiles)} }); process.stdout.write(JSON.stringify(result)); } catch (error) { process.stderr.write(error.message); process.exitCode = 1 }`
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

afterEach(() => {
  spoolMock.root = ""
  spoolMock.readOnly = false
  spoolMock.authorityBarrierUsed = false
  spoolMock.mountInfo = null
  spoolMock.mountReadError = false
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("privileged external-event spool", () => {
  it("accepts one root-owned file from a read-only mount into the canonical receipt and fences replay across scanner restart", () => {
    const spoolRoot = root("ouro-privileged-spool")
    const eventRoot = root("ouro-privileged-events")
    fs.chmodSync(spoolRoot, 0o755)
    const value = envelope()
    writeSpoolFile(spoolRoot, value)
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 1, rejected: 0, replayed: 0 })
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 1 })
    const [status] = listExternalEventStatus(eventRoot)
    expect(status).toMatchObject({ agent: "sanctuary", source: "sanctuary-usenet", eventId: "spend-guard", executionState: "received" })
    expect(readExternalEventRecord(status!.recordPath)).toMatchObject({
      observationRevision: "a".repeat(64),
      privilegedIngressNonce: "b".repeat(64),
      privilegedProtectiveAction: {
        action: "sabnzbd.pause",
        actionReceipt: "sabnzbd:pause:2026-08-29:50000:20",
        transitionId: "2026-08-29:pause:50000:20",
        critical: true,
        createdAt: "2026-08-29T19:55:00.000Z",
        expiresAt: "2026-08-29T20:10:00.000Z",
        verification: {
          verified: true,
          digest: "d".repeat(64),
          observedAt: "2026-08-29T19:55:01.000Z",
        },
      },
      evidence: expect.arrayContaining(["protective action receipt: sabnzbd:pause:2026-08-29:50000:20"]),
    })
    expect(readExternalEventRecord(status!.recordPath)).not.toHaveProperty("privilegedReplayManifest")
    const sourceManifestPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", SOURCE_MANIFEST)
    expect(JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      agent: "sanctuary",
      source: "sanctuary-usenet",
      algorithm: "sha256-bloom-v1",
      observedCount: 1,
    })
    expect(fs.statSync(sourceManifestPath).size).toBeLessThan(64 * 1024)
  })

  it("retains replay authority after more than 128 transitions and a scanner restart", () => {
    const spoolRoot = root("ouro-privileged-long-history")
    const eventRoot = root("ouro-privileged-long-history-events")
    fs.chmodSync(spoolRoot, 0o755)
    for (let index = 0; index < 140; index += 1) {
      writeSpoolFile(spoolRoot, envelope({
        transitionId: `transition-${index}`,
        observationRevision: createHash("sha256").update(`revision-${index}`).digest("hex"),
        nonce: createHash("sha256").update(`nonce-${index}`).digest("hex"),
      }))
    }
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 140, rejected: 0, replayed: 0 })
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 140 })
    expect(JSON.parse(fs.readFileSync(path.join(eventRoot, "sanctuary", "sanctuary-usenet", SOURCE_MANIFEST), "utf8"))).toMatchObject({ observedCount: 140 })
  }, 15_000)

  it("records an authenticated pause claim whose independent SAB read says unpaused as agent-visible unverified evidence", () => {
    const spoolRoot = root("ouro-privileged-unverified")
    const eventRoot = root("ouro-privileged-unverified-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope({ protectiveStateVerified: false, protectiveStateDigest: "e".repeat(64) }))
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 1, rejected: 0, replayed: 0 })
    const [status] = listExternalEventStatus(eventRoot)
    expect(readExternalEventRecord(status!.recordPath)).toMatchObject({
      privilegedProtectiveAction: { verification: { verified: false, digest: "e".repeat(64) } },
      evidence: expect.arrayContaining([expect.stringContaining("protective state verified: false")]),
    })
  })

  it("does not recreate compacted handled work when immutable spool history is rescanned", () => {
    const spoolRoot = root("ouro-privileged-compaction")
    const eventRoot = root("ouro-privileged-compaction-events")
    fs.chmodSync(spoolRoot, 0o755)
    for (let index = 0; index < 512; index += 1) {
      writeSpoolFile(spoolRoot, envelope({
        incidentKey: `incident-${index}`,
        transitionId: `transition-${index}`,
        observationRevision: createHash("sha256").update(`revision-${index}`).digest("hex"),
        nonce: createHash("sha256").update(`nonce-${index}`).digest("hex"),
      }))
    }
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 512, rejected: 0, replayed: 0 })
    for (const status of listExternalEventStatus(eventRoot)) {
      const record = readExternalEventRecord(status.recordPath)
      fs.writeFileSync(status.recordPath, `${JSON.stringify({ ...record, executionState: "handled" })}\n`)
    }
    writeSpoolFile(spoolRoot, envelope({
      incidentKey: "incident-512",
      transitionId: "transition-512",
      observationRevision: createHash("sha256").update("revision-512").digest("hex"),
      nonce: createHash("sha256").update("nonce-512").digest("hex"),
    }))

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 1, rejected: 0, replayed: 512 })
    expect(listExternalEventStatus(eventRoot)).toHaveLength(512)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 513 })
    expect(listExternalEventStatus(eventRoot)).toHaveLength(512)
    const newest = listExternalEventStatus(eventRoot).find((status) => status.eventId === "incident-512")!
    const newestRecord = readExternalEventRecord(newest.recordPath)
    expect(newestRecord).not.toHaveProperty("privilegedReplayManifest")
    expect(newestRecord.retentionSummary).not.toHaveProperty("privilegedReplayManifest")
    expect(Buffer.byteLength(JSON.stringify(newestRecord))).toBeLessThanOrEqual(64 * 1024)
  }, 45_000)

  it.each(["deleted", "corrupt"])("fails closed when the source replay manifest is %s", (failure) => {
    const spoolRoot = root("ouro-source-manifest-fail-closed")
    const eventRoot = root("ouro-source-manifest-fail-closed-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope())
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(1)
    const manifestPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", SOURCE_MANIFEST)
    if (failure === "deleted") fs.unlinkSync(manifestPath)
    else fs.writeFileSync(manifestPath, "not-json")

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("retains replay authority when the accepted receipt is deleted or corrupt", () => {
    const spoolRoot = root("ouro-source-manifest-independent")
    const eventRoot = root("ouro-source-manifest-independent-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope())
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(1)
    const receiptPath = listExternalEventStatus(eventRoot)[0]!.recordPath
    fs.unlinkSync(receiptPath)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 1 })
    fs.writeFileSync(receiptPath, "not-json")
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("serializes scanner processes before accepting one nonce under different event IDs", async () => {
    const eventRoot = root("ouro-scanner-process-events")
    const barrierDir = root("ouro-scanner-process-barrier")
    const barrier = path.join(barrierDir, "ready")
    const testPath = path.resolve(__filename)
    const vitestPath = path.resolve("node_modules/vitest/vitest.mjs")
    const run = (index: number): Promise<{ code: number | null; result: { accepted: number; rejected: number; replayed: number } }> => new Promise((resolve) => {
      const spoolRoot = root(`ouro-scanner-process-spool-${index}`)
      fs.chmodSync(spoolRoot, 0o755)
      writeSpoolFile(spoolRoot, envelope({ incidentKey: `process-${index}`, transitionId: `process-${index}`, nonce: "e".repeat(64) }))
      const resultPath = path.join(barrierDir, `result-${index}.json`)
      const child = spawn(process.execPath, [vitestPath, "run", testPath, "-t", "scanner child process"], {
        stdio: "ignore",
        env: { ...process.env, OURO_TEST_SCANNER_CHILD: "1", OURO_TEST_SCANNER_SPOOL_ROOT: spoolRoot, OURO_TEST_SCANNER_EVENT_ROOT: eventRoot, OURO_TEST_SCANNER_RESULT: resultPath, OURO_TEST_SCANNER_BARRIER: barrier },
      })
      child.on("close", (code) => resolve({ code, result: JSON.parse(fs.readFileSync(resultPath, "utf8")) }))
    })
    const outcomes = await Promise.all([run(1), run(2)])
    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0])
    expect(outcomes.reduce((total, outcome) => total + outcome.result.accepted, 0)).toBe(1)
    expect(outcomes.reduce((total, outcome) => total + outcome.result.replayed, 0)).toBe(0)
    expect(outcomes.reduce((total, outcome) => total + outcome.result.rejected, 0)).toBe(0)
    const retryRoot = roots.find((value) => value.includes("spool-2"))!
    spoofRootOwnership(retryRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot: retryRoot, eventRoot, now: () => NOW }).replayed).toBe(1)
  }, 15_000)

  it.skipIf(process.env.OURO_TEST_SCANNER_CHILD !== "1")("scanner child process", () => {
    const spoolRoot = process.env.OURO_TEST_SCANNER_SPOOL_ROOT!
    const eventRoot = process.env.OURO_TEST_SCANNER_EVENT_ROOT!
    spoofRootOwnership(spoolRoot)
    const result = scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })
    fs.writeFileSync(process.env.OURO_TEST_SCANNER_RESULT!, JSON.stringify(result))
  })

  it("does not steal an aged global replay lock from its live PID and process start owner", async () => {
    const eventRoot = root("ouro-scanner-live-lease-events")
    const holderRoot = root("ouro-scanner-live-lease-holder")
    const contenderRoot = root("ouro-scanner-live-lease-contender")
    for (const [index, spoolRoot] of [holderRoot, contenderRoot].entries()) {
      fs.chmodSync(spoolRoot, 0o755)
      writeSpoolFile(spoolRoot, envelope({ incidentKey: `lease-${index}`, transitionId: `lease-${index}`, nonce: "f".repeat(64) }))
    }
    const barrierDir = root("ouro-scanner-live-lease-barrier")
    const barrier = path.join(barrierDir, "ready")
    const resultPath = path.join(barrierDir, "result.json")
    const child = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", path.resolve(__filename), "-t", "scanner child process"], {
      stdio: "ignore",
      env: { ...process.env, OURO_TEST_SCANNER_CHILD: "1", OURO_TEST_SCANNER_SPOOL_ROOT: holderRoot, OURO_TEST_SCANNER_EVENT_ROOT: eventRoot, OURO_TEST_SCANNER_RESULT: resultPath, OURO_TEST_SCANNER_BARRIER: barrier, OURO_TEST_SCANNER_BARRIER_WAIT_MS: "5000" },
    })
    const readyPath = async (): Promise<string> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = fs.readdirSync(barrierDir).find((name) => name.startsWith("ready."))
        if (found) return path.join(barrierDir, found)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("scanner child did not acquire its replay lease")
    }
    await readyPath()
    const lockPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", ".privileged-replay.lock")
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"))
    expect(owner).toMatchObject({ token: expect.any(String), pid: expect.any(Number), processStart: expect.any(String), leaseUntil: expect.any(String) })
    fs.utimesSync(lockPath, new Date(0), new Date(0))
    spoofRootOwnership(contenderRoot)
    const started = Date.now()
    expect(scanPrivilegedEventSpool({ spoolRoot: contenderRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 0 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token).toBe(owner.token)
    fs.writeFileSync(`${barrier}.release`, "release")
    await new Promise<void>((resolve, reject) => child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`scanner child exited ${code}`))))
  }, 15_000)

  it.each([
    ["wrong source", { source: "attacker" }],
    ["wrong schema", { schemaVersion: 2 }],
    ["wrong action", { action: "shell.exec" }],
    ["expired", { expiresAt: "2026-08-29T19:59:59.000Z" }],
    ["future", { createdAt: "2026-08-29T20:00:01.000Z" }],
    ["stale verification", { protectiveStateObservedAt: "2026-08-29T19:49:59.999Z" }],
    ["bad nonce", { nonce: "not-a-nonce" }],
  ])("rejects %s envelopes without creating a receipt", (_label, overrides) => {
    const spoolRoot = root("ouro-privileged-spoof")
    const eventRoot = root("ouro-privileged-spoof-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope(overrides))
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
    expect(listExternalEventStatus(eventRoot)).toEqual([])
  })

  it.each(["null", "[]"])("rejects non-object %s envelopes", (raw) => {
    const spoolRoot = root("ouro-privileged-nonobject")
    const eventRoot = root("ouro-privileged-nonobject-events")
    fs.chmodSync(spoolRoot, 0o755)
    const filePath = path.join(spoolRoot, `${"a".repeat(64)}.json`)
    fs.writeFileSync(filePath, raw, { mode: 0o444 })
    fs.chmodSync(filePath, 0o444)
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("rejects a valid envelope published under the wrong canonical filename", () => {
    const spoolRoot = root("ouro-privileged-wrong-name")
    const eventRoot = root("ouro-privileged-wrong-name-events")
    fs.chmodSync(spoolRoot, 0o755)
    const filePath = path.join(spoolRoot, `${"f".repeat(64)}.json`)
    fs.writeFileSync(filePath, JSON.stringify(envelope()), { mode: 0o444 })
    fs.chmodSync(filePath, 0o444)
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("rejects missing spool roots without throwing", () => {
    const missing = path.join(root("ouro-privileged-missing-parent"), "missing")
    expect(scanPrivilegedEventSpool({ spoolRoot: missing, eventRoot: root("ouro-privileged-missing-events"), now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("fails closed when mount metadata is unavailable or malformed", () => {
    for (const mode of ["error", "malformed"] as const) {
      const spoolRoot = root(`ouro-privileged-mount-${mode}`)
      fs.chmodSync(spoolRoot, 0o755)
      writeSpoolFile(spoolRoot, envelope())
      spoolMock.root = spoolRoot
      if (mode === "error") spoolMock.mountReadError = true
      else spoolMock.mountInfo = "too short"
      expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot: root(`ouro-privileged-mount-events-${mode}`), now: () => NOW }).accepted).toBe(0)
      spoolMock.mountReadError = false
      spoolMock.mountInfo = null
    }
  })

  it("recovers only stale malformed or dead replay-lock owners", () => {
    for (const owner of [{ bad: true }, { token: "old", pid: 999_999_999, processStart: "gone", leaseUntil: "2020-01-01T00:00:00.000Z" }]) {
      const spoolRoot = root("ouro-privileged-stale-owner")
      const eventRoot = root("ouro-privileged-stale-owner-events")
      fs.chmodSync(spoolRoot, 0o755)
      spoofRootOwnership(spoolRoot)
      const lockPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", ".privileged-replay.lock")
      fs.mkdirSync(lockPath, { recursive: true })
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner))
      fs.utimesSync(lockPath, new Date(0), new Date(0))
      expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
      expect(fs.existsSync(lockPath)).toBe(false)
    }
  })

  it("fails closed when stale replay-lock cleanup cannot remove unknown contents", () => {
    const spoolRoot = root("ouro-privileged-stale-dirty")
    const eventRoot = root("ouro-privileged-stale-dirty-events")
    fs.chmodSync(spoolRoot, 0o755)
    spoofRootOwnership(spoolRoot)
    const lockPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", ".privileged-replay.lock")
    fs.mkdirSync(lockPath, { recursive: true })
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ bad: true }))
    fs.writeFileSync(path.join(lockPath, "unknown"), "preserve")
    fs.utimesSync(lockPath, new Date(0), new Date(0))
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 0 })
  })

  it.each([
    { schemaVersion: 2, agent: "sanctuary", source: "sanctuary-usenet", algorithm: "sha256-bloom-v1", bitCount: 65536, hashCount: 7, bits: "", observedCount: 0, updatedAt: NOW },
    { schemaVersion: 1, agent: "sanctuary", source: "sanctuary-usenet", algorithm: "wrong", bitCount: 65536, hashCount: 7, bits: "", observedCount: 0, updatedAt: NOW },
    { schemaVersion: 1, agent: "sanctuary", source: "sanctuary-usenet", algorithm: "sha256-bloom-v1", bitCount: 65536, hashCount: 7, bits: "bad", observedCount: 0, updatedAt: NOW },
  ])("rejects structurally corrupt replay authority", (state) => {
    const spoolRoot = root("ouro-privileged-state-shape")
    const eventRoot = root("ouro-privileged-state-shape-events")
    fs.chmodSync(spoolRoot, 0o755)
    spoofRootOwnership(spoolRoot)
    const statePath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", SOURCE_MANIFEST)
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(state))
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
  })

  it("migrates legacy receipt replay nonces into the canonical source manifest", () => {
    const spoolRoot = root("ouro-privileged-legacy")
    const eventRoot = root("ouro-privileged-legacy-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope())
    spoofRootOwnership(spoolRoot)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(1)
    const receipt = listExternalEventStatus(eventRoot)[0]!
    const raw = readExternalEventRecord(receipt.recordPath)
    fs.writeFileSync(receipt.recordPath, JSON.stringify({ ...raw, privilegedReplayNonces: ["c".repeat(64)] }))
    const statePath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", SOURCE_MANIFEST)
    fs.unlinkSync(statePath)
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(1)
    expect(readExternalEventRecord(receipt.recordPath).privilegedReplayNonces).toBeUndefined()
    expect(fs.existsSync(statePath)).toBe(true)
  })

  it("rejects writable mounts, non-root owners, unsafe modes, symlinks, and oversized files", () => {
    const eventRoot = root("ouro-privileged-permissions-events")
    const cases = [
      { configure: (_root: string) => undefined },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); fs.chmodSync(path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!), 0o644) } },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); const file = path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!); fs.unlinkSync(file); fs.symlinkSync("/etc/hosts", file) } },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); const file = path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!); fs.chmodSync(file, 0o600); fs.appendFileSync(file, "x".repeat(64 * 1024)); fs.chmodSync(file, 0o444) } },
    ]
    for (const entry of cases) {
      spoolMock.root = ""
      spoolMock.readOnly = false
      const spoolRoot = root("ouro-privileged-permissions")
      fs.chmodSync(spoolRoot, 0o755)
      writeSpoolFile(spoolRoot, envelope())
      entry.configure(spoolRoot)
      expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(0)
    }
    expect(listExternalEventStatus(eventRoot)).toEqual([])
  })

  it("keeps the reserved privileged source unavailable to ordinary event submission", () => {
    expect(() => recordExternalEvent({ agent: "sanctuary", source: "sanctuary-usenet", eventType: "usenet.protective_action", eventId: "spoof" }, { root: root("ordinary-event") }))
      .toThrow("reserved for privileged spool ingress")
  })

  it.each([" sanctuary-usenet", "sanctuary-usenet ", "\tsanctuary-usenet"])('rejects noncanonical reserved-source identity %j before deriving a path', (source) => {
    const eventRoot = root("ordinary-noncanonical-event")
    expect(() => recordExternalEvent({ agent: "sanctuary", source, eventType: "usenet.protective_action", eventId: "spoof" }, { root: eventRoot }))
      .toThrow("identity must be canonical")
    expect(fs.readdirSync(eventRoot)).toEqual([])
  })
})

describe("packaged root event producer", () => {
  it("writes one canonical bounded envelope with fsync and atomic no-replace publication and is idempotent", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?test=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions>): { filePath: string; created: boolean }
    }
    const spoolRoot = root("ouro-producer")
    fs.chmodSync(spoolRoot, 0o755)
    const input = envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined })
    const first = producer.emitEvent(input, producerOptions(spoolRoot))
    const second = producer.emitEvent(input, { ...producerOptions(spoolRoot, "c".repeat(64)), now: () => "2026-08-29T19:56:00.000Z" })

    expect(first).toEqual({ filePath: path.join(spoolRoot, envelopeName(envelope())), created: true })
    expect(second).toEqual({ filePath: first.filePath, created: false })
    expect(fs.readdirSync(spoolRoot)).toEqual([path.basename(first.filePath)])
    expect(fs.statSync(first.filePath).mode & 0o777).toBe(0o444)
    expect(JSON.parse(fs.readFileSync(first.filePath, "utf8"))).toMatchObject({ ...envelope(), createdAt: "2026-08-29T19:55:00.000Z", expiresAt: "2026-08-29T20:10:00.000Z", nonce: "b".repeat(64) })
  })

  it("rejects non-root CLI execution, traversal, oversized content, and conflicting transition reuse", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?negative=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions>): unknown
    }
    const spoolRoot = root("ouro-producer-negative")
    fs.chmodSync(spoolRoot, 0o755)
    expect(() => producer.emitEvent(envelope(), { ...producerOptions(spoolRoot), effectiveUid: 10001 })).toThrow("must run as root")
    expect(() => producer.emitEvent(envelope(), { ...producerOptions(spoolRoot), expectedSpoolOwnerUid: 0 })).toThrow("root-owned")
    expect(() => producer.emitEvent(envelope({ incidentKey: "../escape" }), producerOptions(spoolRoot))).toThrow("invalid")
    expect(() => producer.emitEvent(envelope({ summary: "x".repeat(4097) }), producerOptions(spoolRoot))).toThrow("bounded")
    producer.emitEvent(envelope(), producerOptions(spoolRoot))
    expect(() => producer.emitEvent(envelope({ summary: "different" }), { ...producerOptions(spoolRoot, "c".repeat(64)), now: () => "2026-08-29T19:56:00.000Z" })).toThrow("transition already exists with different content")
  })

  it("publishes without replacement when concurrent processes emit conflicting content", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const spoolRoot = root("ouro-producer-concurrent")
    fs.chmodSync(spoolRoot, 0o755)
    const outcomes = await Promise.all([
      runProducerProcess(producerPath, envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, summary: "first contender" }), { spoolRoot, nonce: "c".repeat(64) }),
      runProducerProcess(producerPath, envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, summary: "second contender" }), { spoolRoot, nonce: "d".repeat(64) }),
    ])

    expect(outcomes.filter((outcome) => outcome.code === 0)).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.stderr.includes("different content")), JSON.stringify(outcomes)).toHaveLength(1)
    expect(fs.readdirSync(spoolRoot)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!), "utf8")).summary).toMatch(/contender/u)
  })

  it("recovers a dead producer lock and publishes a single-link final file without hard links", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?recovery=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions>): { filePath: string; created: boolean }
    }
    const spoolRoot = root("ouro-producer-recovery")
    fs.chmodSync(spoolRoot, 0o755)
    const value = envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined })
    const lockDir = path.join(spoolRoot, ".producer.lock")
    fs.mkdirSync(lockDir)
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "stale-token", pid: process.pid, processStart: "reused-pid", leaseUntil: new Date(0).toISOString() }))
    fs.writeFileSync(path.join(lockDir, "event.tmp"), "partial")

    const result = producer.emitEvent(value, producerOptions(spoolRoot))
    expect(result.created).toBe(true)
    expect(fs.statSync(result.filePath).nlink).toBe(1)
    expect(fs.existsSync(lockDir)).toBe(false)
    expect(fs.readFileSync(producerPath, "utf8")).not.toContain("fs.linkSync(")
  })

  it("fails closed on a dangling producer lock instead of retrying forever", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?dangling-lock=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions>): unknown
    }
    const spoolRoot = root("ouro-producer-dangling-lock")
    fs.chmodSync(spoolRoot, 0o755)
    fs.symlinkSync("missing-lock-target", path.join(spoolRoot, ".producer.lock"))

    expect(() => producer.emitEvent(envelope(), producerOptions(spoolRoot))).toThrow("event transition publication lock is unsafe")
  })

  it("prunes only canonical safely-opened envelopes expired past grace on every detector tick", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?maintenance=${Date.now()}`) as {
      maintainSpool(options: ReturnType<typeof producerOptions> & { graceMs: number }): { pruned: number; preserved: number }
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions> & { graceMs: number; maxSpoolFiles: number }): { created: boolean }
    }
    const spoolRoot = root("ouro-producer-maintenance")
    fs.chmodSync(spoolRoot, 0o755)
    const expired = envelope({ createdAt: "2026-08-27T19:00:00.000Z", expiresAt: "2026-08-27T20:00:00.000Z", transitionId: "expired", nonce: "1".repeat(64) })
    const recent = envelope({ createdAt: "2026-08-29T19:40:00.000Z", expiresAt: "2026-08-29T20:10:00.000Z", transitionId: "recent", nonce: "2".repeat(64) })
    const expiredPath = writeSpoolFile(spoolRoot, expired)
    const recentPath = writeSpoolFile(spoolRoot, recent)
    const invalidPath = path.join(spoolRoot, `${"a".repeat(64)}.json`)
    fs.writeFileSync(invalidPath, "not-json", { mode: 0o444 })
    fs.chmodSync(invalidPath, 0o444)
    const options = { ...producerOptions(spoolRoot), graceMs: 60 * 60_000 }

    expect(producer.maintainSpool(options)).toEqual({ pruned: 1, preserved: 2 })
    expect(fs.existsSync(expiredPath)).toBe(false)
    expect(fs.existsSync(recentPath)).toBe(true)
    expect(fs.existsSync(invalidPath)).toBe(true)
    expect(producer.emitEvent(envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, incidentKey: "after-prune", transitionId: "after-prune" }), { ...options, maxSpoolFiles: 3 }).created).toBe(true)
  })

  it("fails closed at bounded spool capacity while preserving existing idempotency", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?capacity=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: ReturnType<typeof producerOptions> & { maxSpoolFiles: number }): { filePath: string; created: boolean }
    }
    const spoolRoot = root("ouro-producer-capacity")
    fs.chmodSync(spoolRoot, 0o755)
    const firstInput = envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, incidentKey: "capacity-1", transitionId: "capacity-1" })
    const options = { ...producerOptions(spoolRoot), maxSpoolFiles: 1 }
    expect(producer.emitEvent(firstInput, options).created).toBe(true)
    expect(producer.emitEvent(firstInput, options).created).toBe(false)
    expect(() => producer.emitEvent(envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, incidentKey: "capacity-2", transitionId: "capacity-2" }), options)).toThrow("capacity")
    expect(fs.readdirSync(spoolRoot).filter((name) => name.endsWith(".json"))).toHaveLength(1)

    const concurrentRoot = root("ouro-producer-concurrent-capacity")
    fs.chmodSync(concurrentRoot, 0o755)
    const outcomes = await Promise.all([1, 2].map((index) => runProducerProcess(producerPath, envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined, incidentKey: `bounded-${index}`, transitionId: `bounded-${index}` }), { spoolRoot: concurrentRoot, nonce: String(index).repeat(64), maxSpoolFiles: 1 })))
    expect(outcomes.filter((outcome) => outcome.code === 0)).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.stderr.includes("capacity"))).toHaveLength(1)
    expect(fs.readdirSync(concurrentRoot).filter((name) => name.endsWith(".json"))).toHaveLength(1)
  })
})

describe("external-event record bound", () => {
  it("refuses a final serialized receipt larger than 64 KiB", () => {
    const eventRoot = root("ouro-record-bound")
    expect(() => recordExternalEvent({
      agent: "sanctuary",
      source: "bounded-source",
      eventType: "large",
      eventId: "large",
      evidence: Array.from({ length: 31 }, (_, index) => `${index}:${"x".repeat(2_090)}`),
    }, { root: eventRoot })).toThrow("record must be bounded")
    expect(listExternalEventStatus(eventRoot)).toEqual([])
  })
})
