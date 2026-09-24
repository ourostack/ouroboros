import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { readSessionTransaction, withImmediateSessionTurnLease, writeSessionTransaction } from "../../mind/session-transaction"
import { emitNervesEvent } from "../../nerves/runtime"

interface EpochInput {
  root: string
  epochId: string
  tokenPath: string
  previousTokenPath: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  predecessorCursor: number
  packageDigest: string
}
interface Epoch {
  schemaVersion: 1
  state: "prepared" | "retired"
  epochId: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  predecessorCursor: number
  packageDigest: string
  tokenPath: string
  tokenDigest: string
  previousTokenDigest: string
  publicKeyPem: string
  publicKeyDigest: string
  revokedTokenStatus: 401
  createdAt: string
  terminalCursor: number | null
}
interface Owner { expectedUid: number; expectedGid: number }
interface PrepareOptions extends Owner {
  probe(token: string): Promise<{ status: number; botId: string | null }>
  now(): string
}
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const TOKEN = /^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/u
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

function assertRoot(root: string, owner: Owner): void {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || fs.realpathSync(root) !== root || stat.uid !== owner.expectedUid || stat.gid !== owner.expectedGid || (stat.mode & 0o7777) !== 0o700) throw new Error("Sanctuary authority epoch root is unsafe")
}
function privateBytes(filePath: string, owner: Owner): Buffer {
  if (!path.isAbsolute(filePath) || fs.realpathSync(filePath) !== filePath) throw new Error("Sanctuary authority epoch path is unsafe")
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner.expectedUid || stat.gid !== owner.expectedGid || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 65536) throw new Error("Sanctuary authority epoch file metadata is unsafe")
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}
function issuer(root: string, owner: Owner) {
  const key = createPrivateKey(privateBytes(path.join(root, "issuer.pem"), owner))
  const publicKey = createPublicKey(key)
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Sanctuary authority issuer is not Ed25519")
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), publicKeyDigest: sha(publicKey.export({ type: "spki", format: "der" })) }
}
function validate(value: unknown): Epoch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sanctuary authority epoch is invalid")
  const epoch = value as Epoch
  if (Object.keys(epoch).sort().join(",") !== "botId,createdAt,epochId,ownerChatId,ownerUserId,packageDigest,predecessorCursor,previousTokenDigest,publicKeyDigest,publicKeyPem,revokedTokenStatus,schemaVersion,state,terminalCursor,tokenDigest,tokenPath"
    || epoch.schemaVersion !== 1 || !["prepared", "retired"].includes(epoch.state)
    || typeof epoch.epochId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(epoch.epochId)
    || ![epoch.botId, epoch.ownerUserId, epoch.ownerChatId].every((id) => typeof id === "string" && /^[1-9][0-9]*$/u.test(id)) || epoch.ownerUserId !== epoch.ownerChatId
    || !Number.isSafeInteger(epoch.predecessorCursor) || epoch.predecessorCursor < 0
    || ![epoch.packageDigest, epoch.tokenDigest, epoch.previousTokenDigest, epoch.publicKeyDigest].every((value) => typeof value === "string" && DIGEST.test(value))
    || epoch.tokenDigest === epoch.previousTokenDigest || typeof epoch.tokenPath !== "string" || !path.isAbsolute(epoch.tokenPath)
    || typeof epoch.publicKeyPem !== "string" || epoch.revokedTokenStatus !== 401
    || typeof epoch.createdAt !== "string" || !Number.isFinite(Date.parse(epoch.createdAt)) || new Date(epoch.createdAt).toISOString() !== epoch.createdAt
    || (epoch.state === "prepared" ? epoch.terminalCursor !== null : !Number.isSafeInteger(epoch.terminalCursor) || epoch.terminalCursor! < epoch.predecessorCursor)) throw new Error("Sanctuary authority epoch is invalid")
  return epoch
}

function syncRoot(root: string): void {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeRecord(filePath: string, record: unknown): void {
  withImmediateSessionTurnLease(filePath, (lease) => {
    const transaction = readSessionTransaction(filePath, lease)
    writeSessionTransaction(filePath, record, { lease, expectedRevision: transaction.revision })
  })
}

function writeIssuer(root: string, key: string, owner: Owner): void {
  const temporary = path.join(root, "issuer.pem.tmp")
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  let owned = false
  try {
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner.expectedUid || stat.gid !== owner.expectedGid || (stat.mode & 0o7777) !== 0o600) throw new Error("Sanctuary issuer temporary is unsafe")
      owned = true
      fs.ftruncateSync(fd, 0)
      fs.writeFileSync(fd, key)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, path.join(root, "issuer.pem"))
  } catch (error) {
    if (owned) fs.unlinkSync(temporary)
    throw error
  }
  syncRoot(root)
}

