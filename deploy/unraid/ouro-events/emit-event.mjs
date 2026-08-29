#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SPOOL_ROOT = "/boot/config/custom/ouro-events/spool"
const MAX_BYTES = 32 * 1024
const MAX_SPOOL_FILES = 4_096

function id(value, name) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function bounded(value, name, max) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max) throw new Error(`${name} must be bounded`)
  return value
}

function stableInput(envelope) {
  const { createdAt: _createdAt, expiresAt: _expiresAt, nonce: _nonce, ...stable } = envelope
  return stable
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
    critical: input.critical,
    summary: bounded(input.summary, "summary", 4_096),
    evidence: evidence.map((entry) => bounded(entry, "evidence", 2_048)),
    createdAt,
    expiresAt,
    nonce: nonce(),
  }
  if (envelope.schemaVersion !== 1 || envelope.agent !== "sanctuary" || envelope.source !== "sanctuary-usenet"
    || envelope.eventType !== "usenet.protective_action" || !["sabnzbd.pause", "prowlarr.disable-indexer"].includes(envelope.action)
    || envelope.critical !== true || !/^[a-f0-9]{64}$/u.test(String(envelope.observationRevision)) || !/^[a-f0-9]{64}$/u.test(String(envelope.nonce))) {
    throw new Error("event envelope is invalid")
  }
  const serialized = `${JSON.stringify(envelope)}\n`
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("event envelope must be bounded")
  return { envelope, serialized }
}

export function emitEvent(input, options = {}) {
  const effectiveUid = options.effectiveUid ?? process.getuid?.()
  if (effectiveUid !== 0) throw new Error("ouro event producer must run as root")
  const spoolRoot = options.spoolRoot ?? SPOOL_ROOT
  const expectedOwnerUid = options.expectedSpoolOwnerUid ?? 0
  const directory = fs.openSync(spoolRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const openedRoot = fs.fstatSync(directory)
    const assertRootIdentity = () => {
      const namedRoot = fs.lstatSync(spoolRoot)
      if (!openedRoot.isDirectory() || openedRoot.uid !== expectedOwnerUid || (openedRoot.mode & 0o777) !== 0o755
        || !namedRoot.isDirectory() || namedRoot.isSymbolicLink() || namedRoot.uid !== expectedOwnerUid || (namedRoot.mode & 0o777) !== 0o755
        || namedRoot.dev !== openedRoot.dev || namedRoot.ino !== openedRoot.ino) {
        throw new Error(expectedOwnerUid === 0 ? "event spool root must be root-owned and mode 0755" : "event spool root is unsafe")
      }
    }
    assertRootIdentity()
    const anchoredRoot = process.platform === "linux" ? `/proc/self/fd/${directory}` : spoolRoot
    const { envelope, serialized } = buildEnvelope(input, options.now ?? (() => new Date()), options.nonce ?? (() => randomBytes(32).toString("hex")))
    const digest = createHash("sha256").update(`${envelope.source}\0${envelope.incidentKey}\0${envelope.transitionId}`).digest("hex")
    const fileName = `${digest}.json`
    const filePath = path.join(spoolRoot, fileName)
    const anchoredFile = path.join(anchoredRoot, fileName)
    const readPublished = () => {
      let file
      try { file = fs.openSync(anchoredFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
        if (error?.code === "ENOENT") return null
        throw error
      }
      try {
        const metadata = fs.fstatSync(file)
        if (!metadata.isFile() || metadata.uid !== expectedOwnerUid || (metadata.mode & 0o777) !== 0o444 || metadata.size > MAX_BYTES) {
          throw new Error("existing event spool file is unsafe")
        }
        return JSON.parse(fs.readFileSync(file, "utf8"))
      } finally { fs.closeSync(file) }
    }
    const existing = readPublished()
    if (existing) {
      if (JSON.stringify(stableInput(existing)) !== JSON.stringify(stableInput(envelope))) throw new Error("transition already exists with different content")
      return { filePath, created: false }
    }
    const lockName = ".producer.lock"
    const lockPath = path.join(anchoredRoot, lockName)
    const cleanupLock = (target) => {
      for (const name of ["event.tmp", "owner.json"]) {
        try { fs.unlinkSync(path.join(target, name)) } catch (error) { if (error?.code !== "ENOENT") throw error }
      }
      fs.rmdirSync(target)
    }
    const lockDeadline = Date.now() + 30_000
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 })
        const ownerPath = path.join(lockPath, "owner.json")
        fs.writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, { mode: 0o600, flag: "wx" })
        const owner = fs.openSync(ownerPath, "r")
        try { fs.fsyncSync(owner) } finally { fs.closeSync(owner) }
        break
      } catch (error) {
        if (error?.code !== "EEXIST") throw error
        const winner = readPublished()
        if (winner) {
          if (JSON.stringify(stableInput(winner)) !== JSON.stringify(stableInput(envelope))) throw new Error("transition already exists with different content")
          return { filePath, created: false }
        }
        let ownerPid = 0
        try { ownerPid = Number(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).pid) } catch { /* incomplete lock owner */ }
        let ownerAlive = ownerPid > 0
        if (ownerAlive) {
          try { process.kill(ownerPid, 0) } catch (signalError) { ownerAlive = signalError?.code !== "ESRCH" }
        }
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs
        if (!ownerAlive && (ownerPid > 0 || lockAge > 30_000)) {
          const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`
          try { fs.renameSync(lockPath, stalePath) } catch { continue }
          cleanupLock(stalePath)
          continue
        }
        if (Date.now() >= lockDeadline) throw new Error("event transition publication is busy")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    const temporary = path.join(lockPath, "event.tmp")
    try {
      const winner = readPublished()
      if (winner) {
        if (JSON.stringify(stableInput(winner)) !== JSON.stringify(stableInput(envelope))) throw new Error("transition already exists with different content")
        return { filePath, created: false }
      }
      const maxSpoolFiles = options.maxSpoolFiles ?? MAX_SPOOL_FILES
      if (!Number.isSafeInteger(maxSpoolFiles) || maxSpoolFiles < 1) throw new Error("event spool capacity is invalid")
      const currentFiles = fs.readdirSync(anchoredRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length
      if (currentFiles >= maxSpoolFiles) throw new Error("event spool capacity is exhausted; existing artifacts were preserved")
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" })
      const file = fs.openSync(temporary, "r")
      try { fs.fsyncSync(file) } finally { fs.closeSync(file) }
      fs.chmodSync(temporary, 0o444)
      assertRootIdentity()
      fs.renameSync(temporary, anchoredFile)
      fs.fsyncSync(directory)
      assertRootIdentity()
      return { filePath, created: true }
    } finally {
      cleanupLock(lockPath)
    }
  } finally {
    fs.closeSync(directory)
  }
}

function parseArgs(argv) {
  const input = { schemaVersion: 1, critical: true, evidence: [] }
  const names = new Map([
    ["--agent", "agent"], ["--source", "source"], ["--event-type", "eventType"], ["--incident-key", "incidentKey"],
    ["--transition-id", "transitionId"], ["--revision", "observationRevision"], ["--action", "action"],
    ["--action-receipt", "actionReceipt"], ["--summary", "summary"],
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--evidence" && value !== undefined) input.evidence.push(value)
    else if (names.has(flag) && value !== undefined) input[names.get(flag)] = value
    else throw new Error("event producer arguments are invalid")
  }
  return input
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = emitEvent(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${result.created ? "created" : "existing"} ${path.basename(result.filePath)}\n`)
  } catch (error) {
    process.stderr.write(`ouro event producer failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
    process.exitCode = 1
  }
}
