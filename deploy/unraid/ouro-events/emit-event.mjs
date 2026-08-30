#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SPOOL_ROOT = "/boot/config/custom/ouro-events/spool"
const MAX_BYTES = 32 * 1024
const MAX_SPOOL_FILES = 4_096
const DEFAULT_EXPIRY_GRACE_MS = 24 * 60 * 60_000
const ENVELOPE_KEYS = ["action", "actionReceipt", "agent", "createdAt", "critical", "eventType", "evidence", "expiresAt", "incidentKey", "nonce", "observationRevision", "protectiveStateDigest", "protectiveStateObservedAt", "protectiveStateVerified", "schemaVersion", "source", "summary", "transitionId"]

function id(value, name) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function bounded(value, name, max) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max) throw new Error(`${name} must be bounded`)
  return value
}

function stableInput(envelope) {
  const { createdAt: _createdAt, expiresAt: _expiresAt, nonce: _nonce, protectiveStateObservedAt: _protectiveStateObservedAt, ...stable } = envelope
  return stable
}

function canonicalIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validateEnvelope(envelope) {
  const eventShapeIsAllowed = envelope && typeof envelope === "object" && !Array.isArray(envelope) && ((envelope.eventType === "usenet.protective_action" && envelope.action === "sabnzbd.pause")
    || (envelope.eventType === "usenet.health_observation" && envelope.action === "usenet.observe"))
  const observationTransitionIsAllowed = envelope?.eventType !== "usenet.health_observation" || /^(?:auth-failed|stalled|recovered|indeterminate):\d{8}T\d{6}Z$/u.test(String(envelope.transitionId))
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).sort().join("\0") !== [...ENVELOPE_KEYS].sort().join("\0")
    || envelope.schemaVersion !== 1 || envelope.agent !== "sanctuary" || envelope.source !== "sanctuary-usenet"
    || !eventShapeIsAllowed || !observationTransitionIsAllowed
    || envelope.critical !== true || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(String(envelope.incidentKey)) || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(String(envelope.transitionId))
    || !/^[a-f0-9]{64}$/u.test(String(envelope.observationRevision)) || !/^[a-f0-9]{64}$/u.test(String(envelope.nonce))
    || typeof envelope.protectiveStateVerified !== "boolean" || !/^[a-f0-9]{64}$/u.test(String(envelope.protectiveStateDigest))
    || !canonicalIso(envelope.protectiveStateObservedAt)
    || typeof envelope.actionReceipt !== "string" || !envelope.actionReceipt || Buffer.byteLength(envelope.actionReceipt) > 512
    || typeof envelope.summary !== "string" || !envelope.summary || Buffer.byteLength(envelope.summary) > 4_096
    || !Array.isArray(envelope.evidence) || envelope.evidence.length > 16 || envelope.evidence.some((entry) => typeof entry !== "string" || !entry || Buffer.byteLength(entry) > 2_048)
    || !canonicalIso(envelope.createdAt) || !canonicalIso(envelope.expiresAt)
    || Date.parse(envelope.expiresAt) <= Date.parse(envelope.createdAt)
    || Date.parse(envelope.expiresAt) - Date.parse(envelope.createdAt) > 60 * 60_000) {
    throw new Error("event envelope is invalid")
  }
  const serialized = `${JSON.stringify(envelope)}\n`
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("event envelope must be bounded")
  return serialized
}

function buildEnvelope(input, now, nonce) {
  const createdAt = new Date(now()).toISOString()
  const expiresAt = new Date(Date.parse(createdAt) + 15 * 60_000).toISOString()
  const evidence = input.evidence ?? []
  if (!Array.isArray(evidence) || evidence.length > 16) throw new Error("evidence must be bounded")
  const envelope = {
    schemaVersion: input.schemaVersion,
    agent: input.agent,
    source: input.source,
    eventType: input.eventType,
    incidentKey: id(input.incidentKey, "incident key"),
    transitionId: id(input.transitionId, "transition id"),
    observationRevision: input.observationRevision,
    action: input.action,
    actionReceipt: bounded(input.actionReceipt, "action receipt", 512),
    protectiveStateVerified: input.protectiveStateVerified,
    protectiveStateDigest: input.protectiveStateDigest,
    protectiveStateObservedAt: input.protectiveStateObservedAt,
    critical: input.critical,
    summary: bounded(input.summary, "summary", 4_096),
    evidence: evidence.map((entry) => bounded(entry, "evidence", 2_048)),
    createdAt,
    expiresAt,
    nonce: nonce(),
  }
  return { envelope, serialized: validateEnvelope(envelope) }
}

function linuxProcessStart(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/u)[19] ?? null
  } catch { return null }
}

const currentProcessStart = linuxProcessStart(process.pid) ?? `fallback-${Math.floor(Date.now() - process.uptime() * 1_000)}`

