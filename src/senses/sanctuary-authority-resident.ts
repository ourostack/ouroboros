import { createHash, createPublicKey } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { SocketSanctuaryTelegramAuthorityClient } from "../heart/daemon/sanctuary-telegram-authority-service"
import { verifyAuthorityPayload } from "../heart/daemon/sanctuary-authority-codec"
import type { SanctuaryTelegramCursorSnapshot } from "../heart/daemon/sanctuary-telegram-authority-gateway"
import { emitNervesEvent } from "../nerves/runtime"
import { createSanctuaryTelegramAuthorityTransport, type SanctuaryTelegramAuthorityProtocolClient } from "./telegram-authority-transport"

export function openSanctuaryResidentAuthority(runtime: Record<string, unknown>, machineRuntime: Record<string, unknown>, options: {
  configPath?: string
  expectedUid?: number
  expectedGid?: number
  createClient?: (socketPath: string) => SanctuaryTelegramAuthorityProtocolClient
} = {}) {
  if ([runtime, machineRuntime].some((config) => Object.prototype.hasOwnProperty.call(config, "telegramBotToken"))) {
    throw new Error("Sanctuary resident Telegram token residue must be removed by the root migration")
  }
  const configPath = options.configPath ?? "/run/ouro-authority/resident.json"
  const expectedUid = options.expectedUid ?? 0
  const expectedGid = options.expectedGid ?? 10001
  const root = path.dirname(configPath)
  const parent = fs.lstatSync(root)
  if (!parent.isDirectory() || parent.uid !== expectedUid || parent.gid !== expectedGid || (parent.mode & 0o7777) !== 0o750 || fs.realpathSync(root) !== root) {
    throw new Error("Sanctuary resident authority directory is unsafe")
  }
  const descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let value: unknown
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.uid !== expectedUid || stat.gid !== expectedGid || (stat.mode & 0o7777) !== 0o640 || stat.nlink !== 1 || stat.size > 8192) throw new Error("Sanctuary resident authority pins are unsafe")
    value = JSON.parse(fs.readFileSync(descriptor, "utf8"))
  } finally {
    fs.closeSync(descriptor)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sanctuary resident authority pins are invalid")
  const config = value as Record<string, unknown>
  if (Object.keys(config).sort().join(",") !== "botId,keyId,ownerChatId,ownerUserId,publicKeyDigest,publicKeyPem,schemaVersion,targetHost"
    || config.schemaVersion !== 1 || config.targetHost !== "sanctuary"
    || !["botId", "ownerUserId", "ownerChatId"].every((key) => typeof config[key] === "string" && /^[1-9][0-9]*$/u.test(config[key] as string))
    || config.ownerUserId !== config.ownerChatId || typeof config.keyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(config.keyId)
    || typeof config.publicKeyPem !== "string" || typeof config.publicKeyDigest !== "string") throw new Error("Sanctuary resident authority identity is invalid")
  const publicKey = createPublicKey(config.publicKeyPem)
  if (publicKey.asymmetricKeyType !== "ed25519" || config.publicKeyDigest !== `sha256:${createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")}`) throw new Error("Sanctuary resident authority issuer pin changed")
  const client = (options.createClient ?? ((socketPath) => new SocketSanctuaryTelegramAuthorityClient(socketPath)))(path.join(root, "authority.sock"))
  const credentials = { botId: config.botId as string, authorizedUserId: config.ownerUserId as string, authorizedChatId: config.ownerChatId as string }
  const authorityTransport = createSanctuaryTelegramAuthorityTransport(client, {
    expectedTargetHost: config.targetHost, expectedBotId: credentials.botId, expectedOwnerUserId: credentials.authorizedUserId,
    expectedOwnerChatId: credentials.authorizedChatId, expectedKeyId: config.keyId, expectedPublicKeyDigest: config.publicKeyDigest, publicKey,
  })
  async function cursorSnapshot(at?: number): Promise<SanctuaryTelegramCursorSnapshot> {
    const snapshot = verifyAuthorityPayload<SanctuaryTelegramCursorSnapshot>({
      artifact: await client.request("telegram.cursor.snapshot", {}), expectedDomain: "ouro.sanctuary.telegram-cursor.v1", expectedKeyId: config.keyId as string, publicKey,
    })
    const now = at ?? Date.now()
    if (!snapshot || Object.keys(snapshot).sort().join(",") !== "botId,cursor,keyId,observedAt,ownerChatId,ownerUserId,pendingUpdateIds,progressDigest,publicKeyDigest,targetHost"
      || !["targetHost", "botId", "ownerUserId", "ownerChatId", "keyId", "publicKeyDigest"].every((key) => snapshot[key as keyof SanctuaryTelegramCursorSnapshot] === config[key])
      || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0
      || !Array.isArray(snapshot.pendingUpdateIds) || !snapshot.pendingUpdateIds.every((id, index, ids) => Number.isSafeInteger(id) && id >= snapshot.cursor && (index === 0 || id > ids[index - 1]!))
      || typeof snapshot.progressDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(snapshot.progressDigest)
      || typeof snapshot.observedAt !== "string" || !Number.isFinite(Date.parse(snapshot.observedAt)) || new Date(snapshot.observedAt).toISOString() !== snapshot.observedAt
      || Date.parse(snapshot.observedAt) > now + 1000 || now - Date.parse(snapshot.observedAt) > 30_000) throw new Error("Sanctuary authority cursor snapshot is invalid or stale")
    return snapshot
  }
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_authority_pins_loaded", message: "Sanctuary resident authority pins loaded", meta: { keyId: config.keyId } })
  return { credentials, authorityTransport, cursorSnapshot }
}