export function readSanctuaryAuthorityEpoch(root: string, owner: Owner): Epoch {
  assertRoot(root, owner)
  const epoch = validate(JSON.parse(privateBytes(path.join(root, "epoch.json"), owner).toString("utf8")))
  const publicKey = issuer(root, owner)
  if (publicKey.publicKeyDigest !== epoch.publicKeyDigest || publicKey.publicKeyPem !== epoch.publicKeyPem) throw new Error("Sanctuary authority epoch key or token changed")
  if (epoch.state === "retired" && fs.existsSync(path.join(root, "handoff.json"))) {
    const handoff = JSON.parse(privateBytes(path.join(root, "handoff.json"), owner).toString("utf8"))
    if (JSON.stringify(handoff) !== JSON.stringify({ schemaVersion: 1, epochId: epoch.epochId, tokenDigest: epoch.tokenDigest, cursor: epoch.terminalCursor })) throw new Error("Sanctuary authority token handoff changed")
    if (fs.existsSync(epoch.tokenPath) && sha(privateBytes(epoch.tokenPath, owner).toString("utf8").trim()) !== epoch.tokenDigest) throw new Error("Sanctuary authority epoch key or token changed")
  } else if (sha(privateBytes(epoch.tokenPath, owner).toString("utf8").trim()) !== epoch.tokenDigest) throw new Error("Sanctuary authority epoch key or token changed")
  return epoch
}

export async function prepareSanctuaryAuthorityEpoch(input: EpochInput, options: PrepareOptions): Promise<Epoch> {
  assertRoot(input.root, options)
  if (typeof input.epochId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.epochId)
    || ![input.botId, input.ownerUserId, input.ownerChatId].every((id) => typeof id === "string" && /^[1-9][0-9]*$/u.test(id)) || input.ownerUserId !== input.ownerChatId
    || !Number.isSafeInteger(input.predecessorCursor) || input.predecessorCursor < 0 || !DIGEST.test(input.packageDigest)) throw new Error("Sanctuary authority epoch input is invalid")
  const token = privateBytes(input.tokenPath, options).toString("utf8").trim()
  const previousToken = privateBytes(input.previousTokenPath, options).toString("utf8").trim()
  if (!TOKEN.test(token) || !TOKEN.test(previousToken) || token.split(":")[0] !== input.botId || previousToken.split(":")[0] !== input.botId || token === previousToken) throw new Error("Sanctuary authority requires a fresh same-bot token")
  const previous = await options.probe(previousToken)
  if (previous.status !== 401 || previous.botId !== null) throw new Error("Sanctuary previous Telegram token is not proven revoked")
  const current = await options.probe(token)
  if (current.status !== 200 || current.botId !== input.botId) throw new Error("Sanctuary new Telegram token identity is invalid")
  const epochPath = path.join(input.root, "epoch.json")
  const keyPath = path.join(input.root, "issuer.pem")
  const intentPath = path.join(input.root, "issuer-intent.json")
  const inputDigest = sha(JSON.stringify({ ...input, tokenDigest: sha(token), previousTokenDigest: sha(previousToken) }))
  return withImmediateSessionTurnLease(epochPath, (lease) => {
    const transaction = readSessionTransaction(epochPath, lease)
    let existing = false
    try { fs.lstatSync(epochPath); existing = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (existing) {
      const epoch = readSanctuaryAuthorityEpoch(input.root, options)
      if (epoch.state === "retired") throw new Error("Sanctuary authority epoch is retired; a fresh token and key epoch are required")
      for (const key of ["epochId", "botId", "ownerUserId", "ownerChatId", "predecessorCursor", "packageDigest", "tokenPath"] as const) {
        if (epoch[key] !== input[key]) throw new Error("Sanctuary authority epoch input changed")
      }
      if (epoch.previousTokenDigest !== sha(previousToken)) throw new Error("Sanctuary authority predecessor token changed")
      if (fs.existsSync(intentPath)) {
        const intent = JSON.parse(privateBytes(intentPath, options).toString("utf8"))
        if (intent.inputDigest !== inputDigest || intent.key !== privateBytes(keyPath, options).toString("utf8")) throw new Error("Sanctuary issuer cleanup identity changed")
        fs.unlinkSync(intentPath)
        syncRoot(input.root)
      }
      return epoch
    }
    let intent: { inputDigest: string; key: string; createdAt: string }
    if (fs.existsSync(intentPath)) {
      intent = JSON.parse(privateBytes(intentPath, options).toString("utf8"))
      if (!intent || Object.keys(intent).sort().join(",") !== "createdAt,inputDigest,key" || intent.inputDigest !== inputDigest || typeof intent.key !== "string") throw new Error("Sanctuary issuer preparation identity changed")
    } else {
      if (fs.existsSync(keyPath)) throw new Error("Sanctuary authority issuer is orphaned; a fresh epoch is required")
      intent = { inputDigest, key: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(), createdAt: options.now() }
      writeRecord(intentPath, intent)
    }
    if (fs.existsSync(keyPath)) {
      if (privateBytes(keyPath, options).toString("utf8") !== intent.key) throw new Error("Sanctuary prepared issuer changed")
    } else {
      writeIssuer(input.root, intent.key, options)
    }
    const epoch = validate({
      schemaVersion: 1, state: "prepared", epochId: input.epochId, botId: input.botId, ownerUserId: input.ownerUserId, ownerChatId: input.ownerChatId,
      predecessorCursor: input.predecessorCursor, packageDigest: input.packageDigest, tokenPath: input.tokenPath, tokenDigest: sha(token), previousTokenDigest: sha(previousToken),
      ...issuer(input.root, options), revokedTokenStatus: 401, createdAt: intent.createdAt, terminalCursor: null,
    })
    writeSessionTransaction(epochPath, epoch, { lease, expectedRevision: transaction.revision })
    fs.unlinkSync(intentPath)
    syncRoot(input.root)
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_authority_epoch_prepared", message: "Sanctuary authority epoch prepared", meta: { epochId: epoch.epochId, publicKeyDigest: epoch.publicKeyDigest } })
    return epoch
  })
}