function ownerIsLive(owner) {
  if (!owner || typeof owner.token !== "string" || !Number.isSafeInteger(owner.pid) || typeof owner.processStart !== "string") return false
  try { process.kill(owner.pid, 0) } catch (error) { return error?.code !== "ESRCH" }
  const observedStart = owner.pid === process.pid ? currentProcessStart : linuxProcessStart(owner.pid)
  return observedStart === null || observedStart === owner.processStart
}

function openSpool(options) {
  const effectiveUid = options.effectiveUid ?? process.getuid?.()
  if (effectiveUid !== 0) throw new Error("ouro event producer must run as root")
  const spoolRoot = options.spoolRoot ?? SPOOL_ROOT
  const expectedOwnerUid = options.expectedSpoolOwnerUid ?? 0
  const directory = fs.openSync(spoolRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const openedRoot = fs.fstatSync(directory)
  const assertRootIdentity = () => {
    const namedRoot = fs.lstatSync(spoolRoot)
    if (!openedRoot.isDirectory() || openedRoot.uid !== expectedOwnerUid || (openedRoot.mode & 0o777) !== 0o755
      || !namedRoot.isDirectory() || namedRoot.isSymbolicLink() || namedRoot.uid !== expectedOwnerUid || (namedRoot.mode & 0o777) !== 0o755
      || namedRoot.dev !== openedRoot.dev || namedRoot.ino !== openedRoot.ino) {
      throw new Error(expectedOwnerUid === 0 ? "event spool root must be root-owned and mode 0755" : "event spool root is unsafe")
    }
  }
  try {
    assertRootIdentity()
    return { spoolRoot, expectedOwnerUid, directory, anchoredRoot: process.platform === "linux" ? `/proc/self/fd/${directory}` : spoolRoot, assertRootIdentity }
  } catch (error) {
    fs.closeSync(directory)
    throw error
  }
}

function writeOwner(ownerPath, owner) {
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" })
  const file = fs.openSync(ownerPath, "r")
  try { fs.fsyncSync(file) } finally { fs.closeSync(file) }
}

function withProducerLock(context, operation) {
  const lockPath = path.join(context.anchoredRoot, ".producer.lock")
  const ownerPath = path.join(lockPath, "owner.json")
  const token = randomBytes(32).toString("hex")
  const cleanup = (target, verifyToken) => {
    if (verifyToken) {
      let owner
      try { owner = JSON.parse(fs.readFileSync(path.join(target, "owner.json"), "utf8")) } catch { return }
      if (owner.token !== token) return
    }
    for (const name of ["event.tmp", "owner.json"]) {
      try { fs.unlinkSync(path.join(target, name)) } catch (error) { if (error?.code !== "ENOENT") throw error }
    }
    fs.rmdirSync(target)
  }
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      writeOwner(ownerPath, { token, pid: process.pid, processStart: currentProcessStart, leaseUntil: new Date(Date.now() + 30_000).toISOString() })
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let owner = null
      try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) } catch { /* incomplete owner */ }
      if (ownerIsLive(owner)) {
        if (Date.now() >= deadline) throw new Error("event transition publication is busy")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        continue
      }
      let leaseActive
      if (owner && canonicalIso(owner.leaseUntil)) {
        leaseActive = Date.parse(owner.leaseUntil) > Date.now()
      } else {
        try {
          leaseActive = Date.now() - fs.statSync(lockPath).mtimeMs <= 30_000
        } catch (statError) {
          if (statError?.code === "ENOENT") {
            try {
              fs.lstatSync(lockPath)
            } catch (lstatError) {
              if (lstatError?.code === "ENOENT") continue
              throw lstatError
            }
            throw new Error("event transition publication lock is unsafe")
          }
          throw statError
        }
      }
      if (leaseActive) {
        if (Date.now() >= deadline) throw new Error("event transition publication is busy")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        continue
      }
      const stalePath = `${lockPath}.stale-${token}`
      try { fs.renameSync(lockPath, stalePath) } catch { continue }
      cleanup(stalePath, false)
    }
  }
  try { return operation(lockPath) } finally { cleanup(lockPath, true) }
}

function parseStoredEnvelope(raw, fileName) {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("event envelope must be bounded")
  const envelope = JSON.parse(raw)
  validateEnvelope(envelope)
  const expectedName = `${createHash("sha256").update(`${envelope.source}\0${envelope.incidentKey}\0${envelope.transitionId}`).digest("hex")}.json`
  if (fileName !== expectedName) throw new Error("event envelope filename is invalid")
  return envelope
}

