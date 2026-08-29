#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const SPOOL_ROOT = "/boot/config/custom/ouro-events/spool"
const MAX_BYTES = 32 * 1024

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
  const root = fs.lstatSync(spoolRoot)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o755) throw new Error("event spool root is unsafe")
  const { envelope, serialized } = buildEnvelope(input, options.now ?? (() => new Date()), options.nonce ?? (() => randomBytes(32).toString("hex")))
  const digest = createHash("sha256").update(`${envelope.source}\0${envelope.incidentKey}\0${envelope.transitionId}`).digest("hex")
  const filePath = path.join(spoolRoot, `${digest}.json`)
  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf8"))
    if (JSON.stringify(stableInput(existing)) !== JSON.stringify(stableInput(envelope))) throw new Error("transition already exists with different content")
    return { filePath, created: false }
  }
  const temporary = path.join(spoolRoot, `.${digest}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
  try {
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" })
    const file = fs.openSync(temporary, "r")
    try { fs.fsyncSync(file) } finally { fs.closeSync(file) }
    fs.chmodSync(temporary, 0o444)
    fs.renameSync(temporary, filePath)
    const directory = fs.openSync(spoolRoot, "r")
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch { /* nothing to clean */ }
    throw error
  }
  return { filePath, created: true }
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