export function releaseSanctuaryAuthorityToken(root: string, options: Owner & { tokenDigest: string; cursor: number }): void {
  const epoch = readSanctuaryAuthorityEpoch(root, options)
  if (epoch.state !== "retired") throw new Error("Sanctuary authority token cannot leave an unretired epoch")
  if (epoch.tokenDigest !== options.tokenDigest || epoch.terminalCursor !== options.cursor || path.dirname(epoch.tokenPath) !== root) throw new Error("Sanctuary authority token handoff is invalid")
  writeRecord(path.join(root, "handoff.json"), { schemaVersion: 1, epochId: epoch.epochId, tokenDigest: epoch.tokenDigest, cursor: epoch.terminalCursor })
  if (fs.existsSync(epoch.tokenPath)) fs.unlinkSync(epoch.tokenPath)
  syncRoot(root)
}

/**
 * Move a live epoch to a new reviewed package without replacing its token, issuer
 * or cursor. An in-place upgrade (and its rollback) rebinds the package the epoch
 * trusts; the gateway still refuses any config whose package differs from the epoch's.
 */
export function rebindSanctuaryAuthorityEpochPackage(root: string, options: Owner & { from: string; to: string }): Epoch {
  if (!DIGEST.test(options.from) || !DIGEST.test(options.to)) throw new Error("Sanctuary authority package rebind is invalid")
  const epochPath = path.join(root, "epoch.json")
  return withImmediateSessionTurnLease(epochPath, (lease) => {
    const transaction = readSessionTransaction(epochPath, lease)
    const epoch = readSanctuaryAuthorityEpoch(root, options)
    if (epoch.state !== "prepared") throw new Error("Sanctuary authority epoch is retired")
    if (epoch.packageDigest === options.to) return epoch
    if (epoch.packageDigest !== options.from) throw new Error("Sanctuary authority epoch package changed")
    const rebound: Epoch = { ...epoch, packageDigest: options.to }
    writeSessionTransaction(epochPath, rebound, { lease, expectedRevision: transaction.revision })
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_authority_epoch_package_rebound", message: "Sanctuary authority epoch rebound to a reviewed package", meta: { epochId: epoch.epochId, from: options.from, to: options.to } })
    return rebound
  })
}

export function retireSanctuaryAuthorityEpoch(root: string, options: Owner & { quiescent: boolean; cursor: number }): Epoch {
  if (options.quiescent !== true) throw new Error("Sanctuary authority execution state is not quiescent")
  const epochPath = path.join(root, "epoch.json")
  return withImmediateSessionTurnLease(epochPath, (lease) => {
    const transaction = readSessionTransaction(epochPath, lease)
    const epoch = readSanctuaryAuthorityEpoch(root, options)
    if (!Number.isSafeInteger(options.cursor) || options.cursor < epoch.predecessorCursor || (epoch.state === "retired" && options.cursor !== epoch.terminalCursor)) throw new Error("Sanctuary authority terminal cursor is invalid")
    if (epoch.state === "retired") return epoch
    const retired: Epoch = { ...epoch, state: "retired", terminalCursor: options.cursor }
    writeSessionTransaction(epochPath, retired, { lease, expectedRevision: transaction.revision })
    return retired
  })
}