function readSafeEnvelope(context, fileName, directoryEntry) {
  const filePath = path.join(context.anchoredRoot, fileName)
  const before = fs.lstatSync(filePath)
  if ((directoryEntry && !directoryEntry.isFile()) || before.isSymbolicLink() || !before.isFile() || before.uid !== context.expectedOwnerUid
    || before.nlink !== 1 || (before.mode & 0o777) !== 0o444 || before.size < 2 || before.size > MAX_BYTES) throw new Error("existing event spool file is unsafe")
  const file = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(file)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.uid !== context.expectedOwnerUid
      || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o444) throw new Error("existing event spool file changed")
    return parseStoredEnvelope(fs.readFileSync(file, "utf8"), fileName)
  } finally { fs.closeSync(file) }
}

function maintainUnderLock(context, options) {
  const now = new Date(options.now?.() ?? new Date()).getTime()
  const graceMs = options.graceMs ?? DEFAULT_EXPIRY_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("event spool expiry grace is invalid")
  let pruned = 0
  let preserved = 0
  for (const entry of fs.readdirSync(context.anchoredRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue
    const filePath = path.join(context.anchoredRoot, entry.name)
    try {
      const envelope = readSafeEnvelope(context, entry.name, entry)
      if (Date.parse(envelope.expiresAt) + graceMs >= now) { preserved += 1; continue }
      fs.unlinkSync(filePath)
      pruned += 1
    } catch {
      preserved += 1
    }
  }
  if (pruned > 0) fs.fsyncSync(context.directory)
  return { pruned, preserved }
}

export function maintainSpool(options = {}) {
  const context = openSpool(options)
  try { return withProducerLock(context, () => maintainUnderLock(context, options)) } finally { fs.closeSync(context.directory) }
}

export function emitEvent(input, options = {}) {
  const context = openSpool(options)
  try {
    const { envelope, serialized } = buildEnvelope(input, options.now ?? (() => new Date()), options.nonce ?? (() => randomBytes(32).toString("hex")))
    const digest = createHash("sha256").update(`${envelope.source}\0${envelope.incidentKey}\0${envelope.transitionId}`).digest("hex")
    const fileName = `${digest}.json`
    const filePath = path.join(context.spoolRoot, fileName)
    return withProducerLock(context, (lockPath) => {
      maintainUnderLock(context, options)
      let existing = null
      try {
        existing = readSafeEnvelope(context, fileName)
      } catch (error) { if (error?.code !== "ENOENT") throw error }
      if (existing) {
        if (JSON.stringify(stableInput(existing)) !== JSON.stringify(stableInput(envelope))) throw new Error("transition already exists with different content")
        return { filePath, created: false }
      }
      const maxSpoolFiles = options.maxSpoolFiles ?? MAX_SPOOL_FILES
      if (!Number.isSafeInteger(maxSpoolFiles) || maxSpoolFiles < 1) throw new Error("event spool capacity is invalid")
      const currentFiles = fs.readdirSync(context.anchoredRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length
      if (currentFiles >= maxSpoolFiles) throw new Error("event spool capacity is exhausted; unexpired and unsafe artifacts were preserved")
      const temporary = path.join(lockPath, "event.tmp")
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" })
      const file = fs.openSync(temporary, "r")
      try { fs.fsyncSync(file) } finally { fs.closeSync(file) }
      fs.chmodSync(temporary, 0o444)
      context.assertRootIdentity()
      fs.renameSync(temporary, path.join(context.anchoredRoot, fileName))
      fs.fsyncSync(context.directory)
      context.assertRootIdentity()
      return { filePath, created: true }
    })
  } finally { fs.closeSync(context.directory) }
}

function parseArgs(argv) {
  const input = { schemaVersion: 1, critical: true, evidence: [] }
  const names = new Map([
    ["--agent", "agent"], ["--source", "source"], ["--event-type", "eventType"], ["--incident-key", "incidentKey"],
    ["--transition-id", "transitionId"], ["--revision", "observationRevision"], ["--action", "action"],
    ["--action-receipt", "actionReceipt"], ["--summary", "summary"],
    ["--protective-state-digest", "protectiveStateDigest"], ["--protective-state-observed-at", "protectiveStateObservedAt"],
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--evidence" && value !== undefined) input.evidence.push(value)
    else if (flag === "--protective-state-verified" && (value === "true" || value === "false")) input.protectiveStateVerified = value === "true"
    else if (names.has(flag) && value !== undefined) input[names.get(flag)] = value
    else throw new Error("event producer arguments are invalid")
  }
  return input
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--maintain") {
      const result = maintainSpool()
      process.stdout.write(`maintained pruned=${result.pruned} preserved=${result.preserved}\n`)
    } else {
      const result = emitEvent(parseArgs(process.argv.slice(2)))
      process.stdout.write(`${result.created ? "created" : "existing"} ${path.basename(result.filePath)}\n`)
    }
  } catch (error) {
    process.stderr.write(`ouro event producer failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
    process.exitCode = 1
  }
}
